import { spawn } from "node:child_process";
import { posix } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { ConfigurationError } from "./errors.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCommandResult,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
  SandboxOperationOptions,
  SandboxOutputEvent,
} from "./sandbox.js";

const DEFAULT_IMAGE = "node:24-bookworm-slim";
const DEFAULT_ROOT = "/workspace";
const DEFAULT_MAX_OUTPUT_BYTES = 10 * 1024 * 1024;

export interface DockerSandboxAdapterOptions {
  readonly image?: string;
  readonly dockerPath?: string;
  readonly pull?: "always" | "missing" | "never";
  readonly network?: string;
  readonly platform?: string;
  readonly user?: string;
  readonly cpus?: number;
  readonly memoryMb?: number;
  readonly pidsLimit?: number;
  readonly workspaceSizeMb?: number;
  readonly readOnlyRoot?: boolean;
  readonly idleCommand?: readonly string[];
  readonly maxOutputBytes?: number;
}

export interface DockerProcessInput {
  readonly executable: string;
  readonly args: readonly string[];
  readonly stdin?: Uint8Array;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
  readonly maxOutputBytes: number;
  readonly onStdout?: (data: string) => void | Promise<void>;
  readonly onStderr?: (data: string) => void | Promise<void>;
}

export interface DockerProcessResult {
  readonly exitCode: number;
  readonly stdout: Uint8Array;
  readonly stderr: Uint8Array;
  readonly durationMs: number;
}

export interface DockerProcessRunner {
  run(input: DockerProcessInput): Promise<DockerProcessResult>;
}

export function dockerSandbox(
  options: DockerSandboxAdapterOptions = {},
  runner: DockerProcessRunner = new NodeDockerProcessRunner(),
): SandboxAdapter {
  const normalized = normalizeOptions(options);
  return {
    provider: "docker",
    async create(input) {
      const result = await runner.run({
        executable: normalized.dockerPath,
        args: createArguments(normalized, input),
        timeoutMs: input.timeoutMs,
        maxOutputBytes: normalized.maxOutputBytes,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      if (result.exitCode !== 0) {
        throw new Error(`Docker could not create the sandbox: ${decode(result.stderr).trim()}`);
      }
      const id = decode(result.stdout).trim().split(/\s+/, 1)[0];
      if (!id) throw new Error("Docker did not return a container ID.");
      return new DockerSandboxInstance(id, normalized, runner, input.timeoutMs);
    },
  };
}

class DockerSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly #options: NormalizedDockerOptions;
  readonly #runner: DockerProcessRunner;
  readonly #expiry: ReturnType<typeof setTimeout>;
  #stopPromise: Promise<void> | null = null;

  constructor(
    id: string,
    options: NormalizedDockerOptions,
    runner: DockerProcessRunner,
    timeoutMs: number,
  ) {
    this.id = id;
    this.#options = options;
    this.#runner = runner;
    this.#expiry = setTimeout(() => {
      void this.stop().catch(() => {});
    }, timeoutMs);
    this.#expiry.unref();
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    for (const file of files) {
      const result = await this.#docker(
        [
          "exec",
          "--interactive",
          ...this.#userArguments(),
          this.id,
          "sh",
          "-c",
          'mkdir -p "$(dirname "$1")" && cat > "$1"',
          "viby-write",
          projectPath(file.path),
        ],
        {
          stdin: typeof file.content === "string" ? Buffer.from(file.content) : file.content,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
      assertDockerSuccess(result, `write ${file.path}`);
    }
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const cwd = command.cwd ?? ".";
    const environment = Object.entries(command.env ?? {}).flatMap(([key, value]) => [
      "--env",
      `${key}=${value}`,
    ]);
    const result = await this.#docker(
      [
        "exec",
        "--workdir",
        cwd === "." ? DEFAULT_ROOT : projectPath(cwd),
        ...this.#userArguments(),
        ...environment,
        this.id,
        command.command,
        ...(command.args ?? []),
      ],
      {
        ...(command.timeoutMs !== undefined ? { timeoutMs: command.timeoutMs } : {}),
        ...(command.signal ? { signal: command.signal } : {}),
        ...(command.onOutput ? {
          onStdout: (data) => command.onOutput!({ stream: "stdout", data }),
          onStderr: (data) => command.onOutput!({ stream: "stderr", data }),
        } : {}),
      },
    );
    if (result.exitCode === 125) {
      throw new Error(`Docker could not execute the command: ${decode(result.stderr).trim()}`);
    }
    return {
      exitCode: result.exitCode,
      stdout: decode(result.stdout),
      stderr: decode(result.stderr),
      durationMs: result.durationMs,
    };
  }

  async readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    const result = await this.#docker(
      ["exec", ...this.#userArguments(), this.id, "cat", projectPath(path)],
      options.signal ? { signal: options.signal } : {},
    );
    assertDockerSuccess(result, `read ${path}`);
    return result.stdout;
  }

  async getUrl(port: number): Promise<string> {
    const result = await this.#docker(["port", this.id, `${port}/tcp`]);
    assertDockerSuccess(result, `resolve port ${port}`);
    const address = decode(result.stdout).trim().split("\n", 1)[0];
    if (!address) throw new Error(`Docker did not publish port ${port}.`);
    const normalized = address
      .replace(/^0\.0\.0\.0:/, "127.0.0.1:")
      .replace(/^\[::\]:/, "127.0.0.1:");
    return `http://${normalized}`;
  }

  stop(options: SandboxOperationOptions = {}): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    clearTimeout(this.#expiry);
    this.#stopPromise = this.#docker(
      ["rm", "--force", this.id],
      options.signal ? { signal: options.signal } : {},
    ).then((result) => {
      assertDockerSuccess(result, "remove sandbox");
    });
    return this.#stopPromise;
  }

  #userArguments(): string[] {
    return this.#options.user ? ["--user", this.#options.user] : [];
  }

  #docker(
    args: readonly string[],
    options: {
      stdin?: Uint8Array;
      timeoutMs?: number;
      signal?: AbortSignal;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
    } = {},
  ): Promise<DockerProcessResult> {
    return this.#runner.run({
      executable: this.#options.dockerPath,
      args,
      timeoutMs: options.timeoutMs ?? 60_000,
      maxOutputBytes: this.#options.maxOutputBytes,
      ...(options.stdin ? { stdin: options.stdin } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.onStdout ? { onStdout: options.onStdout } : {}),
      ...(options.onStderr ? { onStderr: options.onStderr } : {}),
    });
  }
}

class NodeDockerProcessRunner implements DockerProcessRunner {
  run(input: DockerProcessInput): Promise<DockerProcessResult> {
    return new Promise((resolve, reject) => {
      if (input.signal?.aborted) {
        reject(new Error("Docker command was aborted."));
        return;
      }
      const startedAt = performance.now();
      const child = spawn(input.executable, [...input.args], { stdio: "pipe" });
      const stdout: Buffer[] = [];
      const stderr: Buffer[] = [];
      const callbacks: Promise<void>[] = [];
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let outputBytes = 0;
      let failure: Error | null = null;
      let settled = false;

      const failAndKill = (error: Error) => {
        failure ??= error;
        child.kill("SIGKILL");
      };
      const abort = () => failAndKill(new Error("Docker command was aborted."));
      input.signal?.addEventListener("abort", abort, { once: true });
      const timer = setTimeout(() => {
        failAndKill(new Error(`Docker command timed out after ${input.timeoutMs} milliseconds.`));
      }, input.timeoutMs);
      timer.unref();

      const collect = (
        chunk: Buffer,
        target: Buffer[],
        decoder: StringDecoder,
        callback: ((data: string) => void | Promise<void>) | undefined,
      ) => {
        outputBytes += chunk.byteLength;
        if (outputBytes > input.maxOutputBytes) {
          failAndKill(new Error(`Docker output exceeded ${input.maxOutputBytes} bytes.`));
          return;
        }
        target.push(chunk);
        const text = decoder.write(chunk);
        if (callback && text) callbacks.push(Promise.resolve(callback(text)));
      };

      child.stdout.on("data", (chunk: Buffer) => {
        collect(chunk, stdout, stdoutDecoder, input.onStdout);
      });
      child.stderr.on("data", (chunk: Buffer) => {
        collect(chunk, stderr, stderrDecoder, input.onStderr);
      });
      child.on("error", (error) => {
        failure ??= error;
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        input.signal?.removeEventListener("abort", abort);
        const finalStdout = stdoutDecoder.end();
        const finalStderr = stderrDecoder.end();
        if (input.onStdout && finalStdout) {
          callbacks.push(Promise.resolve(input.onStdout(finalStdout)));
        }
        if (input.onStderr && finalStderr) {
          callbacks.push(Promise.resolve(input.onStderr(finalStderr)));
        }
        void Promise.all(callbacks).then(() => {
          if (failure) reject(failure);
          else if (code === null) reject(new Error("Docker command exited without a status code."));
          else resolve({
            exitCode: code,
            stdout: Buffer.concat(stdout),
            stderr: Buffer.concat(stderr),
            durationMs: Math.max(0, performance.now() - startedAt),
          });
        }, reject);
      });

      child.stdin.on("error", (error) => {
        failure ??= error;
      });
      child.stdin.end(input.stdin ? Buffer.from(input.stdin) : undefined);
    });
  }
}

interface NormalizedDockerOptions {
  readonly image: string;
  readonly dockerPath: string;
  readonly pull: "always" | "missing" | "never";
  readonly network: string;
  readonly platform?: string;
  readonly user?: string;
  readonly cpus: number;
  readonly memoryMb: number;
  readonly pidsLimit: number;
  readonly workspaceSizeMb: number;
  readonly readOnlyRoot: boolean;
  readonly idleCommand: readonly string[];
  readonly maxOutputBytes: number;
}

function normalizeOptions(options: DockerSandboxAdapterOptions): NormalizedDockerOptions {
  const image = requiredString(options.image ?? DEFAULT_IMAGE, "Docker image");
  const dockerPath = requiredString(options.dockerPath ?? "docker", "Docker executable");
  const network = requiredString(options.network ?? "bridge", "Docker network");
  const idleCommand = options.idleCommand ?? ["tail", "-f", "/dev/null"];
  if (!Array.isArray(idleCommand) || idleCommand.length === 0 || idleCommand.some((value) => (
    typeof value !== "string" || value.length === 0 || value.includes("\0")
  ))) {
    throw new ConfigurationError("Docker idleCommand must contain at least one valid argument.");
  }
  return {
    image,
    dockerPath,
    pull: options.pull ?? "missing",
    network,
    cpus: boundedNumber(options.cpus ?? 1, 0.1, 32, "Docker CPUs"),
    memoryMb: boundedInteger(options.memoryMb ?? 1_024, 128, 131_072, "Docker memory"),
    pidsLimit: boundedInteger(options.pidsLimit ?? 256, 16, 32_768, "Docker PID limit"),
    workspaceSizeMb: boundedInteger(
      options.workspaceSizeMb ?? 2_048,
      64,
      131_072,
      "Docker workspace size",
    ),
    readOnlyRoot: options.readOnlyRoot ?? true,
    idleCommand: [...idleCommand],
    maxOutputBytes: boundedInteger(
      options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES,
      1_024,
      1_073_741_824,
      "Docker maximum output size",
    ),
    ...(options.platform ? { platform: requiredString(options.platform, "Docker platform") } : {}),
    ...(options.user ? { user: requiredString(options.user, "Docker user") } : {}),
  };
}

function createArguments(
  options: NormalizedDockerOptions,
  input: SandboxCreateInput,
): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--pull",
    options.pull,
    "--label",
    "com.viby.sandbox=true",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    String(options.pidsLimit),
    "--memory",
    `${options.memoryMb}m`,
    "--cpus",
    String(options.cpus),
    "--network",
    options.network,
    "--workdir",
    DEFAULT_ROOT,
    "--tmpfs",
    `${DEFAULT_ROOT}:rw,exec,nosuid,size=${options.workspaceSizeMb}m`,
    "--tmpfs",
    "/tmp:rw,nosuid,nodev,size=64m",
    ...(options.readOnlyRoot ? ["--read-only"] : []),
    ...(options.platform ? ["--platform", options.platform] : []),
    ...(options.user ? ["--user", options.user] : []),
    ...Object.entries(input.env).flatMap(([key, value]) => ["--env", `${key}=${value}`]),
    ...input.ports.flatMap((port) => ["--publish", `127.0.0.1::${port}`]),
    options.image,
    ...options.idleCommand,
  ];
}

function projectPath(path: string): string {
  return posix.join(DEFAULT_ROOT, path);
}

function assertDockerSuccess(result: DockerProcessResult, operation: string): void {
  if (result.exitCode !== 0) {
    throw new Error(`Docker could not ${operation}: ${decode(result.stderr).trim()}`);
  }
}

function decode(value: Uint8Array): string {
  return Buffer.from(value).toString("utf8");
}

function requiredString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || normalized.includes("\0")) {
    throw new ConfigurationError(`${label} is invalid.`);
  }
  return normalized;
}

function boundedInteger(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function boundedNumber(value: number, minimum: number, maximum: number, label: string): number {
  if (!Number.isFinite(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${label} must be between ${minimum} and ${maximum}.`);
  }
  return value;
}
