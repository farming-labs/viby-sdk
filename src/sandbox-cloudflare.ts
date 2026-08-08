import { posix } from "node:path";
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
} from "./sandbox.js";

const DEFAULT_ROOT = "/workspace";

export type CloudflarePreviewOptions = "tunnel" | {
  readonly hostname: string;
  readonly name?: string;
  readonly token?: string;
};

export interface CloudflareSandboxAdapterOptions<Binding extends object = object> {
  readonly binding: Binding;
  readonly id?: string | ((context: SandboxCreateContext) => string);
  readonly preview?: CloudflarePreviewOptions;
  readonly sleepAfter?: string | number;
  readonly keepAlive?: boolean;
  readonly transport?: "http" | "websocket" | "rpc";
  readonly labels?: Readonly<Record<string, string>>;
  readonly containerTimeouts?: {
    readonly instanceGetTimeoutMS?: number;
    readonly portReadyTimeoutMS?: number;
    readonly waitIntervalMS?: number;
  };
}

export interface CloudflareSandboxFactoryInput<Binding extends object = object> {
  readonly binding: Binding;
  readonly id: string;
  readonly options: {
    readonly sleepAfter: string | number;
    readonly keepAlive: boolean;
    readonly enableDefaultSession: false;
    readonly normalizeId: true;
    readonly transport: "http" | "websocket" | "rpc";
    readonly labels?: Record<string, string>;
    readonly containerTimeouts?: {
      readonly instanceGetTimeoutMS?: number;
      readonly portReadyTimeoutMS?: number;
      readonly waitIntervalMS?: number;
    };
  };
}

export interface CloudflareExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly duration: number;
}

export interface CloudflareSandboxClient {
  exec(command: string, options: {
    readonly cwd: string;
    readonly env: Record<string, string>;
    readonly timeout: number;
    readonly stream: boolean;
    readonly signal?: AbortSignal;
    readonly onOutput?: (stream: "stdout" | "stderr", data: string) => void;
  }): Promise<CloudflareExecResult>;
  mkdir(path: string, options?: { recursive?: boolean }): Promise<{ success: boolean }>;
  writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
  ): Promise<{ success: boolean }>;
  readFile(
    path: string,
    options: { encoding: "base64" },
  ): Promise<{ success: boolean; content: string }>;
  exposePort(port: number, options: {
    hostname: string;
    name?: string;
    token?: string;
  }): Promise<{ url: string }>;
  readonly tunnels: {
    get(port: number): Promise<{ url: string }>;
  };
  destroy(): Promise<void>;
}

export type CloudflareSandboxFactory<Binding extends object = object> = (
  input: CloudflareSandboxFactoryInput<Binding>,
) => Promise<CloudflareSandboxClient>;

export function cloudflareSandbox<Binding extends object>(
  options: CloudflareSandboxAdapterOptions<Binding>,
  factory: CloudflareSandboxFactory<Binding> = (
    createCloudflareSandbox as CloudflareSandboxFactory<Binding>
  ),
): SandboxAdapter {
  const normalized = normalizeOptions(options);
  return {
    provider: "cloudflare",
    async create(input) {
      const id = typeof normalized.id === "function"
        ? sandboxId(normalized.id(input.context))
        : normalized.id ?? `viby-${crypto.randomUUID()}`;
      if (input.ports.includes(3_000)) {
        throw new ConfigurationError(
          "Cloudflare Sandbox reserves port 3000 for its internal control server.",
        );
      }
      if (normalized.preview !== "tunnel" && input.ports.some((port) => port < 1_024)) {
        throw new ConfigurationError(
          "Cloudflare hostname previews support ports between 1024 and 65535.",
        );
      }
      const client = await factory({
        binding: normalized.binding,
        id,
        options: {
          sleepAfter: normalized.sleepAfter ?? Math.max(1, Math.ceil(input.timeoutMs / 1_000)),
          keepAlive: normalized.keepAlive,
          enableDefaultSession: false,
          normalizeId: true,
          transport: normalized.transport,
          ...(normalized.labels ? { labels: { ...normalized.labels } } : {}),
          ...(normalized.containerTimeouts
            ? { containerTimeouts: { ...normalized.containerTimeouts } }
            : {}),
        },
      });
      try {
        const result = await abortable(
          client.mkdir(DEFAULT_ROOT, { recursive: true }),
          input.signal,
          () => client.destroy(),
        );
        if (!result.success) throw new Error("Cloudflare could not create the project workspace.");
        return new CloudflareSandboxInstance(
          id,
          client,
          input.ports,
          normalized.preview,
        );
      } catch (error) {
        await client.destroy().catch(() => {});
        throw error;
      }
    },
  };
}

class CloudflareSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly #client: CloudflareSandboxClient;
  readonly #ports: ReadonlySet<number>;
  readonly #preview: CloudflarePreviewOptions;

  constructor(
    id: string,
    client: CloudflareSandboxClient,
    ports: readonly number[],
    preview: CloudflarePreviewOptions,
  ) {
    this.id = id;
    this.#client = client;
    this.#ports = new Set(ports);
    this.#preview = preview;
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    for (const file of files) {
      const content = typeof file.content === "string"
        ? file.content
        : bytesStream(file.content);
      const result = await abortable(
        this.#client.writeFile(projectPath(file.path), content),
        options.signal,
        () => this.#client.destroy(),
      );
      if (!result.success) throw new Error(`Cloudflare could not write ${file.path}.`);
    }
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const callbacks: Promise<void>[] = [];
    const callbackErrors: unknown[] = [];
    const result = await this.#client.exec(
      renderShellCommand(command.command, command.args ?? []),
      {
        cwd: command.cwd === undefined || command.cwd === "."
          ? DEFAULT_ROOT
          : projectPath(command.cwd),
        env: { ...(command.env ?? {}) },
        timeout: command.timeoutMs ?? 300_000,
        stream: command.onOutput !== undefined,
        ...(command.signal ? { signal: command.signal } : {}),
        ...(command.onOutput ? {
          onOutput: (stream, data) => {
            queueCallback(
              callbacks,
              callbackErrors,
              () => command.onOutput!({ stream, data }),
            );
          },
        } : {}),
      },
    );
    await Promise.all(callbacks);
    if (callbackErrors.length > 0) throw callbackErrors[0];
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.duration,
    };
  }

  async readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    const result = await abortable(
      this.#client.readFile(projectPath(path), { encoding: "base64" }),
      options.signal,
      () => this.#client.destroy(),
    );
    if (!result.success) throw new Error(`Cloudflare could not read ${path}.`);
    return decodeBase64(result.content);
  }

  async getUrl(port: number): Promise<string> {
    if (!this.#ports.has(port)) {
      throw new ConfigurationError(
        `Cloudflare port ${port} was not declared when the sandbox was created.`,
      );
    }
    if (this.#preview === "tunnel") {
      return (await this.#client.tunnels.get(port)).url;
    }
    return (await this.#client.exposePort(port, {
      hostname: this.#preview.hostname,
      ...(this.#preview.name ? { name: this.#preview.name } : {}),
      ...(this.#preview.token ? { token: this.#preview.token } : {}),
    })).url;
  }

  async stop(options: SandboxOperationOptions = {}): Promise<void> {
    await abortable(this.#client.destroy(), options.signal);
  }
}

async function createCloudflareSandbox(
  input: CloudflareSandboxFactoryInput<object>,
): Promise<CloudflareSandboxClient> {
  const { getSandbox } = await import("@cloudflare/sandbox");
  return getSandbox(input.binding as never, input.id, input.options) as unknown as CloudflareSandboxClient;
}

interface NormalizedCloudflareOptions<Binding extends object> {
  readonly binding: Binding;
  readonly id?: string | ((context: SandboxCreateContext) => string);
  readonly preview: CloudflarePreviewOptions;
  readonly sleepAfter?: string | number;
  readonly keepAlive: boolean;
  readonly transport: "http" | "websocket" | "rpc";
  readonly labels?: Readonly<Record<string, string>>;
  readonly containerTimeouts?: {
    readonly instanceGetTimeoutMS?: number;
    readonly portReadyTimeoutMS?: number;
    readonly waitIntervalMS?: number;
  };
}

function normalizeOptions<Binding extends object>(
  options: CloudflareSandboxAdapterOptions<Binding>,
): NormalizedCloudflareOptions<Binding> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Cloudflare Sandbox options must be an object.");
  }
  if (!options.binding || typeof options.binding !== "object") {
    throw new ConfigurationError("Cloudflare Sandbox requires a Durable Object binding.");
  }
  const preview = normalizePreview(options.preview ?? "tunnel");
  const transport = options.transport ?? "rpc";
  if (preview === "tunnel" && transport !== "rpc") {
    throw new ConfigurationError("Cloudflare quick tunnels require the RPC transport.");
  }
  return {
    binding: options.binding,
    preview,
    keepAlive: options.keepAlive ?? false,
    transport,
    ...(options.id ? {
      id: typeof options.id === "function" ? options.id : sandboxId(options.id),
    } : {}),
    ...(options.sleepAfter !== undefined
      ? { sleepAfter: normalizeSleepAfter(options.sleepAfter) }
      : {}),
    ...(options.labels ? { labels: { ...options.labels } } : {}),
    ...(options.containerTimeouts ? {
      containerTimeouts: normalizeTimeouts(options.containerTimeouts),
    } : {}),
  };
}

function normalizePreview(preview: CloudflarePreviewOptions): CloudflarePreviewOptions {
  if (preview === "tunnel") return preview;
  if (!preview || typeof preview !== "object") {
    throw new ConfigurationError("Cloudflare preview options are invalid.");
  }
  const hostname = validString(preview.hostname, "Cloudflare preview hostname");
  if (hostname.includes("://") || hostname.includes("/") || hostname.includes(" ")) {
    throw new ConfigurationError("Cloudflare preview hostname must not include a URL scheme or path.");
  }
  if (preview.token && !/^[a-z0-9_]{1,16}$/.test(preview.token)) {
    throw new ConfigurationError(
      "Cloudflare preview token must contain 1-16 lowercase letters, numbers, or underscores.",
    );
  }
  return {
    hostname,
    ...(preview.name ? { name: validString(preview.name, "Cloudflare preview name") } : {}),
    ...(preview.token ? { token: preview.token } : {}),
  };
}

function normalizeSleepAfter(value: string | number): string | number {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0) {
      throw new ConfigurationError("Cloudflare sleepAfter must be a positive number.");
    }
    return value;
  }
  if (!/^\d+(?:s|m|h)$/.test(value)) {
    throw new ConfigurationError("Cloudflare sleepAfter must use a value such as 30s, 5m, or 1h.");
  }
  return value;
}

function normalizeTimeouts(
  values: NonNullable<CloudflareSandboxAdapterOptions["containerTimeouts"]>,
): NonNullable<NormalizedCloudflareOptions<object>["containerTimeouts"]> {
  return {
    ...(values.instanceGetTimeoutMS !== undefined
      ? { instanceGetTimeoutMS: positiveInteger(values.instanceGetTimeoutMS, "instance timeout") }
      : {}),
    ...(values.portReadyTimeoutMS !== undefined
      ? { portReadyTimeoutMS: positiveInteger(values.portReadyTimeoutMS, "port timeout") }
      : {}),
    ...(values.waitIntervalMS !== undefined
      ? { waitIntervalMS: positiveInteger(values.waitIntervalMS, "poll interval") }
      : {}),
  };
}

function sandboxId(value: string): string {
  const normalized = validString(value, "Cloudflare sandbox ID").toLowerCase();
  if (normalized.length > 128) {
    throw new ConfigurationError("Cloudflare sandbox ID must not exceed 128 characters.");
  }
  return normalized;
}

function projectPath(path: string): string {
  return posix.join(DEFAULT_ROOT, path);
}

function renderShellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShellArgument).join(" ");
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function bytesStream(content: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(content);
      controller.close();
    },
  });
}

function decodeBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) {
    bytes[index] = decoded.charCodeAt(index);
  }
  return bytes;
}

function queueCallback(
  callbacks: Promise<void>[],
  errors: unknown[],
  callback: () => void | Promise<void>,
): void {
  try {
    callbacks.push(Promise.resolve(callback()).catch((error) => {
      errors.push(error);
    }));
  } catch (error) {
    errors.push(error);
  }
}

function validString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || normalized.includes("\0")) {
    throw new ConfigurationError(`${label} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`Cloudflare ${label} must be a positive integer.`);
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
    return Promise.reject(new Error("Cloudflare operation was aborted."));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      runAbortCleanup(onAbort);
      reject(new Error("Cloudflare operation was aborted."));
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
