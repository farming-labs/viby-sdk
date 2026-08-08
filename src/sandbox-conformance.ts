import { ConfigurationError } from "./errors.js";
import {
  SandboxSession,
  sandboxCapabilities,
  type SandboxAdapter,
  type SandboxCommand,
  type SandboxCommandResult,
  type SandboxCreateInput,
  type SandboxOutputEvent,
} from "./sandbox.js";

const DEFAULT_TEXT_PATH = ".viby/conformance.txt";
const DEFAULT_BINARY_PATH = ".viby/conformance.bin";

export interface SandboxConformanceInput {
  readonly adapter: SandboxAdapter;
  readonly create: SandboxCreateInput;
  /** A harmless command appropriate for the adapter image and runtime. */
  readonly command: Omit<SandboxCommand, "onOutput">;
  /** A declared port to resolve when `portUrls` is enabled. */
  readonly port?: number;
  readonly textPath?: string;
  readonly binaryPath?: string;
  readonly validateCommand?: (
    result: SandboxCommandResult,
    events: readonly SandboxOutputEvent[],
  ) => void | Promise<void>;
}

export interface SandboxConformanceReport {
  readonly provider: string;
  readonly sandboxId: string;
  readonly checks: readonly SandboxConformanceCheck[];
}

export type SandboxConformanceCheck =
  | "capabilities"
  | "create"
  | "text-file-roundtrip"
  | "binary-file-roundtrip"
  | "command"
  | "command-streaming"
  | "port-url"
  | "idempotent-stop";

/**
 * Runs the portable behavioral contract against an adapter. Provider credentials,
 * images, commands, and ports stay in the caller-owned fixture.
 */
export async function verifySandboxAdapter(
  input: SandboxConformanceInput,
): Promise<SandboxConformanceReport> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Sandbox conformance input is required.");
  }
  const capabilities = sandboxCapabilities(input.adapter?.capabilities);
  if (!capabilities.files || !capabilities.commands) {
    throw new ConfigurationError(
      "A conforming Viby sandbox adapter must support files and commands.",
    );
  }
  if (!input.command || typeof input.command !== "object") {
    throw new ConfigurationError("Sandbox conformance requires a harmless command probe.");
  }
  if (capabilities.portUrls && input.port === undefined) {
    throw new ConfigurationError(
      "Sandbox conformance requires a declared port when portUrls is supported.",
    );
  }

  const checks: SandboxConformanceCheck[] = ["capabilities"];
  const instance = await input.adapter.create(input.create);
  const session = new SandboxSession(input.adapter.provider, capabilities, instance);
  checks.push("create");

  try {
    const textPath = input.textPath ?? DEFAULT_TEXT_PATH;
    const binaryPath = input.binaryPath ?? DEFAULT_BINARY_PATH;
    const text = "viby sandbox conformance\n";
    const binary = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);

    await session.writeFiles([
      { path: textPath, content: text },
      { path: binaryPath, content: binary },
    ]);
    assertBytesEqual(await session.readFile(textPath), new TextEncoder().encode(text), textPath);
    checks.push("text-file-roundtrip");
    assertBytesEqual(await session.readFile(binaryPath), binary, binaryPath);
    checks.push("binary-file-roundtrip");

    const events: SandboxOutputEvent[] = [];
    const result = await session.run({
      ...input.command,
      onOutput: (event) => {
        events.push(event);
      },
    });
    checks.push("command");
    await input.validateCommand?.(result, events);
    if (capabilities.commandStreaming) checks.push("command-streaming");

    if (capabilities.portUrls) {
      const url = await session.url(input.port!);
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw new SandboxConformanceError(`Adapter returned a non-HTTP port URL: ${url}`);
      }
      checks.push("port-url");
    }

    await session.stop();
    await session.stop();
    checks.push("idempotent-stop");
    return Object.freeze({
      provider: session.provider,
      sandboxId: session.id,
      checks: Object.freeze([...checks]),
    });
  } finally {
    await session.stop().catch(() => undefined);
  }
}

export class SandboxConformanceError extends Error {
  override readonly name = "SandboxConformanceError";
}

function assertBytesEqual(actual: Uint8Array, expected: Uint8Array, path: string): void {
  if (
    actual.length !== expected.length
    || actual.some((value, index) => value !== expected[index])
  ) {
    throw new SandboxConformanceError(`Sandbox file roundtrip changed bytes for ${path}.`);
  }
}
