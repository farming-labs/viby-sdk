import { randomUUID } from "node:crypto";
import { posix } from "node:path";
import type { Readable } from "node:stream";
import {
  Daytona,
  type CreateSandboxFromImageParams,
  type CreateSandboxFromSnapshotParams,
  type DaytonaConfig,
} from "@daytona/sdk";
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

const DEFAULT_ROOT_NAME = "viby";
const DEFAULT_CREATE_TIMEOUT_SECONDS = 60;
const DEFAULT_PREVIEW_EXPIRY_SECONDS = 3_600;
const FILE_TRANSFER_TIMEOUT_SECONDS = 1_800;

interface DaytonaSandboxCommonOptions {
  readonly apiKey?: string;
  readonly apiUrl?: string;
  readonly target?: string;
  readonly requestTimeoutMs?: number;
  readonly language?: string;
  readonly user?: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly secrets?: Readonly<Record<string, string>>;
  readonly public?: boolean;
  readonly networkBlockAll?: boolean;
  readonly networkAllowList?: string;
  readonly domainAllowList?: string;
  readonly name?: string | ((context: SandboxCreateContext) => string);
  readonly createTimeoutSeconds?: number;
  readonly previewExpiresInSeconds?: number;
  readonly onSnapshotCreateLogs?: (chunk: string) => void;
}

interface DaytonaResources {
  readonly cpu?: number;
  readonly gpu?: number;
  readonly memory?: number;
  readonly disk?: number;
}

type DaytonaImageOptions = {
  readonly image: string;
  readonly snapshot?: never;
  readonly resources?: DaytonaResources;
};

type DaytonaSnapshotOptions = {
  readonly snapshot?: string;
  readonly image?: never;
  readonly resources?: never;
};

export type DaytonaSandboxAdapterOptions = DaytonaSandboxCommonOptions
  & (DaytonaImageOptions | DaytonaSnapshotOptions);

export interface DaytonaSandboxFactoryInput {
  readonly config: DaytonaConfig;
  readonly params: CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams;
  readonly createOptions: {
    readonly timeout: number;
    readonly onSnapshotCreateLogs?: (chunk: string) => void;
  };
  readonly signal?: AbortSignal;
}

export interface DaytonaSandboxClient {
  readonly id: string;
  readonly fs: {
    uploadFileStream(
      source: Uint8Array,
      remotePath: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<void>;
    downloadFileStream(
      remotePath: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ): Promise<Readable>;
  };
  readonly process: {
    executeCommand(
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ): Promise<{ exitCode: number; result: string }>;
    createSession(sessionId: string): Promise<void>;
    executeSessionCommand(
      sessionId: string,
      request: {
        command: string;
        runAsync?: boolean;
        suppressInputEcho?: boolean;
      },
      timeout?: number,
    ): Promise<{
      cmdId: string;
      exitCode?: number;
      output?: string;
      stdout?: string;
      stderr?: string;
    }>;
    getSessionCommandLogs(
      sessionId: string,
      commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ): Promise<void>;
    getSessionCommand(
      sessionId: string,
      commandId: string,
    ): Promise<{ exitCode?: number }>;
    deleteSession(sessionId: string): Promise<void>;
  };
  getUserHomeDir(): Promise<string | undefined>;
  getSignedPreviewUrl(
    port: number,
    expiresInSeconds?: number,
  ): Promise<{ url: string; token: string }>;
  delete(timeout?: number, wait?: boolean): Promise<void>;
}

export type DaytonaSandboxFactory = (
  input: DaytonaSandboxFactoryInput,
) => Promise<DaytonaSandboxClient>;

export function daytonaSandbox(
  options: DaytonaSandboxAdapterOptions = {},
  factory: DaytonaSandboxFactory = createDaytonaSandbox,
): SandboxAdapter {
  const normalized = normalizeOptions(options);
  return {
    provider: "daytona",
    async create(input) {
      const name = typeof normalized.name === "function"
        ? normalizeOptionalString(normalized.name(input.context), "Daytona sandbox name")
        : normalized.name;
      const client = await factory({
        config: normalized.config,
        params: createParams(normalized, input, name),
        createOptions: {
          timeout: normalized.createTimeoutSeconds,
          ...(normalized.onSnapshotCreateLogs
            ? { onSnapshotCreateLogs: normalized.onSnapshotCreateLogs }
            : {}),
        },
        ...(input.signal ? { signal: input.signal } : {}),
      });
      try {
        const home = await abortable(client.getUserHomeDir(), input.signal);
        if (!home) throw new Error("Daytona did not return the sandbox home directory.");
        const root = posix.join(home, DEFAULT_ROOT_NAME);
        const setup = await abortable(
          client.process.executeCommand(
            `mkdir -p -- ${quoteShellArgument(root)}`,
            undefined,
            undefined,
            normalized.createTimeoutSeconds,
          ),
          input.signal,
        );
        assertCommandSuccess(setup, "create the project workspace");
        return new DaytonaSandboxInstance(client, root, normalized);
      } catch (error) {
        await client.delete(normalized.createTimeoutSeconds, true).catch(() => {});
        throw error;
      }
    },
  };
}

class DaytonaSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly #client: DaytonaSandboxClient;
  readonly #root: string;
  readonly #options: NormalizedDaytonaOptions;

  constructor(
    client: DaytonaSandboxClient,
    root: string,
    options: NormalizedDaytonaOptions,
  ) {
    this.id = client.id;
    this.#client = client;
    this.#root = root;
    this.#options = options;
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    const directories = [...new Set(files.map((file) => (
      posix.dirname(projectPath(this.#root, file.path))
    )))];
    if (directories.length > 0) {
      const setup = await abortable(
        this.#client.process.executeCommand(
          `mkdir -p -- ${directories.map(quoteShellArgument).join(" ")}`,
          undefined,
          undefined,
          this.#options.createTimeoutSeconds,
        ),
        options.signal,
      );
      assertCommandSuccess(setup, "create project directories");
    }
    for (const file of files) {
      await this.#client.fs.uploadFileStream(
        typeof file.content === "string" ? Buffer.from(file.content) : file.content,
        projectPath(this.#root, file.path),
        {
          timeout: FILE_TRANSFER_TIMEOUT_SECONDS,
          ...(options.signal ? { signal: options.signal } : {}),
        },
      );
    }
  }

  async run(command: SandboxCommand): Promise<SandboxCommandResult> {
    const startedAt = performance.now();
    const sessionId = `viby-${randomUUID()}`;
    const rendered = renderShellCommand(command.command, command.args ?? []);
    const cwd = command.cwd === undefined || command.cwd === "."
      ? this.#root
      : projectPath(this.#root, command.cwd);
    const shellCommand = [
      `cd -- ${quoteShellArgument(cwd)}`,
      renderEnvironment(command.env ?? {}),
      rendered,
    ].filter(Boolean).join(" && ");
    const timeoutSeconds = millisecondsToSeconds(command.timeoutMs ?? 300_000);
    await abortable(this.#client.process.createSession(sessionId), command.signal);
    try {
      if (!command.onOutput) {
        const result = await abortable(
          this.#client.process.executeSessionCommand(
            sessionId,
            { command: shellCommand, runAsync: false, suppressInputEcho: true },
            timeoutSeconds,
          ),
          command.signal,
          () => this.#client.process.deleteSession(sessionId),
        );
        return {
          exitCode: result.exitCode ?? 1,
          stdout: result.stdout ?? result.output ?? "",
          stderr: result.stderr ?? "",
          durationMs: Math.max(0, performance.now() - startedAt),
        };
      }

      const result = await abortable(
        this.#client.process.executeSessionCommand(
          sessionId,
          { command: shellCommand, runAsync: true, suppressInputEcho: true },
          timeoutSeconds,
        ),
        command.signal,
        () => this.#client.process.deleteSession(sessionId),
      );
      const stdout: string[] = [];
      const stderr: string[] = [];
      const callbacks: Promise<void>[] = [];
      await abortable(
        this.#client.process.getSessionCommandLogs(
          sessionId,
          result.cmdId,
          (chunk) => {
            stdout.push(chunk);
            callbacks.push(Promise.resolve(command.onOutput!({ stream: "stdout", data: chunk })));
          },
          (chunk) => {
            stderr.push(chunk);
            callbacks.push(Promise.resolve(command.onOutput!({ stream: "stderr", data: chunk })));
          },
        ),
        command.signal,
        () => this.#client.process.deleteSession(sessionId),
      );
      await Promise.all(callbacks);
      const completed = await abortable(
        this.#client.process.getSessionCommand(sessionId, result.cmdId),
        command.signal,
      );
      return {
        exitCode: completed.exitCode ?? result.exitCode ?? 1,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        durationMs: Math.max(0, performance.now() - startedAt),
      };
    } finally {
      await this.#client.process.deleteSession(sessionId).catch(() => {});
    }
  }

  async readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    const stream = await this.#client.fs.downloadFileStream(
      projectPath(this.#root, path),
      {
        timeout: FILE_TRANSFER_TIMEOUT_SECONDS,
        ...(options.signal ? { signal: options.signal } : {}),
      },
    );
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async getUrl(port: number): Promise<string> {
    const preview = await this.#client.getSignedPreviewUrl(
      port,
      this.#options.previewExpiresInSeconds,
    );
    return preview.url;
  }

  async stop(options: SandboxOperationOptions = {}): Promise<void> {
    await abortable(
      this.#client.delete(this.#options.createTimeoutSeconds, true),
      options.signal,
    );
  }
}

async function createDaytonaSandbox(
  input: DaytonaSandboxFactoryInput,
): Promise<DaytonaSandboxClient> {
  const daytona = new Daytona(input.config);
  const creation = "image" in input.params && input.params.image
    ? daytona.create(input.params as CreateSandboxFromImageParams, input.createOptions)
    : daytona.create(input.params as CreateSandboxFromSnapshotParams, input.createOptions);
  return abortable(
    creation,
    input.signal,
    () => creation.then((sandbox) => sandbox.delete(input.createOptions.timeout, true)),
  );
}

interface NormalizedDaytonaOptions {
  readonly config: DaytonaConfig;
  readonly image?: string;
  readonly snapshot?: string;
  readonly resources?: DaytonaResources;
  readonly language?: string;
  readonly user?: string;
  readonly labels?: Record<string, string>;
  readonly secrets?: Record<string, string>;
  readonly public?: boolean;
  readonly networkBlockAll?: boolean;
  readonly networkAllowList?: string;
  readonly domainAllowList?: string;
  readonly name?: string | ((context: SandboxCreateContext) => string);
  readonly createTimeoutSeconds: number;
  readonly previewExpiresInSeconds: number;
  readonly onSnapshotCreateLogs?: (chunk: string) => void;
}

function normalizeOptions(options: DaytonaSandboxAdapterOptions): NormalizedDaytonaOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Daytona Sandbox options must be an object.");
  }
  const raw = options as DaytonaSandboxCommonOptions & {
    image?: string;
    snapshot?: string;
    resources?: DaytonaResources;
  };
  if (raw.image && raw.snapshot) {
    throw new ConfigurationError("Daytona Sandbox accepts either image or snapshot, not both.");
  }
  if (raw.resources && !raw.image) {
    throw new ConfigurationError("Daytona Sandbox resources require an image.");
  }
  const config: DaytonaConfig = {
    ...(raw.apiKey ? { apiKey: normalizeOptionalString(raw.apiKey, "Daytona API key") } : {}),
    ...(raw.apiUrl ? { apiUrl: normalizeOptionalString(raw.apiUrl, "Daytona API URL") } : {}),
    ...(raw.target ? { target: normalizeOptionalString(raw.target, "Daytona target") } : {}),
    ...(raw.requestTimeoutMs !== undefined
      ? { requestTimeoutMs: positiveInteger(raw.requestTimeoutMs, "Daytona request timeout") }
      : {}),
  };
  return {
    config,
    createTimeoutSeconds: boundedInteger(
      raw.createTimeoutSeconds ?? DEFAULT_CREATE_TIMEOUT_SECONDS,
      1,
      3_600,
      "Daytona creation timeout",
    ),
    previewExpiresInSeconds: boundedInteger(
      raw.previewExpiresInSeconds ?? DEFAULT_PREVIEW_EXPIRY_SECONDS,
      1,
      86_400,
      "Daytona preview expiry",
    ),
    ...(raw.image ? { image: normalizeOptionalString(raw.image, "Daytona image") } : {}),
    ...(raw.snapshot ? { snapshot: normalizeOptionalString(raw.snapshot, "Daytona snapshot") } : {}),
    ...(raw.resources ? { resources: { ...raw.resources } } : {}),
    ...(raw.language ? { language: normalizeOptionalString(raw.language, "Daytona language") } : {}),
    ...(raw.user ? { user: normalizeOptionalString(raw.user, "Daytona user") } : {}),
    ...(raw.labels ? { labels: { ...raw.labels } } : {}),
    ...(raw.secrets ? { secrets: { ...raw.secrets } } : {}),
    ...(raw.public !== undefined ? { public: raw.public } : {}),
    ...(raw.networkBlockAll !== undefined ? { networkBlockAll: raw.networkBlockAll } : {}),
    ...(raw.networkAllowList
      ? { networkAllowList: normalizeOptionalString(raw.networkAllowList, "Daytona network allow list") }
      : {}),
    ...(raw.domainAllowList
      ? { domainAllowList: normalizeOptionalString(raw.domainAllowList, "Daytona domain allow list") }
      : {}),
    ...(raw.name ? { name: raw.name } : {}),
    ...(raw.onSnapshotCreateLogs ? { onSnapshotCreateLogs: raw.onSnapshotCreateLogs } : {}),
  };
}

function createParams(
  options: NormalizedDaytonaOptions,
  input: SandboxCreateInput,
  name: string | undefined,
): CreateSandboxFromImageParams | CreateSandboxFromSnapshotParams {
  const common = {
    ephemeral: true,
    autoStopInterval: 0,
    ttlMinutes: Math.max(1, Math.ceil(input.timeoutMs / 60_000)),
    envVars: { ...input.env },
    ...(name ? { name } : {}),
    ...(options.language ? { language: options.language } : {}),
    ...(options.user ? { user: options.user } : {}),
    ...(options.labels ? { labels: { ...options.labels } } : {}),
    ...(options.secrets ? { secrets: { ...options.secrets } } : {}),
    ...(options.public !== undefined ? { public: options.public } : {}),
    ...(options.networkBlockAll !== undefined
      ? { networkBlockAll: options.networkBlockAll }
      : {}),
    ...(options.networkAllowList ? { networkAllowList: options.networkAllowList } : {}),
    ...(options.domainAllowList ? { domainAllowList: options.domainAllowList } : {}),
  };
  return options.image
    ? { ...common, image: options.image, ...(options.resources ? { resources: options.resources } : {}) }
    : { ...common, ...(options.snapshot ? { snapshot: options.snapshot } : {}) };
}

function projectPath(root: string, path: string): string {
  return posix.join(root, path);
}

function renderShellCommand(command: string, args: readonly string[]): string {
  return [command, ...args].map(quoteShellArgument).join(" ");
}

function renderEnvironment(environment: Readonly<Record<string, string>>): string {
  const entries = Object.entries(environment);
  return entries.length === 0
    ? ""
    : `export ${entries.map(([key, value]) => quoteShellArgument(`${key}=${value}`)).join(" ")}`;
}

function quoteShellArgument(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function millisecondsToSeconds(value: number): number {
  return Math.max(1, Math.ceil(value / 1_000));
}

function assertCommandSuccess(
  result: { exitCode: number; result: string },
  operation: string,
): void {
  if (result.exitCode !== 0) {
    throw new Error(`Daytona could not ${operation}: ${result.result}`);
  }
}

function normalizeOptionalString(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 1_000 || normalized.includes("\0")) {
    throw new ConfigurationError(`${label} is invalid.`);
  }
  return normalized;
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ConfigurationError(`${label} must be a positive integer.`);
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
    return Promise.reject(new Error("Daytona operation was aborted."));
  }
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      runAbortCleanup(onAbort);
      reject(new Error("Daytona operation was aborted."));
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
