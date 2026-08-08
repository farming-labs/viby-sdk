import { posix } from "node:path";
import type { ModalClientParams, SandboxCreateParams } from "modal";
import { ConfigurationError } from "./errors.js";
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
} from "./sandbox.js";

const DEFAULT_APP_NAME = "viby";
const DEFAULT_IMAGE = "node:24-bookworm-slim";
const DEFAULT_ROOT = "/workspace";
const DEFAULT_TUNNEL_TIMEOUT_MS = 50_000;

interface ModalSandboxCommonOptions {
  readonly environment?: string;
  readonly endpoint?: string;
  readonly requestTimeoutMs?: number;
  readonly maxRetries?: number;
  readonly appName?: string;
  readonly image?: string;
  readonly imageSource?: "registry" | "modal";
  readonly secretNames?: readonly string[];
  readonly cpu?: number;
  readonly cpuLimit?: number;
  readonly memoryMiB?: number;
  readonly memoryLimitMiB?: number;
  readonly gpu?: string;
  readonly idleTimeoutMs?: number;
  readonly blockNetwork?: boolean;
  readonly outboundCidrAllowlist?: readonly string[];
  readonly outboundDomainAllowlist?: readonly string[];
  readonly inboundCidrAllowlist?: readonly string[];
  readonly cloud?: string;
  readonly regions?: readonly string[];
  readonly includeOidcIdentityToken?: boolean;
  readonly tags?: Readonly<Record<string, string>>;
  readonly name?: string | ((context: SandboxCreateContext) => string);
  readonly tunnelTimeoutMs?: number;
}

type ExplicitModalCredentials = {
  readonly tokenId: string;
  readonly tokenSecret: string;
};

type AutomaticModalCredentials = {
  readonly tokenId?: never;
  readonly tokenSecret?: never;
};

export type ModalSandboxAdapterOptions = ModalSandboxCommonOptions
  & (ExplicitModalCredentials | AutomaticModalCredentials);

export interface ModalSandboxFactoryInput {
  readonly client: ModalClientParams;
  readonly appName: string;
  readonly image: string;
  readonly imageSource: "registry" | "modal";
  readonly secretNames: readonly string[];
  readonly create: SandboxCreateParams;
  readonly signal?: AbortSignal;
}

export interface ModalProcessClient {
  readonly stdout: ReadableStream<string>;
  readonly stderr: ReadableStream<string>;
  wait(): Promise<number>;
}

export interface ModalTunnelClient {
  readonly url: string;
}

export interface ModalSandboxClient {
  readonly id: string;
  readonly filesystem: {
    makeDirectory(path: string, options?: { createParents?: boolean }): Promise<void>;
    writeBytes(content: Uint8Array, path: string): Promise<void>;
    readBytes(path: string): Promise<Uint8Array>;
  };
  exec(command: readonly string[], options: {
    workdir: string;
    timeoutMs: number;
    env: Record<string, string>;
  }): Promise<ModalProcessClient>;
  tunnels(timeoutMs?: number): Promise<Readonly<Record<number, ModalTunnelClient>>>;
  terminate(): Promise<void>;
  close(): void;
}

export type ModalSandboxFactory = (
  input: ModalSandboxFactoryInput,
) => Promise<ModalSandboxClient>;

export function modalSandbox(
  options: ModalSandboxAdapterOptions = {},
  factory: ModalSandboxFactory = createModalSandbox,
): SandboxAdapter {
  const normalized = normalizeOptions(options);
  return {
    provider: "modal",
    async create(input) {
      const name = typeof normalized.name === "function"
        ? validString(normalized.name(input.context), "Modal sandbox name")
        : normalized.name;
      const client = await factory({
        client: normalized.client,
        appName: normalized.appName,
        image: normalized.image,
        imageSource: normalized.imageSource,
        secretNames: normalized.secretNames,
        create: {
          timeoutMs: input.timeoutMs,
          workdir: DEFAULT_ROOT,
          env: { ...input.env },
          encryptedPorts: [...input.ports],
          ...(name ? { name } : {}),
          ...(normalized.cpu !== undefined ? { cpu: normalized.cpu } : {}),
          ...(normalized.cpuLimit !== undefined ? { cpuLimit: normalized.cpuLimit } : {}),
          ...(normalized.memoryMiB !== undefined ? { memoryMiB: normalized.memoryMiB } : {}),
          ...(normalized.memoryLimitMiB !== undefined
            ? { memoryLimitMiB: normalized.memoryLimitMiB }
            : {}),
          ...(normalized.gpu ? { gpu: normalized.gpu } : {}),
          ...(normalized.idleTimeoutMs !== undefined
            ? { idleTimeoutMs: normalized.idleTimeoutMs }
            : {}),
          ...(normalized.blockNetwork !== undefined
            ? { blockNetwork: normalized.blockNetwork }
            : {}),
          ...(normalized.outboundCidrAllowlist
            ? { outboundCidrAllowlist: [...normalized.outboundCidrAllowlist] }
            : {}),
          ...(normalized.outboundDomainAllowlist
            ? { outboundDomainAllowlist: [...normalized.outboundDomainAllowlist] }
            : {}),
          ...(normalized.inboundCidrAllowlist
            ? { inboundCidrAllowlist: [...normalized.inboundCidrAllowlist] }
            : {}),
          ...(normalized.cloud ? { cloud: normalized.cloud } : {}),
          ...(normalized.regions ? { regions: [...normalized.regions] } : {}),
          ...(normalized.includeOidcIdentityToken !== undefined
            ? { includeOidcIdentityToken: normalized.includeOidcIdentityToken }
            : {}),
          ...(normalized.tags ? { tags: { ...normalized.tags } } : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      try {
        await abortable(
          client.filesystem.makeDirectory(DEFAULT_ROOT, { createParents: true }),
          input.signal,
          () => client.terminate(),
        );
        return new ModalSandboxInstance(client, input.ports, normalized.tunnelTimeoutMs);
      } catch (error) {
        await client.terminate().catch(() => {});
        client.close();
        throw error;
      }
    },
  };
}

class ModalSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly #client: ModalSandboxClient;
  readonly #ports: ReadonlySet<number>;
  readonly #tunnelTimeoutMs: number;

  constructor(
    client: ModalSandboxClient,
    ports: readonly number[],
    tunnelTimeoutMs: number,
  ) {
    this.id = client.id;
    this.#client = client;
    this.#ports = new Set(ports);
    this.#tunnelTimeoutMs = tunnelTimeoutMs;
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    for (const file of files) {
      const content = typeof file.content === "string"
        ? Buffer.from(file.content)
        : file.content;
      await abortable(
        this.#client.filesystem.writeBytes(content, projectPath(file.path)),
        options.signal,
        () => this.#client.terminate(),
      );
    }
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const startedAt = performance.now();
    const cwd = command.cwd === undefined || command.cwd === "."
      ? DEFAULT_ROOT
      : projectPath(command.cwd);
    const process = await abortable(
      this.#client.exec([command.command, ...(command.args ?? [])], {
        workdir: cwd,
        timeoutMs: command.timeoutMs ?? 300_000,
        env: { ...(command.env ?? {}) },
      }),
      command.signal,
      () => this.#client.terminate(),
    );
    const stdout = consumeStream(process.stdout, "stdout", command.onOutput, command.signal);
    const stderr = consumeStream(process.stderr, "stderr", command.onOutput, command.signal);
    const [exitCode, stdoutText, stderrText] = await Promise.all([
      abortable(
        process.wait(),
        command.signal,
        () => this.#client.terminate(),
      ),
      stdout,
      stderr,
    ]);
    return {
      exitCode,
      stdout: stdoutText,
      stderr: stderrText,
      durationMs: Math.max(0, performance.now() - startedAt),
    };
  }

  readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    return abortable(
      this.#client.filesystem.readBytes(projectPath(path)),
      options.signal,
      () => this.#client.terminate(),
    );
  }

  async getUrl(port: number): Promise<string> {
    if (!this.#ports.has(port)) {
      throw new ConfigurationError(
        `Modal port ${port} was not declared when the sandbox was created.`,
      );
    }
    const tunnels = await this.#client.tunnels(this.#tunnelTimeoutMs);
    const tunnel = tunnels[port];
    if (!tunnel) throw new Error(`Modal did not return a tunnel for port ${port}.`);
    return tunnel.url;
  }

  async stop(options: SandboxOperationOptions = {}): Promise<void> {
    try {
      await abortable(this.#client.terminate(), options.signal);
    } finally {
      this.#client.close();
    }
  }
}

async function createModalSandbox(
  input: ModalSandboxFactoryInput,
): Promise<ModalSandboxClient> {
  const nodeMajor = Number.parseInt(process.versions.node.split(".", 1)[0]!, 10);
  if (nodeMajor < 22) {
    throw new ConfigurationError("The Modal sandbox adapter requires Node.js 22 or newer.");
  }
  const { ModalClient } = await import("modal");
  const modal = new ModalClient(input.client);
  let cleanupOwnsClient = false;
  try {
    const app = await abortable(
      modal.apps.fromName(input.appName, {
        createIfMissing: true,
        ...(input.client.environment ? { environment: input.client.environment } : {}),
      }),
      input.signal,
    );
    const image = input.imageSource === "modal"
      ? await abortable(
          modal.images.fromName(input.image, {
            ...(input.client.environment ? { environment: input.client.environment } : {}),
          }),
          input.signal,
        )
      : modal.images.fromRegistry(input.image);
    const secrets = await abortable(
      Promise.all(input.secretNames.map((name) => modal.secrets.fromName(name, {
        ...(input.client.environment ? { environment: input.client.environment } : {}),
      }))),
      input.signal,
    );
    const creation = modal.sandboxes.create(app, image, {
      ...input.create,
      ...(secrets.length > 0 ? { secrets } : {}),
    });
    const sandbox = await abortable(
      creation,
      input.signal,
      () => {
        cleanupOwnsClient = true;
        return creation
          .then((value) => value.terminate())
          .finally(() => modal.close());
      },
    );
    return {
      id: sandbox.sandboxId,
      filesystem: sandbox.filesystem,
      exec: (command, options) => sandbox.exec([...command], options),
      tunnels: (timeoutMs) => sandbox.tunnels(timeoutMs),
      terminate: () => sandbox.terminate(),
      close: () => modal.close(),
    };
  } catch (error) {
    if (!cleanupOwnsClient) modal.close();
    throw error;
  }
}

interface NormalizedModalOptions {
  readonly client: ModalClientParams;
  readonly appName: string;
  readonly image: string;
  readonly imageSource: "registry" | "modal";
  readonly secretNames: readonly string[];
  readonly cpu?: number;
  readonly cpuLimit?: number;
  readonly memoryMiB?: number;
  readonly memoryLimitMiB?: number;
  readonly gpu?: string;
  readonly idleTimeoutMs?: number;
  readonly blockNetwork?: boolean;
  readonly outboundCidrAllowlist?: readonly string[];
  readonly outboundDomainAllowlist?: readonly string[];
  readonly inboundCidrAllowlist?: readonly string[];
  readonly cloud?: string;
  readonly regions?: readonly string[];
  readonly includeOidcIdentityToken?: boolean;
  readonly tags?: Readonly<Record<string, string>>;
  readonly name?: string | ((context: SandboxCreateContext) => string);
  readonly tunnelTimeoutMs: number;
}

function normalizeOptions(options: ModalSandboxAdapterOptions): NormalizedModalOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Modal sandbox options must be an object.");
  }
  const raw = options as ModalSandboxCommonOptions & {
    tokenId?: string;
    tokenSecret?: string;
  };
  const credentials = [raw.tokenId, raw.tokenSecret];
  if (credentials.some((value) => value !== undefined) && !credentials.every(Boolean)) {
    throw new ConfigurationError(
      "Explicit Modal authentication requires tokenId and tokenSecret together.",
    );
  }
  if (raw.blockNetwork && (
    raw.outboundCidrAllowlist
    || raw.outboundDomainAllowlist
    || raw.inboundCidrAllowlist
  )) {
    throw new ConfigurationError(
      "Modal blockNetwork cannot be combined with network allowlists.",
    );
  }
  const client: ModalClientParams = {
    ...(raw.tokenId ? {
      tokenId: validString(raw.tokenId, "Modal token ID"),
      tokenSecret: validString(raw.tokenSecret!, "Modal token secret"),
    } : {}),
    ...(raw.environment ? { environment: validString(raw.environment, "Modal environment") } : {}),
    ...(raw.endpoint ? { endpoint: validString(raw.endpoint, "Modal endpoint") } : {}),
    ...(raw.requestTimeoutMs !== undefined
      ? { timeoutMs: positiveInteger(raw.requestTimeoutMs, "Modal request timeout") }
      : {}),
    ...(raw.maxRetries !== undefined
      ? { maxRetries: boundedInteger(raw.maxRetries, 0, 20, "Modal maximum retries") }
      : {}),
  };
  return {
    client,
    appName: validString(raw.appName ?? DEFAULT_APP_NAME, "Modal app name"),
    image: validString(raw.image ?? DEFAULT_IMAGE, "Modal image"),
    imageSource: raw.imageSource ?? "registry",
    secretNames: normalizeStrings(raw.secretNames ?? [], "Modal secret name"),
    tunnelTimeoutMs: positiveInteger(
      raw.tunnelTimeoutMs ?? DEFAULT_TUNNEL_TIMEOUT_MS,
      "Modal tunnel timeout",
    ),
    ...(raw.cpu !== undefined ? { cpu: positiveNumber(raw.cpu, "Modal CPU") } : {}),
    ...(raw.cpuLimit !== undefined
      ? { cpuLimit: positiveNumber(raw.cpuLimit, "Modal CPU limit") }
      : {}),
    ...(raw.memoryMiB !== undefined
      ? { memoryMiB: positiveInteger(raw.memoryMiB, "Modal memory") }
      : {}),
    ...(raw.memoryLimitMiB !== undefined
      ? { memoryLimitMiB: positiveInteger(raw.memoryLimitMiB, "Modal memory limit") }
      : {}),
    ...(raw.gpu ? { gpu: validString(raw.gpu, "Modal GPU") } : {}),
    ...(raw.idleTimeoutMs !== undefined
      ? { idleTimeoutMs: positiveInteger(raw.idleTimeoutMs, "Modal idle timeout") }
      : {}),
    ...(raw.blockNetwork !== undefined ? { blockNetwork: raw.blockNetwork } : {}),
    ...(raw.outboundCidrAllowlist
      ? { outboundCidrAllowlist: normalizeStrings(raw.outboundCidrAllowlist, "Modal CIDR") }
      : {}),
    ...(raw.outboundDomainAllowlist
      ? { outboundDomainAllowlist: normalizeStrings(raw.outboundDomainAllowlist, "Modal domain") }
      : {}),
    ...(raw.inboundCidrAllowlist
      ? { inboundCidrAllowlist: normalizeStrings(raw.inboundCidrAllowlist, "Modal inbound CIDR") }
      : {}),
    ...(raw.cloud ? { cloud: validString(raw.cloud, "Modal cloud") } : {}),
    ...(raw.regions ? { regions: normalizeStrings(raw.regions, "Modal region") } : {}),
    ...(raw.includeOidcIdentityToken !== undefined
      ? { includeOidcIdentityToken: raw.includeOidcIdentityToken }
      : {}),
    ...(raw.tags ? { tags: { ...raw.tags } } : {}),
    ...(raw.name ? { name: raw.name } : {}),
  };
}

async function consumeStream(
  stream: ReadableStream<string>,
  name: SandboxOutputEvent["stream"],
  onOutput: SandboxCommand["onOutput"],
  signal: AbortSignal | undefined,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: string[] = [];
  const abort = () => {
    void reader.cancel("Modal command was aborted.").catch(() => {});
  };
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      chunks.push(result.value);
      await onOutput?.({ stream: name, data: result.value });
    }
    return chunks.join("");
  } finally {
    signal?.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

function projectPath(path: string): string {
  return posix.join(DEFAULT_ROOT, path);
}

function validString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || normalized.includes("\0")) {
    throw new ConfigurationError(`${label} is invalid.`);
  }
  return normalized;
}

function normalizeStrings(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > 256) {
    throw new ConfigurationError(`${label} values are invalid.`);
  }
  return values.map((value) => validString(value, label));
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${label} must be a positive integer.`);
  }
  return value;
}

function positiveNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new ConfigurationError(`${label} must be positive.`);
  }
  return value;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function abortable<T>(
  promise: Promise<T>,
  signal: AbortSignal | undefined,
  onAbort?: () => void | Promise<unknown>,
): Promise<T> {
  if (!signal) return promise;
  if (signal.aborted) {
    runAbortCleanup(onAbort);
    return Promise.reject(new Error("Modal operation was aborted."));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      runAbortCleanup(onAbort);
      reject(new Error("Modal operation was aborted."));
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", abort);
        reject(error);
      },
    );
  });
}

function runAbortCleanup(onAbort: (() => void | Promise<unknown>) | undefined): void {
  if (!onAbort) return;
  try {
    void Promise.resolve(onAbort()).catch(() => {});
  } catch {
    // Cancellation cleanup is best effort; preserve the abort error.
  }
}
