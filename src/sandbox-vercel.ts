import { posix } from "node:path";
import { Writable } from "node:stream";
import { Sandbox as VercelSandbox } from "@vercel/sandbox";
import type { NetworkPolicy } from "@vercel/sandbox";
import { ConfigurationError } from "./errors.js";
import { sandboxCapabilities } from "./sandbox.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateContext,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
  SandboxOperationOptions,
  SandboxOutputEvent,
  SandboxProcessInstance,
} from "./sandbox.js";

const MAX_VERCEL_PORTS = 4;

interface VercelSandboxCommonOptions {
  readonly image?: string;
  /** @deprecated Prefer a Vercel Sandbox image. */
  readonly runtime?: string;
  readonly resources?: { readonly vcpus: number };
  readonly networkPolicy?: NetworkPolicy;
  readonly tags?: Readonly<Record<string, string>>;
  readonly name?: string | ((context: SandboxCreateContext) => string);
}

type ExplicitVercelCredentials = {
  readonly token: string;
  readonly teamId: string;
  readonly projectId: string;
};

type AutomaticVercelCredentials = {
  readonly token?: never;
  readonly teamId?: never;
  readonly projectId?: never;
};

export type VercelSandboxAdapterOptions = VercelSandboxCommonOptions
  & (ExplicitVercelCredentials | AutomaticVercelCredentials);

export interface VercelSandboxFactoryInput {
  readonly name?: string;
  readonly image?: string;
  readonly runtime?: string;
  readonly resources?: { vcpus: number };
  readonly networkPolicy?: NetworkPolicy;
  readonly tags?: Record<string, string>;
  readonly token?: string;
  readonly teamId?: string;
  readonly projectId?: string;
  readonly ports: number[];
  readonly timeout: number;
  readonly env: Record<string, string>;
  readonly persistent: false;
  readonly signal?: AbortSignal;
}

export interface VercelSandboxClient {
  readonly name: string;
  readonly cwd: string;
  writeFiles(
    files: { path: string; content: string | Uint8Array }[],
    options?: { signal?: AbortSignal },
  ): Promise<void>;
  readFileToBuffer(
    file: { path: string },
    options?: { signal?: AbortSignal },
  ): Promise<Buffer | null>;
  runCommand(input: VercelCommandInput): Promise<VercelCommandResult | VercelCommandHandle>;
  domain(port: number): string;
  stop(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface VercelCommandInput {
    cmd: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    detached?: boolean;
    signal?: AbortSignal;
    stdout?: Writable;
    stderr?: Writable;
}

export interface VercelCommandResult {
  readonly exitCode: number;
  readonly durationMs?: number;
  stdout(options?: { signal?: AbortSignal }): Promise<string>;
  stderr(options?: { signal?: AbortSignal }): Promise<string>;
}

export interface VercelCommandHandle {
  readonly cmdId: string;
  wait(options?: { signal?: AbortSignal }): Promise<VercelCommandResult>;
  kill(signal?: string, options?: { abortSignal?: AbortSignal }): Promise<void>;
  stdout(options?: { signal?: AbortSignal }): Promise<string>;
  stderr(options?: { signal?: AbortSignal }): Promise<string>;
}

export type VercelSandboxFactory = (
  input: VercelSandboxFactoryInput,
) => Promise<VercelSandboxClient>;

export function vercelSandbox(
  options: VercelSandboxAdapterOptions = {},
  factory: VercelSandboxFactory = createVercelSandbox,
): SandboxAdapter {
  validateOptions(options);
  return {
    provider: "vercel",
    capabilities: sandboxCapabilities({
      files: true,
      commands: true,
      commandStreaming: true,
      portUrls: true,
      backgroundProcesses: true,
    }),
    async create(input) {
      if (input.ports.length > MAX_VERCEL_PORTS) {
        throw new ConfigurationError(
          `Vercel Sandbox supports at most ${MAX_VERCEL_PORTS} exposed ports.`,
        );
      }
      const name = typeof options.name === "function"
        ? options.name(input.context)
        : options.name;
      const client = await factory({
        ports: [...input.ports],
        timeout: input.timeoutMs,
        env: { ...input.env },
        persistent: false,
        ...(name ? { name } : {}),
        ...(options.image ? { image: options.image } : {}),
        ...(options.runtime ? { runtime: options.runtime } : {}),
        ...(options.resources ? { resources: { ...options.resources } } : {}),
        ...(options.networkPolicy ? { networkPolicy: options.networkPolicy } : {}),
        ...(options.tags ? { tags: { ...options.tags } } : {}),
        ...(options.token ? {
          token: options.token,
          teamId: options.teamId,
          projectId: options.projectId,
        } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      });
      return new VercelSandboxInstance(client);
    },
  };
}

class VercelSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly #client: VercelSandboxClient;

  constructor(client: VercelSandboxClient) {
    this.#client = client;
    this.id = client.name;
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    await this.#client.writeFiles(
      files.map((file) => ({
        path: projectPath(this.#client.cwd, file.path),
        content: file.content,
      })),
      signalOptions(options.signal),
    );
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const startedAt = performance.now();
    const cwd = command.cwd ?? ".";
    const streams = command.onOutput ? outputStreams(command.onOutput) : {};
    const result = await this.#client.runCommand({
      cmd: command.command,
      args: [...(command.args ?? [])],
      cwd: cwd === "." ? this.#client.cwd : projectPath(this.#client.cwd, cwd),
      env: { ...(command.env ?? {}) },
      timeoutMs: command.timeoutMs ?? 300_000,
      ...(command.signal ? { signal: command.signal } : {}),
      ...streams,
    });
    if (isVercelCommandHandle(result)) {
      throw new Error("Vercel returned a detached command for a blocking run.");
    }
    const outputOptions = signalOptions(command.signal);
    const [stdout, stderr] = await Promise.all([
      result.stdout(outputOptions),
      result.stderr(outputOptions),
    ]);
    return {
      exitCode: result.exitCode,
      stdout,
      stderr,
      durationMs: result.durationMs ?? Math.max(0, performance.now() - startedAt),
    };
  }

  async start(command: SandboxCommand): Promise<SandboxProcessInstance> {
    const startedAt = performance.now();
    const cwd = command.cwd ?? ".";
    const streams = command.onOutput ? outputStreams(command.onOutput) : {};
    const handle = await this.#client.runCommand({
      cmd: command.command,
      args: [...(command.args ?? [])],
      cwd: cwd === "." ? this.#client.cwd : projectPath(this.#client.cwd, cwd),
      env: { ...(command.env ?? {}) },
      timeoutMs: command.timeoutMs ?? 300_000,
      detached: true,
      ...(command.signal ? { signal: command.signal } : {}),
      ...streams,
    });
    if (!isVercelCommandHandle(handle)) {
      throw new Error("Vercel did not return a detached command handle.");
    }
    return {
      id: handle.cmdId,
      async wait(options = {}) {
        const result = await handle.wait(signalOptions(options.signal));
        const outputOptions = signalOptions(options.signal);
        const [stdout, stderr] = await Promise.all([
          result.stdout(outputOptions),
          result.stderr(outputOptions),
        ]);
        return {
          exitCode: result.exitCode,
          stdout,
          stderr,
          durationMs: result.durationMs ?? Math.max(0, performance.now() - startedAt),
        };
      },
      async kill(options = {}) {
        await handle.kill("SIGTERM", options.signal ? { abortSignal: options.signal } : {});
      },
    };
  }

  async readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    const content = await this.#client.readFileToBuffer(
      { path: projectPath(this.#client.cwd, path) },
      signalOptions(options.signal),
    );
    if (!content) throw new Error(`Sandbox file was not found: ${path}`);
    return content;
  }

  getUrl(port: number): string {
    return this.#client.domain(port);
  }

  async stop(options: SandboxOperationOptions = {}): Promise<void> {
    await this.#client.stop(signalOptions(options.signal));
  }
}

async function createVercelSandbox(
  input: VercelSandboxFactoryInput,
): Promise<VercelSandboxClient> {
  return VercelSandbox.create(
    input as Parameters<typeof VercelSandbox.create>[0],
  ) as unknown as Promise<VercelSandboxClient>;
}

function isVercelCommandHandle(
  value: VercelCommandResult | VercelCommandHandle,
): value is VercelCommandHandle {
  return "cmdId" in value && typeof value.wait === "function" && typeof value.kill === "function";
}

function outputStreams(
  onOutput: (event: SandboxOutputEvent) => void | Promise<void>,
): { stdout: Writable; stderr: Writable } {
  return {
    stdout: outputStream("stdout", onOutput),
    stderr: outputStream("stderr", onOutput),
  };
}

function outputStream(
  stream: SandboxOutputEvent["stream"],
  onOutput: (event: SandboxOutputEvent) => void | Promise<void>,
): Writable {
  return new Writable({
    write(chunk, _encoding, callback) {
      Promise.resolve(onOutput({ stream, data: Buffer.from(chunk).toString("utf8") }))
        .then(() => callback(), callback);
    },
  });
}

function projectPath(root: string, path: string): string {
  return posix.join(root, path);
}

function validateOptions(options: VercelSandboxAdapterOptions): void {
  if (options.image && options.runtime) {
    throw new ConfigurationError("Vercel Sandbox accepts either image or runtime, not both.");
  }
  const credentials = [options.token, options.teamId, options.projectId];
  if (credentials.some(Boolean) && !credentials.every(Boolean)) {
    throw new ConfigurationError(
      "Explicit Vercel Sandbox authentication requires token, teamId, and projectId together.",
    );
  }
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}
