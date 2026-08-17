import { ConfigurationError, NotFoundError, VibyError } from "./errors.js";
import type { EnvironmentName } from "./environment.js";
import {
  type SandboxAdapter,
  type SandboxCommand,
  type SandboxCommandResult,
  type SandboxFile,
  type SandboxOutputEvent,
  type SandboxReadinessOptions,
  type SandboxSession,
  type SandboxOpenOptions,
  SandboxRegistry,
} from "./sandbox.js";
import type { FrameworkId, UserScope, VersionData } from "./types.js";
import { createId, errorMessage, sha256 } from "./utils.js";

const DEFAULT_SANDBOX_TIMEOUT_MS = 30 * 60 * 1_000;
const DEFAULT_CLEANUP_LIMIT = 100;

export type PreviewStatus = "starting" | "ready" | "failed" | "stopped" | "expired";

export type PreviewCommandStage = "prepare" | "start";

export interface PreviewCommandSnapshot {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
}

/**
 * Provider-neutral, live preview progress emitted while an immutable version is
 * materialized, prepared, started, and checked for readiness.
 */
export type PreviewEvent =
  | {
      readonly type: "preview.created";
      readonly previewId: string;
      readonly sandboxProvider: string;
      readonly createdAt: Date;
    }
  | {
      readonly type: "workspace.prepared";
      readonly previewId: string;
      readonly filesWritten: number;
      readonly createdAt: Date;
    }
  | {
      readonly type: "command.started";
      readonly previewId: string;
      readonly stage: PreviewCommandStage;
      readonly index: number;
      readonly command: PreviewCommandSnapshot;
      readonly createdAt: Date;
    }
  | {
      readonly type: "command.output";
      readonly previewId: string;
      readonly stage: PreviewCommandStage;
      readonly index: number;
      readonly stream: SandboxOutputEvent["stream"];
      readonly data: string;
      readonly createdAt: Date;
    }
  | {
      readonly type: "command.completed";
      readonly previewId: string;
      readonly stage: PreviewCommandStage;
      readonly index: number;
      readonly command: PreviewCommandSnapshot;
      readonly result: SandboxCommandResult;
      readonly createdAt: Date;
    }
  | {
      readonly type: "readiness.started";
      readonly previewId: string;
      readonly port: number;
      readonly path: string;
      readonly createdAt: Date;
    }
  | {
      readonly type: "preview.ready";
      readonly previewId: string;
      readonly url: string;
      readonly createdAt: Date;
    }
  | {
      readonly type: "preview.failed";
      readonly previewId: string;
      readonly error: string;
      readonly createdAt: Date;
    };

export type PreviewEventListener = (event: PreviewEvent) => void | Promise<void>;

export interface PreviewSessionData<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly sandboxLeaseId: string;
  readonly sandboxProvider: string;
  readonly framework: Framework;
  readonly port: number;
  readonly path: string;
  readonly url: string | null;
  readonly status: PreviewStatus;
  readonly error: string | null;
  readonly expiresAt: Date;
  readonly readyAt: Date | null;
  readonly stoppedAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreatePreviewSessionRecord<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly sandboxLeaseId: string;
  readonly sandboxProvider: string;
  readonly framework: Framework;
  readonly port: number;
  readonly path: string;
  readonly expiresAt: Date;
  readonly now: Date;
}

export interface PreviewSessionListOptions {
  readonly chatId?: string;
  readonly versionId?: string;
  readonly status?: PreviewStatus;
}

export interface PreviewSessionStore {
  createPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreatePreviewSessionRecord<Framework>,
  ): Promise<PreviewSessionData<Framework>>;
  getPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<PreviewSessionData<Framework> | null>;
  listPreviewSessions<Framework extends FrameworkId>(
    scope: UserScope,
    options?: PreviewSessionListOptions,
  ): Promise<PreviewSessionData<Framework>[]>;
  listExpiredPreviewSessions<Framework extends FrameworkId>(
    scope: UserScope,
    now: Date,
    limit: number,
  ): Promise<PreviewSessionData<Framework>[]>;
  markPreviewReady<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    url: string,
    now: Date,
  ): Promise<PreviewSessionData<Framework>>;
  failPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    error: string,
    now: Date,
  ): Promise<PreviewSessionData<Framework>>;
  closePreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    status: "stopped" | "expired",
    now: Date,
  ): Promise<PreviewSessionData<Framework>>;
}

export interface PreviewConfig {
  /** Preview-only files written after immutable source materialization. */
  readonly files?: readonly SandboxFile[];
  /** Commands completed in order after source materialization and before the server starts. */
  readonly prepare?: readonly SandboxCommand[];
  /** Framework- or product-provided long-running development server command. */
  readonly start: SandboxCommand;
  readonly port: number;
  readonly path?: string;
  readonly environment?: EnvironmentName;
  /** Lifetime of the underlying sandbox lease. Defaults to 30 minutes. */
  readonly sandboxTimeoutMs?: number;
  readonly readiness?: Omit<SandboxReadinessOptions, "path" | "signal">;
}

export interface PreviewOpenOptions {
  readonly path?: string;
  readonly environment?: EnvironmentName;
  readonly env?: Readonly<Record<string, string>>;
  /** Observe real sandbox command output and lifecycle progress as preview startup runs. */
  readonly onEvent?: PreviewEventListener;
  readonly signal?: AbortSignal;
}

export interface ResolvedPreviewOpenOptions {
  readonly files: readonly SandboxFile[];
  readonly prepare: readonly SandboxCommand[];
  readonly start: SandboxCommand;
  readonly port: number;
  readonly path: string;
  readonly sandbox: SandboxOpenOptions;
  readonly readiness: Omit<SandboxReadinessOptions, "path" | "signal">;
  readonly onEvent?: PreviewEventListener;
  readonly signal?: AbortSignal;
}

export class PreviewError extends VibyError {
  readonly previewId: string | null;

  constructor(previewId: string | null, message: string, options?: ErrorOptions) {
    super("preview_failed", message, options);
    this.name = "PreviewError";
    this.previewId = previewId;
  }
}

/** Coordinates durable preview state with provider-neutral sandbox leases. */
export class PreviewRegistry<Framework extends FrameworkId = FrameworkId> {
  readonly #store: PreviewSessionStore;
  readonly #sandboxes: SandboxRegistry;
  readonly #sandbox: SandboxAdapter | undefined;
  readonly #config: PreviewConfig | undefined;
  readonly #sessions = new Map<string, { readonly session: SandboxSession; readonly scope: UserScope }>();
  readonly #stops = new Map<string, Promise<PreviewSessionData<Framework>>>();
  readonly #opening = new Map<string, {
    readonly events: PreviewEvent[];
    readonly listeners: Set<PreviewEventListener>;
    readonly promise: Promise<PreviewSessionData<Framework>>;
  }>();

  constructor(
    store: PreviewSessionStore,
    sandboxes: SandboxRegistry,
    sandbox: SandboxAdapter | undefined,
    config: PreviewConfig | undefined,
  ) {
    this.#store = store;
    this.#sandboxes = sandboxes;
    this.#sandbox = sandbox;
    this.#config = config === undefined ? undefined : normalizePreviewConfig(config);
  }

  resolve(options: PreviewOpenOptions = {}): ResolvedPreviewOpenOptions {
    if (!this.#config) {
      throw new ConfigurationError(
        "Preview sessions are not configured. Add preview.start and preview.port to createViby().",
      );
    }
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Preview options must be an object.");
    }
    const path = normalizePreviewPath(options.path ?? this.#config.path);
    return {
      files: this.#config.files ?? [],
      prepare: this.#config.prepare ?? [],
      start: this.#config.start,
      port: this.#config.port,
      path,
      sandbox: {
        timeoutMs: this.#config.sandboxTimeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
        ...((options.environment ?? this.#config.environment) === undefined
          ? {}
          : { environment: options.environment ?? this.#config.environment }),
        env: options.env ?? {},
        ports: [this.#config.port],
        ...(options.signal ? { signal: options.signal } : {}),
      },
      readiness: this.#config.readiness ?? {},
      ...(options.onEvent ? { onEvent: options.onEvent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
  }

  /** Coalesces concurrent opens for the same immutable version and preview inputs. */
  async start(
    scope: UserScope,
    version: VersionData<Framework>,
    options: ResolvedPreviewOpenOptions,
    createSandbox: () => Promise<SandboxSession>,
  ): Promise<PreviewSessionData<Framework>> {
    const key = previewOpenKey(scope, version, options);
    const active = this.#opening.get(key);
    if (active) {
      if (options.onEvent) {
        active.listeners.add(options.onEvent);
        for (const event of active.events) await emitPreviewEvent(options.onEvent, event);
      }
      return active.promise;
    }

    const listeners = new Set<PreviewEventListener>();
    if (options.onEvent) listeners.add(options.onEvent);
    const events: PreviewEvent[] = [];
    const broadcast: PreviewEventListener = async (event) => {
      events.push(event);
      if (events.length > 400) events.splice(0, events.length - 400);
      await Promise.all([...listeners].map((listener) => emitPreviewEvent(listener, event)));
    };
    const sharedOptions: ResolvedPreviewOpenOptions = { ...options, onEvent: broadcast };
    const promise = createSandbox()
      .then((sandbox) => this.open(scope, version, sandbox, sharedOptions))
      .finally(() => this.#opening.delete(key));
    this.#opening.set(key, { events, listeners, promise });
    return promise;
  }

  async open(
    scope: UserScope,
    version: VersionData<Framework>,
    sandbox: SandboxSession,
    options: ResolvedPreviewOpenOptions,
  ): Promise<PreviewSessionData<Framework>> {
    let lease;
    try {
      assertPreviewSandbox(sandbox);
      if (!sandbox.leaseId) {
        throw new PreviewError(null, "Durable previews require a persisted sandbox lease.");
      }
      lease = await this.#sandboxes.get<Framework>(scope, sandbox.leaseId);
      if (!lease) throw new PreviewError(null, "The preview sandbox lease was not persisted.");
    } catch (error) {
      await sandbox.stop().catch(() => undefined);
      throw error;
    }
    const id = createId();
    let preview: PreviewSessionData<Framework>;
    try {
      preview = await this.#store.createPreviewSession(scope, {
        id,
        chatId: version.chatId,
        versionId: version.id,
        sandboxLeaseId: lease.id,
        sandboxProvider: sandbox.provider,
        framework: version.framework,
        port: options.port,
        path: options.path,
        expiresAt: lease.expiresAt,
        now: new Date(),
      });
    } catch (error) {
      await sandbox.stop().catch(() => undefined);
      throw error;
    }
    this.#sessions.set(preview.id, { session: sandbox, scope: { ...scope } });
    await emitPreviewEvent(options.onEvent, {
      type: "preview.created",
      previewId: preview.id,
      sandboxProvider: sandbox.provider,
      createdAt: new Date(),
    });
    try {
      if (options.files.length > 0) {
        await sandbox.writeFiles(options.files, options.signal ? { signal: options.signal } : {});
      }
      await emitPreviewEvent(options.onEvent, {
        type: "workspace.prepared",
        previewId: preview.id,
        filesWritten: options.files.length,
        createdAt: new Date(),
      });
      for (const [index, command] of options.prepare.entries()) {
        const snapshot = commandSnapshot(command);
        await emitPreviewEvent(options.onEvent, {
          type: "command.started",
          previewId: preview.id,
          stage: "prepare",
          index,
          command: snapshot,
          createdAt: new Date(),
        });
        const result = await sandbox.run({
          ...withPreviewOutput(command, options.onEvent, preview.id, "prepare", index),
          ...(options.signal ? { signal: options.signal } : {}),
        });
        await emitPreviewEvent(options.onEvent, {
          type: "command.completed",
          previewId: preview.id,
          stage: "prepare",
          index,
          command: snapshot,
          result,
          createdAt: new Date(),
        });
        if (result.exitCode !== 0) {
          const detail = (result.stderr || result.stdout).trim().slice(0, 2_000);
          throw new Error(
            `Preview preparation command ${command.command} exited with ${result.exitCode}`
              + (detail ? `: ${detail}` : "."),
          );
        }
      }
      const startSnapshot = commandSnapshot(options.start);
      await emitPreviewEvent(options.onEvent, {
        type: "command.started",
        previewId: preview.id,
        stage: "start",
        index: 0,
        command: startSnapshot,
        createdAt: new Date(),
      });
      const process = await sandbox.start({
        ...withPreviewOutput(options.start, options.onEvent, preview.id, "start", 0),
        ...(options.signal ? { signal: options.signal } : {}),
      });
      await emitPreviewEvent(options.onEvent, {
        type: "readiness.started",
        previewId: preview.id,
        port: options.port,
        path: options.path,
        createdAt: new Date(),
      });
      const url = await Promise.race([
        sandbox.waitForPort(options.port, {
          ...options.readiness,
          path: options.path,
          ...(options.signal ? { signal: options.signal } : {}),
        }),
        process.wait(options.signal ? { signal: options.signal } : {}).then((result): never => {
          const detail = (result.stderr || result.stdout).trim().slice(0, 2_000);
          throw new Error(
            `Preview command exited with ${result.exitCode}${detail ? `: ${detail}` : "."}`,
          );
        }),
      ]);
      preview = await this.#store.markPreviewReady(scope, preview.id, url, new Date());
      await emitPreviewEvent(options.onEvent, {
        type: "preview.ready",
        previewId: preview.id,
        url,
        createdAt: new Date(),
      });
      return preview;
    } catch (error) {
      await emitPreviewEvent(options.onEvent, {
        type: "preview.failed",
        previewId: preview.id,
        error: errorMessage(error),
        createdAt: new Date(),
      });
      const failures: unknown[] = [error];
      try {
        preview = await this.#store.failPreviewSession(
          scope,
          preview.id,
          errorMessage(error),
          new Date(),
        );
      } catch (historyError) {
        failures.push(historyError);
      }
      try {
        await sandbox.stop();
      } catch (stopError) {
        failures.push(stopError);
      }
      this.#sessions.delete(preview.id);
      const cause = failures.length === 1
        ? failures[0]
        : new AggregateError(failures, "Preview start and cleanup failed.");
      throw new PreviewError(preview.id, `Preview ${preview.id} could not become ready.`, { cause });
    }
  }

  async get(scope: UserScope, id: string): Promise<PreviewSessionData<Framework>> {
    const preview = await this.#store.getPreviewSession<Framework>(scope, id);
    if (!preview) throw new NotFoundError("Preview session");
    if (isActivePreview(preview.status) && preview.expiresAt.getTime() <= Date.now()) {
      return this.#store.closePreviewSession(scope, preview.id, "expired", new Date());
    }
    return preview;
  }

  list(
    scope: UserScope,
    options: PreviewSessionListOptions = {},
  ): Promise<PreviewSessionData<Framework>[]> {
    return this.#store.listPreviewSessions<Framework>(scope, options);
  }

  async reconnect(scope: UserScope, id: string, signal?: AbortSignal): Promise<PreviewSessionData<Framework>> {
    const preview = await this.get(scope, id);
    if (!isActivePreview(preview.status)) {
      throw new PreviewError(preview.id, `Preview ${preview.id} is ${preview.status}.`);
    }
    const sandbox = await this.#session(scope, preview, signal);
    try {
      const url = await sandbox.waitForPort(preview.port, {
        ...(this.#config?.readiness ?? {}),
        path: preview.path,
        ...(signal ? { signal } : {}),
      });
      return this.#store.markPreviewReady(scope, preview.id, url, new Date());
    } catch (error) {
      if (!signal?.aborted) {
        await sandbox.stop().catch(() => undefined);
        this.#sessions.delete(preview.id);
        await this.#store.failPreviewSession(
          scope,
          preview.id,
          errorMessage(error),
          new Date(),
        ).catch(() => undefined);
      }
      throw new PreviewError(preview.id, `Preview ${preview.id} could not be reconnected.`, {
        cause: error,
      });
    }
  }

  stop(scope: UserScope, id: string, signal?: AbortSignal): Promise<PreviewSessionData<Framework>> {
    const active = this.#stops.get(id);
    if (active) return active;
    const pending = this.#stop(scope, id, signal).finally(() => this.#stops.delete(id));
    this.#stops.set(id, pending);
    return pending;
  }

  async cleanupExpired(scope: UserScope, limit = DEFAULT_CLEANUP_LIMIT): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
      throw new ConfigurationError("Preview cleanup limit must be an integer between 1 and 1000.");
    }
    const now = new Date();
    const previews = await this.#store.listExpiredPreviewSessions<Framework>(scope, now, limit);
    await Promise.allSettled(previews.map(async (preview) => {
      const active = this.#sessions.get(preview.id);
      if (active) await active.session.stop().catch(() => undefined);
      this.#sessions.delete(preview.id);
      await this.#store.closePreviewSession(scope, preview.id, "expired", now);
    }));
    return previews.length;
  }

  async stopAll(): Promise<void> {
    const active = [...this.#sessions.entries()];
    const results = await Promise.allSettled(active.map(async ([id, tracked]) => {
      const preview = await this.#store.getPreviewSession<Framework>(tracked.scope, id);
      if (preview) await this.stop(tracked.scope, id);
    }));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  async #stop(
    scope: UserScope,
    id: string,
    signal?: AbortSignal,
  ): Promise<PreviewSessionData<Framework>> {
    const preview = await this.get(scope, id);
    if (!isActivePreview(preview.status)) return preview;
    let session = this.#sessions.get(preview.id)?.session;
    if (!session) {
      try {
        session = await this.#session(scope, preview, signal);
      } catch (error) {
        if (preview.expiresAt.getTime() <= Date.now()) {
          return this.#store.closePreviewSession(scope, preview.id, "expired", new Date());
        }
        throw new PreviewError(preview.id, `Preview ${preview.id} could not be stopped.`, {
          cause: error,
        });
      }
    }
    await session.stop(signal ? { signal } : {});
    this.#sessions.delete(preview.id);
    return this.#store.closePreviewSession(scope, preview.id, "stopped", new Date());
  }

  async #session(
    scope: UserScope,
    preview: PreviewSessionData<Framework>,
    signal?: AbortSignal,
  ): Promise<SandboxSession> {
    const active = this.#sessions.get(preview.id)?.session;
    if (active && !active.stopped) return active;
    const session = await this.#sandboxes.reconnect<Framework>(
      this.#sandbox,
      scope,
      preview.sandboxLeaseId,
      signal ? { signal } : {},
    );
    this.#sessions.set(preview.id, { session, scope: { ...scope } });
    return session;
  }
}

function commandSnapshot(command: SandboxCommand): PreviewCommandSnapshot {
  return Object.freeze({
    command: command.command,
    args: Object.freeze([...(command.args ?? [])]),
    cwd: command.cwd ?? ".",
  });
}

function previewOpenKey<Framework extends FrameworkId>(
  scope: UserScope,
  version: VersionData<Framework>,
  options: ResolvedPreviewOpenOptions,
): string {
  const environment = Object.entries(options.sandbox.env ?? {}).sort(([left], [right]) => (
    left.localeCompare(right)
  ));
  const files = options.files.map((file) => ({
    path: file.path,
    content: typeof file.content === "string"
      ? file.content
      : Array.from(file.content),
  }));
  return sha256(JSON.stringify({
    tenantId: scope.tenantId,
    userId: scope.userId,
    versionId: version.id,
    path: options.path,
    environment: options.sandbox.environment ?? null,
    env: environment,
    files,
  }));
}

function withPreviewOutput(
  command: SandboxCommand,
  listener: PreviewEventListener | undefined,
  previewId: string,
  stage: PreviewCommandStage,
  index: number,
): SandboxCommand {
  if (!listener) return command;
  return {
    ...command,
    onOutput: async (output) => {
      await command.onOutput?.(output);
      await emitPreviewEvent(listener, {
        type: "command.output",
        previewId,
        stage,
        index,
        stream: output.stream,
        data: output.data,
        createdAt: new Date(),
      });
    },
  };
}

async function emitPreviewEvent(
  listener: PreviewEventListener | undefined,
  event: PreviewEvent,
): Promise<void> {
  if (!listener) return;
  await Promise.resolve(listener(event)).catch(() => undefined);
}

function normalizePreviewConfig(config: PreviewConfig): PreviewConfig {
  if (!config || typeof config !== "object") {
    throw new ConfigurationError("preview must be an object.");
  }
  if (!config.start || typeof config.start !== "object") {
    throw new ConfigurationError("preview.start must be a sandbox command.");
  }
  if (config.prepare !== undefined && (!Array.isArray(config.prepare)
    || config.prepare.some((command) => !command || typeof command !== "object"))) {
    throw new ConfigurationError("preview.prepare must be an array of sandbox commands.");
  }
  if (config.files !== undefined && (!Array.isArray(config.files)
    || config.files.some((file) => !file || typeof file !== "object"))) {
    throw new ConfigurationError("preview.files must be an array of sandbox files.");
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65_535) {
    throw new ConfigurationError("preview.port must be an integer between 1 and 65535.");
  }
  if (config.sandboxTimeoutMs !== undefined && (
    !Number.isInteger(config.sandboxTimeoutMs)
    || config.sandboxTimeoutMs < 1
    || config.sandboxTimeoutMs > 86_400_000
  )) {
    throw new ConfigurationError("preview.sandboxTimeoutMs must be an integer between 1 and 86400000.");
  }
  if (config.readiness !== undefined && (!config.readiness || typeof config.readiness !== "object")) {
    throw new ConfigurationError("preview.readiness must be an object.");
  }
  return Object.freeze({
    ...config,
    files: Object.freeze((config.files ?? []).map((file) => ({
      path: file.path,
      content: typeof file.content === "string" ? file.content : new Uint8Array(file.content),
    }))),
    prepare: Object.freeze((config.prepare ?? []).map((command) => ({ ...command }))),
    path: normalizePreviewPath(config.path),
    readiness: config.readiness ? { ...config.readiness } : {},
  });
}

function normalizePreviewPath(value: string | undefined): string {
  const path = value ?? "/";
  if (!path.startsWith("/") || path.startsWith("//") || path.includes("\\")
    || path.includes("\0") || path.length > 2_000) {
    throw new ConfigurationError("Preview path must be an absolute URL path up to 2000 characters.");
  }
  return path;
}

function assertPreviewSandbox(sandbox: SandboxSession): void {
  for (const capability of ["backgroundProcesses", "portUrls", "reconnect"] as const) {
    if (!sandbox.supports(capability)) {
      throw new ConfigurationError(`Durable previews require sandbox capability ${capability}.`);
    }
  }
}

function isActivePreview(status: PreviewStatus): status is "starting" | "ready" {
  return status === "starting" || status === "ready";
}
