import { posix } from "node:path";
import { Sandbox as E2BSandbox } from "e2b";
import { sandboxCapabilities } from "./sandbox.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
  SandboxOperationOptions,
  SandboxProcessInstance,
} from "./sandbox.js";

const DEFAULT_ROOT = "/home/user/viby";

export interface E2BSandboxAdapterOptions {
  readonly apiKey?: string;
  readonly template?: string;
  readonly domain?: string;
  readonly requestTimeoutMs?: number;
  readonly secure?: boolean;
  readonly metadata?: Readonly<Record<string, string>>;
}

export interface E2BSandboxFactoryInput {
  readonly template?: string;
  readonly options: {
    readonly apiKey?: string;
    readonly domain?: string;
    readonly requestTimeoutMs?: number;
    readonly secure?: boolean;
    readonly metadata?: Record<string, string>;
    readonly envs: Record<string, string>;
    readonly timeoutMs: number;
    readonly signal?: AbortSignal;
  };
}

export interface E2BSandboxClient {
  readonly sandboxId: string;
  readonly files: {
    write(
      files: { path: string; data: string | ArrayBuffer }[],
      options?: { signal?: AbortSignal },
    ): Promise<unknown>;
    read(
      path: string,
      options: { format: "bytes"; signal?: AbortSignal },
    ): Promise<Uint8Array>;
  };
  readonly commands: {
    run(command: string, options: {
      cwd: string;
      envs: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
      background?: boolean;
    }): Promise<E2BCommandResult | E2BCommandHandle>;
  };
  getHost(port: number): string;
  kill(options?: { signal?: AbortSignal }): Promise<unknown>;
}

export interface E2BCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string;
}

export interface E2BCommandHandle {
  readonly pid: number;
  wait(): Promise<E2BCommandResult>;
  kill(): Promise<boolean>;
}

export type E2BSandboxFactory = (
  input: E2BSandboxFactoryInput,
) => Promise<E2BSandboxClient>;

export function e2bSandbox(
  options: E2BSandboxAdapterOptions = {},
  factory: E2BSandboxFactory = createE2BSandbox,
): SandboxAdapter {
  return {
    provider: "e2b",
    capabilities: sandboxCapabilities({
      files: true,
      commands: true,
      commandStreaming: true,
      portUrls: true,
      backgroundProcesses: true,
    }),
    async create(input) {
      const client = await factory({
        ...(options.template ? { template: options.template } : {}),
        options: {
          envs: { ...input.env },
          timeoutMs: input.timeoutMs,
          ...(options.apiKey ? { apiKey: options.apiKey } : {}),
          ...(options.domain ? { domain: options.domain } : {}),
          ...(options.requestTimeoutMs !== undefined
            ? { requestTimeoutMs: options.requestTimeoutMs }
            : {}),
          ...(options.secure !== undefined ? { secure: options.secure } : {}),
          ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
          ...(input.signal ? { signal: input.signal } : {}),
        },
      });
      return new E2BSandboxInstance(client);
    },
  };
}

class E2BSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly #client: E2BSandboxClient;

  constructor(client: E2BSandboxClient) {
    this.#client = client;
    this.id = client.sandboxId;
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    await this.#client.files.write(
      files.map((file) => ({
        path: projectPath(file.path),
        data: typeof file.content === "string"
          ? file.content
          : copyArrayBuffer(file.content),
      })),
      signalOptions(options.signal),
    );
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const startedAt = performance.now();
    const cwd = command.cwd ?? ".";
    const options = {
      cwd: cwd === "." ? DEFAULT_ROOT : projectPath(cwd),
      envs: { ...(command.env ?? {}) },
      timeoutMs: command.timeoutMs ?? 300_000,
      ...(command.signal ? { signal: command.signal } : {}),
      ...(command.onOutput ? {
        onStdout: (data: string) => command.onOutput!({ stream: "stdout", data }),
        onStderr: (data: string) => command.onOutput!({ stream: "stderr", data }),
      } : {}),
    };
    try {
      const result = await this.#client.commands.run(
        renderShellCommand(command.command, command.args ?? []),
        options,
      );
      if (isCommandHandle(result)) {
        throw new Error("E2B returned a background handle for a blocking command.");
      }
      return normalizeResult(result, startedAt);
    } catch (error) {
      if (isCommandResult(error)) return normalizeResult(error, startedAt);
      throw error;
    }
  }

  async start(command: SandboxCommand): Promise<SandboxProcessInstance> {
    const startedAt = performance.now();
    const cwd = command.cwd ?? ".";
    const handle = await this.#client.commands.run(
      renderShellCommand(command.command, command.args ?? []),
      {
        cwd: cwd === "." ? DEFAULT_ROOT : projectPath(cwd),
        envs: { ...(command.env ?? {}) },
        timeoutMs: command.timeoutMs ?? 300_000,
        background: true,
        ...(command.signal ? { signal: command.signal } : {}),
        ...(command.onOutput ? {
          onStdout: (data: string) => command.onOutput!({ stream: "stdout", data }),
          onStderr: (data: string) => command.onOutput!({ stream: "stderr", data }),
        } : {}),
      },
    );
    if (!isCommandHandle(handle)) {
      throw new Error("E2B did not return a background command handle.");
    }
    return {
      id: String(handle.pid),
      async wait() {
        try {
          return normalizeResult(await handle.wait(), startedAt);
        } catch (error) {
          if (isCommandResult(error)) return normalizeResult(error, startedAt);
          throw error;
        }
      },
      async kill() {
        await handle.kill();
      },
    };
  }

  readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    return this.#client.files.read(
      projectPath(path),
      { format: "bytes", ...signalOptions(options.signal) },
    );
  }

  getUrl(port: number): string {
    const host = this.#client.getHost(port);
    return host.includes("://") ? host : `https://${host}`;
  }

  async stop(options: SandboxOperationOptions = {}): Promise<void> {
    await this.#client.kill(signalOptions(options.signal));
  }
}

async function createE2BSandbox(input: E2BSandboxFactoryInput): Promise<E2BSandboxClient> {
  return (input.template
    ? E2BSandbox.create(input.template, input.options)
    : E2BSandbox.create(input.options)) as unknown as E2BSandboxClient;
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

function copyArrayBuffer(value: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(value.byteLength);
  copy.set(value);
  return copy.buffer;
}

function normalizeResult(
  result: { exitCode: number; stdout: string; stderr: string },
  startedAt: number,
): SandboxCommandResult {
  return {
    exitCode: result.exitCode,
    stdout: result.stdout,
    stderr: result.stderr,
    durationMs: Math.max(0, performance.now() - startedAt),
  };
}

function isCommandResult(value: unknown): value is {
  exitCode: number;
  stdout: string;
  stderr: string;
} {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  return Number.isInteger(result.exitCode)
    && typeof result.stdout === "string"
    && typeof result.stderr === "string";
}

function isCommandHandle(value: unknown): value is E2BCommandHandle {
  if (!value || typeof value !== "object") return false;
  const handle = value as Record<string, unknown>;
  return Number.isInteger(handle.pid)
    && typeof handle.wait === "function"
    && typeof handle.kill === "function";
}

function signalOptions(signal: AbortSignal | undefined): { signal?: AbortSignal } {
  return signal ? { signal } : {};
}
