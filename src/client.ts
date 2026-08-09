import type {
  ChatData,
  ChatDeletionData,
  ChatListOptions,
  CursorPage,
  ApplySourceChangesInput,
  CreateChatInput,
  DeleteChatInput,
  FrameworkId,
  ForkVersionInput,
  GenerateInput,
  ImportProjectInput,
  ImportProjectSource,
  GenerationAttemptData,
  GenerationData,
  GenerationEvent,
  GenerationEventDataMap,
  GenerationEventType,
  GenerationEventOptions,
  GenerationEventPage,
  GenerationStreamOptions,
  GenerationTaskData,
  GenerationTaskResolution,
  GenerationWaitOptions,
  IterateInput,
  MessageData,
  MessagePartDataMap,
  MessagePartInput,
  MessagePartType,
  JsonValue,
  PageOptions,
  PurgeDeletedChatsInput,
  ResolveGenerationTaskInput,
  RestoreVersionInput,
  SourceChange,
  ToolCallData,
  UserScope,
  UpdateChatInput,
  VersionData,
  VersionFile,
  VibyConfig,
} from "./types.js";
import type {
  SandboxAdapter,
  SandboxLeaseData,
  SandboxOpenOptions,
  SandboxReconnectOptions,
} from "./sandbox.js";
import type {
  AgentTraceError,
  AgentTracePart,
  AgentTraceWriter,
  AgentToolCall,
  AgentToolCallInput,
  AgentToolCallWriter,
  ProjectGenerator,
} from "./generator.js";
import type { GenerationWorkerLease, Repository } from "./repository.js";
import { AgentProjectGenerator, normalizeAgentRunnerConfig } from "./agent-runner.js";
import { PostgresRepository } from "./postgres-repository.js";
import { SkillResolver } from "./skills.js";
import {
  ConfigurationError,
  GenerationCancelledError,
  GenerationError,
  GenerationStateError,
  GenerationTaskRequiredError,
  NotFoundError,
} from "./errors.js";
import {
  assertIdentifier,
  assertPrompt,
  createId,
  errorMessage,
} from "./utils.js";
import { createSourceDownload, type DownloadArtifact } from "./download.js";
import { importProjectFiles } from "./project-import.js";
import {
  resolveSourceImport,
  type AdapterProjectImportInput,
} from "./source-import.js";
import {
  applySourceChanges,
  normalizeSourceChanges,
  preserveLockedFiles,
} from "./source-changes.js";
import {
  AgentWorkspace,
  type AgentWorkspaceCommitInput,
} from "./agent-workspace.js";
import {
  decodeChatCursor,
  decodeMessageCursor,
  decodeVersionCursor,
  encodeChatCursor,
  encodeMessageCursor,
  encodeVersionCursor,
} from "./cursors.js";
import { normalizeChatMetadata } from "./metadata.js";
import { SandboxRegistry, type SandboxSession } from "./sandbox.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_EVENT_LIMIT = 100;
const DEFAULT_WORKER_LEASE_MS = 30_000;
const DEFAULT_WORKER_HEARTBEAT_MS = 10_000;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 500;
const DEFAULT_DELETED_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DELETED_CHAT_RETENTION_MS = 10 * 365 * 24 * 60 * 60 * 1_000;

export interface GenerationWorkerOptions {
  readonly id: string;
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly pollIntervalMs?: number;
}

export interface GenerationWorkerRunOptions {
  readonly signal?: AbortSignal;
}

export interface Viby<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  forUser(scope: UserScope): ScopedViby<Framework>;
  worker(options: GenerationWorkerOptions): GenerationWorker<Framework>;
  close(): Promise<void>;
}

export type GenerationOutcome<Framework extends FrameworkId = FrameworkId> =
  | {
      readonly status: "succeeded";
      readonly generation: GenerationData;
      readonly version: Version<Framework>;
    }
  | {
      readonly status: "waiting";
      readonly generation: GenerationData;
      readonly tasks: readonly GenerationTaskData[];
    }
  | {
      readonly status: "failed";
      readonly generation: GenerationData;
      readonly error: string;
    }
  | {
      readonly status: "cancelled";
      readonly generation: GenerationData;
      readonly reason: string;
    };

interface ClientDependencies<Framework extends FrameworkId> {
  readonly repository: Repository;
  readonly generator: ProjectGenerator<Framework>;
  readonly skillResolver: SkillResolver;
}

export function createViby<const Framework extends FrameworkId>(
  config: VibyConfig<Framework>,
): Viby<Framework> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new ConfigurationError(
      "DATABASE_URL is required. Viby stores tenant-scoped chats, generations, attempts, events, versions, and files in your Postgres database.",
    );
  }

  return createVibyWithDependencies(config, {
    repository: new PostgresRepository(databaseUrl),
    generator: new AgentProjectGenerator(config.model, config.agent),
    skillResolver: new SkillResolver(config.skills),
  });
}

export function createVibyWithDependencies<const Framework extends FrameworkId>(
  config: VibyConfig<Framework>,
  dependencies: ClientDependencies<Framework>,
): Viby<Framework> {
  if (typeof config.framework !== "string" || config.framework.trim().length === 0) {
    throw new ConfigurationError("framework must be a non-empty string value.");
  }
  return new VibyClient(config, dependencies);
}

class VibyClient<Framework extends FrameworkId> implements Viby<Framework> {
  readonly framework: Framework;
  readonly #repository: Repository;
  readonly #skillResolver: SkillResolver;
  readonly #modelProvider: string;
  readonly #modelId: string;
  readonly #sandbox: SandboxAdapter | undefined;
  readonly #registry = new GenerationRunRegistry();
  readonly #sandboxes: SandboxRegistry;
  readonly #runner: GenerationRunner<Framework>;
  readonly #workers = new Set<GenerationWorker<Framework>>();
  readonly #deletedChatsMs: number | null;

  constructor(
    config: VibyConfig<Framework>,
    dependencies: ClientDependencies<Framework>,
  ) {
    this.framework = config.framework;
    this.#sandbox = config.sandbox;
    this.#repository = dependencies.repository;
    this.#deletedChatsMs = normalizeChatRetentionConfig(config.retention);
    this.#sandboxes = new SandboxRegistry(this.#repository, config.sandboxPolicy);
    this.#skillResolver = dependencies.skillResolver;
    if (typeof config.model === "string") {
      this.#modelProvider = config.model.split("/", 1)[0] || "gateway";
      this.#modelId = config.model;
    } else {
      this.#modelProvider = config.model.provider;
      this.#modelId = config.model.modelId;
    }
    this.#runner = new GenerationRunner({
      framework: this.framework,
      repository: this.#repository,
      generator: dependencies.generator,
      skillResolver: this.#skillResolver,
      registry: this.#registry,
      automatic: normalizeGenerationExecution(config.generation) === "embedded",
      modelProvider: this.#modelProvider,
      modelId: this.#modelId,
      sandbox: this.#sandbox,
      sandboxes: this.#sandboxes,
      agent: normalizeAgentRunnerConfig(config.agent),
    });
  }

  forUser(scope: UserScope): ScopedViby<Framework> {
    const normalizedScope = {
      tenantId: assertIdentifier(scope.tenantId, "tenantId"),
      userId: assertIdentifier(scope.userId, "userId"),
    };
    return new ScopedViby({
      scope: normalizedScope,
      framework: this.framework,
      repository: this.#repository,
      runner: this.#runner,
      registry: this.#registry,
      modelProvider: this.#modelProvider,
      modelId: this.#modelId,
      sandbox: this.#sandbox,
      sandboxes: this.#sandboxes,
      deletedChatsMs: this.#deletedChatsMs,
    });
  }

  worker(options: GenerationWorkerOptions): GenerationWorker<Framework> {
    const worker = new GenerationWorker(this.#runner, options);
    this.#workers.add(worker);
    return worker;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#workers].map((worker) => worker.stop()));
    await this.#registry.abortAll("Viby client closed.");
    const [sandboxes, repository] = await Promise.allSettled([
      this.#sandboxes.stopAll(),
      this.#repository.close(),
    ]);
    if (sandboxes.status === "rejected") throw sandboxes.reason;
    if (repository.status === "rejected") throw repository.reason;
  }
}

interface NormalizedGenerationWorkerOptions {
  readonly id: string;
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly pollIntervalMs: number;
}

export class GenerationWorker<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly #runner: GenerationRunner<Framework>;
  readonly #options: NormalizedGenerationWorkerOptions;
  readonly #controller = new AbortController();
  #runPromise: Promise<void> | null = null;
  #isRunning = false;

  constructor(runner: GenerationRunner<Framework>, options: GenerationWorkerOptions) {
    this.#runner = runner;
    this.#options = normalizeGenerationWorkerOptions(options);
    this.id = this.#options.id;
  }

  get running(): boolean {
    return this.#isRunning;
  }

  async runOnce(options: GenerationWorkerRunOptions = {}): Promise<boolean> {
    validateGenerationWorkerRunOptions(options);
    if (this.#runPromise) {
      throw new ConfigurationError("runOnce cannot be called while the generation worker is running.");
    }
    const signal = combineAbortSignals(this.#controller.signal, options.signal);
    signal.throwIfAborted();
    return this.#runner.runNext(this.#options, signal);
  }

  run(options: GenerationWorkerRunOptions = {}): Promise<void> {
    validateGenerationWorkerRunOptions(options);
    if (this.#runPromise) return this.#runPromise;
    const signal = combineAbortSignals(this.#controller.signal, options.signal);
    this.#isRunning = true;
    this.#runPromise = Promise.all(
      Array.from({ length: this.#options.concurrency }, () => this.#runLane(signal)),
    ).then(() => undefined).finally(() => {
      this.#isRunning = false;
    });
    return this.#runPromise;
  }

  async stop(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new DOMException("Generation worker stopped.", "AbortError"));
    }
    await this.#runPromise?.catch((error) => {
      if (!isAbortError(error)) throw error;
    });
  }

  async #runLane(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const worked = await this.#runner.runNext(this.#options, signal);
        if (!worked) await waitForPoll(this.#options.pollIntervalMs, signal);
      }
    } catch (error) {
      if (!signal.aborted && !isAbortError(error)) throw error;
    }
  }
}

interface ScopedDependencies<Framework extends FrameworkId> {
  readonly scope: UserScope;
  readonly framework: Framework;
  readonly repository: Repository;
  readonly runner: GenerationRunner<Framework>;
  readonly registry: GenerationRunRegistry;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly sandbox: SandboxAdapter | undefined;
  readonly sandboxes: SandboxRegistry;
  readonly deletedChatsMs: number | null;
}

export class ScopedViby<Framework extends FrameworkId = FrameworkId> {
  readonly scope: UserScope;
  readonly chats: ChatCollection<Framework>;
  readonly generations: GenerationCollection<Framework>;
  readonly sandboxes: SandboxCollection<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.scope = dependencies.scope;
    this.chats = new ChatCollection(dependencies);
    this.generations = new GenerationCollection(dependencies);
    this.sandboxes = new SandboxCollection(dependencies);
  }
}

export class SandboxCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async get(id: string): Promise<SandboxLeaseData<Framework>> {
    const lease = await this.#dependencies.sandboxes.get<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!lease) throw new NotFoundError("Sandbox lease");
    return lease;
  }

  reconnect(
    id: string,
    options: SandboxReconnectOptions = {},
  ): Promise<SandboxSession> {
    return this.#dependencies.sandboxes.reconnect(
      this.#dependencies.sandbox,
      this.#dependencies.scope,
      id,
      options,
    );
  }
}

export class ChatCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async create(input: CreateChatInput = {}): Promise<Chat<Framework>> {
    const title = normalizeChatTitle(input.title);
    const metadata = normalizeChatMetadata(input.metadata);
    const data = await this.#dependencies.repository.createChat(this.#dependencies.scope, {
      id: createId(),
      title,
      metadata,
      framework: this.#dependencies.framework,
    });
    return new Chat(data, this.#dependencies);
  }

  async import<Input = never>(
    input: ImportProjectInput | AdapterProjectImportInput<Input, Framework>,
  ): Promise<Chat<Framework>> {
    if (!input || !input.source) {
      throw new ConfigurationError("Project import requires files, ZIP bytes, or an adapter source.");
    }
    const adapterResult = input.source.type === "adapter"
      ? await resolveSourceImport(input as AdapterProjectImportInput<Input, Framework>, {
          ...this.#dependencies.scope,
          framework: this.#dependencies.framework,
        })
      : null;
    const title = normalizeChatTitle(input.title ?? adapterResult?.title);
    const summary = input.summary?.trim()
      || adapterResult?.summary?.trim()
      || "Imported project source.";
    if (summary.length > 2_000) {
      throw new ConfigurationError("An import summary cannot exceed 2,000 characters.");
    }
    const files = importProjectFiles(adapterResult?.source ?? input.source as ImportProjectSource, input.filePolicy);
    const metadata = normalizeChatMetadata(input.metadata);
    const imported = await this.#dependencies.repository.importChat(
      this.#dependencies.scope,
      {
        chatId: createId(),
        versionId: createId(),
        title,
        metadata,
        summary,
        framework: this.#dependencies.framework,
        files,
      },
    );
    return new Chat(imported.chat, this.#dependencies);
  }

  async get(id: string): Promise<Chat<Framework>> {
    const data = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!data) throw new NotFoundError("Chat");
    return new Chat(data, this.#dependencies);
  }

  async restore(id: string): Promise<Chat<Framework>> {
    const data = await this.#dependencies.repository.restoreChat<Framework>(
      this.#dependencies.scope,
      assertIdentifier(id, "Chat id"),
      new Date(),
    );
    return new Chat(data, this.#dependencies);
  }

  async purgeDeleted(input: PurgeDeletedChatsInput = {}): Promise<number> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Deleted chat purge options must be an object.");
    }
    const limit = normalizePageLimit(input.limit);
    return this.#dependencies.repository.purgeDeletedChats(
      this.#dependencies.scope,
      new Date(),
      limit,
    );
  }

  async list(options: ChatListOptions = {}): Promise<CursorPage<Chat<Framework>>> {
    const limit = normalizePageLimit(options.limit);
    const metadata = normalizeChatMetadata(options.metadata);
    const page = await this.#dependencies.repository.listChatPage<Framework>(
      this.#dependencies.scope,
      limit,
      decodeChatCursor(options.after),
      metadata,
    );
    const items = page.items.map((record) => new Chat(record, this.#dependencies));
    const last = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last
        ? encodeChatCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
    };
  }
}

export class GenerationCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async get(id: string): Promise<Generation<Framework>> {
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      id,
    );
    if (!generation) throw new NotFoundError("Generation");
    await assertActiveChat(this.#dependencies, generation.chatId);
    return new Generation(generation.id, generation.chatId, this.#dependencies);
  }
}

export class Chat<Framework extends FrameworkId = FrameworkId> {
  readonly #data: ChatData<Framework>;
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(data: ChatData<Framework>, dependencies: ScopedDependencies<Framework>) {
    this.#data = data;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#data.id; }
  get title(): string { return this.#data.title; }
  get metadata(): ChatData["metadata"] { return this.#data.metadata; }
  get framework(): Framework { return this.#data.framework; }
  get createdAt(): Date { return this.#data.createdAt; }
  get updatedAt(): Date { return this.#data.updatedAt; }

  async update(input: UpdateChatInput): Promise<Chat<Framework>> {
    if (!input || (input.title === undefined && input.metadata === undefined)) {
      throw new ConfigurationError("Chat update requires a title or metadata value.");
    }
    const data = await this.#dependencies.repository.updateChat<Framework>(
      this.#dependencies.scope,
      this.id,
      {
        title: input.title === undefined ? this.title : normalizeChatTitle(input.title),
        metadata: input.metadata === undefined
          ? this.metadata
          : normalizeChatMetadata(input.metadata),
      },
    );
    return new Chat(data, this.#dependencies);
  }

  async delete(input: DeleteChatInput = {}): Promise<ChatDeletionData> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Chat deletion options must be an object.");
    }
    const retentionMs = normalizeRetentionMs(input.retentionMs, this.#dependencies.deletedChatsMs);
    const deletedAt = new Date();
    return this.#dependencies.repository.deleteChat(this.#dependencies.scope, this.id, {
      deletedAt,
      purgeAfter: retentionMs === null ? null : new Date(deletedAt.getTime() + retentionMs),
    });
  }

  async start(input: GenerateInput): Promise<Generation<Framework>> {
    await this.#assertActive();
    const latest = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return this.#startFrom(input, latest);
  }

  async generate(input: GenerateInput): Promise<Version<Framework>> {
    return unwrapGenerationOutcome(await (await this.start(input)).wait());
  }

  async getGeneration(id: string): Promise<Generation<Framework>> {
    await this.#assertActive();
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      id,
    );
    if (!generation || generation.chatId !== this.id) throw new NotFoundError("Generation");
    return new Generation(generation.id, generation.chatId, this.#dependencies);
  }

  async latestVersion(): Promise<Version<Framework> | null> {
    await this.#assertActive();
    const data = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return data ? new Version(data, this.#dependencies) : null;
  }

  async getVersion(id: string): Promise<Version<Framework>> {
    await this.#assertActive();
    const data = await this.#dependencies.repository.getVersion<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!data || data.chatId !== this.id) throw new NotFoundError("Version");
    return new Version(data, this.#dependencies);
  }

  async listVersions(options: PageOptions = {}): Promise<CursorPage<Version<Framework>>> {
    await this.#assertActive();
    const limit = normalizePageLimit(options.limit);
    const page = await this.#dependencies.repository.listVersionPage<Framework>(
      this.#dependencies.scope,
      this.id,
      limit,
      decodeVersionCursor(options.after),
    );
    const items = page.items.map((record) => new Version(record, this.#dependencies));
    const last = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last ? encodeVersionCursor({ number: last.number }) : null,
    };
  }

  async listMessages(options: PageOptions = {}): Promise<CursorPage<MessageData>> {
    await this.#assertActive();
    const limit = normalizePageLimit(options.limit);
    const page = await this.#dependencies.repository.listMessagePage(
      this.#dependencies.scope,
      this.id,
      limit,
      decodeMessageCursor(options.after),
    );
    const last = page.items.at(-1);
    return {
      items: page.items,
      nextCursor: page.hasMore && last
        ? encodeMessageCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    };
  }

  async getMessage(id: string): Promise<MessageData> {
    await this.#assertActive();
    const message = await this.#dependencies.repository.getMessage(
      this.#dependencies.scope,
      this.id,
      id,
    );
    if (!message) throw new NotFoundError("Message");
    return message;
  }

  startFromVersion(
    input: GenerateInput,
    version: VersionData<Framework>,
  ): Promise<Generation<Framework>> {
    return this.#startFrom(input, version);
  }

  async generateFromVersion(
    input: GenerateInput,
    version: VersionData<Framework>,
  ): Promise<Version<Framework>> {
    return unwrapGenerationOutcome(await (await this.#startFrom(input, version)).wait());
  }

  async #startFrom(
    input: GenerateInput,
    baseVersion: VersionData<Framework> | null,
  ): Promise<Generation<Framework>> {
    await this.#assertActive();
    const prompt = assertPrompt(input.prompt);
    const generationId = createId();
    const attemptId = createId();
    await this.#dependencies.repository.createGeneration(this.#dependencies.scope, {
      id: generationId,
      attemptId,
      chatId: this.id,
      baseVersionId: baseVersion?.id ?? null,
      prompt,
      modelProvider: this.#dependencies.modelProvider,
      modelId: this.#dependencies.modelId,
    });
    this.#dependencies.runner.schedule(this.#dependencies.scope, generationId, attemptId);
    return new Generation(generationId, this.id, this.#dependencies);
  }

  async #assertActive(): Promise<void> {
    await assertActiveChat(this.#dependencies, this.id);
  }
}

export class Generation<Framework extends FrameworkId = FrameworkId> {
  readonly #id: string;
  readonly #chatId: string;
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(
    id: string,
    chatId: string,
    dependencies: ScopedDependencies<Framework>,
  ) {
    this.#id = id;
    this.#chatId = chatId;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#id; }
  get chatId(): string { return this.#chatId; }

  async data(): Promise<GenerationData> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      this.id,
    );
    if (!generation) throw new NotFoundError("Generation");
    return generation;
  }

  async attempts(): Promise<GenerationAttemptData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listGenerationAttempts(
      this.#dependencies.scope,
      this.id,
    );
  }

  async tasks(): Promise<GenerationTaskData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listGenerationTasks(
      this.#dependencies.scope,
      this.id,
    );
  }

  async toolCalls(): Promise<ToolCallData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listToolCalls(
      this.#dependencies.scope,
      this.id,
    );
  }

  async events(options: GenerationEventOptions = {}): Promise<GenerationEventPage> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const after = normalizeCursor(options.after);
    const limit = options.limit ?? DEFAULT_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ConfigurationError("Generation event limit must be an integer between 1 and 500.");
    }
    const events = await this.#dependencies.repository.listGenerationEvents(
      this.#dependencies.scope,
      this.id,
      after,
      limit,
    );
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? null,
    };
  }

  async *stream(options: GenerationStreamOptions = {}): AsyncGenerator<GenerationEvent> {
    let cursor = normalizeCursor(options.after);
    const pollIntervalMs = normalizePollInterval(options.pollIntervalMs);

    while (true) {
      options.signal?.throwIfAborted();
      const page = await this.events({ after: cursor, limit: DEFAULT_EVENT_LIMIT });
      for (const event of page.events) {
        cursor = event.cursor;
        yield event;
      }
      if (page.events.length === DEFAULT_EVENT_LIMIT) continue;

      const generation = await this.data();
      if (isSettled(generation.status)) {
        const finalPage = await this.events({ after: cursor, limit: DEFAULT_EVENT_LIMIT });
        if (finalPage.events.length > 0) {
          for (const event of finalPage.events) {
            cursor = event.cursor;
            yield event;
          }
          continue;
        }
        return;
      }
      await waitForPoll(pollIntervalMs, options.signal);
    }
  }

  async wait(options: GenerationWaitOptions = {}): Promise<GenerationOutcome<Framework>> {
    const pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
    while (true) {
      options.signal?.throwIfAborted();
      const generation = await this.data();
      switch (generation.status) {
        case "succeeded": {
          const version = await this.#dependencies.repository.getVersionByGeneration<Framework>(
            this.#dependencies.scope,
            this.id,
          );
          if (!version) throw new NotFoundError("Generated version");
          return {
            status: "succeeded",
            generation,
            version: new Version(version, this.#dependencies),
          };
        }
        case "waiting":
          return {
            status: "waiting",
            generation,
            tasks: (await this.tasks()).filter((task) => task.status === "pending"),
          };
        case "failed":
          return {
            status: "failed",
            generation,
            error: generation.error ?? "Generation failed.",
          };
        case "cancelled":
          return {
            status: "cancelled",
            generation,
            reason: generation.error ?? "Generation was cancelled.",
          };
        default:
          await waitForPoll(pollIntervalMs, options.signal);
      }
    }
  }

  async cancel(reason = "Cancelled by user."): Promise<GenerationData> {
    const normalizedReason = assertReason(reason);
    const changed = await this.#dependencies.repository.cancelGeneration(
      this.#dependencies.scope,
      this.id,
      normalizedReason,
    );
    if (changed) this.#dependencies.registry.abort(this.id, normalizedReason);
    return this.data();
  }

  async retry(): Promise<this> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (this.#dependencies.registry.has(this.id)) {
      throw new GenerationStateError(this.id, "Generation already has an active local attempt.");
    }
    const attempt = await this.#dependencies.repository.createGenerationAttempt(
      this.#dependencies.scope,
      { id: createId(), generationId: this.id, reason: "retry" },
    );
    this.#dependencies.runner.schedule(this.#dependencies.scope, this.id, attempt.id);
    return this;
  }

  async resume(): Promise<this> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (this.#dependencies.registry.has(this.id)) {
      throw new GenerationStateError(this.id, "Generation already has an active local attempt.");
    }
    const attempt = await this.#dependencies.repository.createGenerationAttempt(
      this.#dependencies.scope,
      { id: createId(), generationId: this.id, reason: "resume" },
    );
    this.#dependencies.runner.schedule(this.#dependencies.scope, this.id, attempt.id);
    return this;
  }

  async resolve(input: ResolveGenerationTaskInput): Promise<this> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (this.#dependencies.registry.has(this.id)) {
      throw new GenerationStateError(this.id, "Generation already has an active local attempt.");
    }
    const tasks = await this.tasks();
    const task = tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) throw new NotFoundError("Generation task");
    validateResolution(task, input.resolution);
    const attempt = await this.#dependencies.repository.resolveGenerationTask(
      this.#dependencies.scope,
      {
        generationId: this.id,
        taskId: task.id,
        attemptId: createId(),
        resolution: input.resolution,
        resolutionMessage: renderResolution(input.resolution),
      },
    );
    this.#dependencies.runner.schedule(this.#dependencies.scope, this.id, attempt.id);
    return this;
  }
}

export class Version<Framework extends FrameworkId = FrameworkId> {
  readonly #data: VersionData<Framework>;
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(data: VersionData<Framework>, dependencies: ScopedDependencies<Framework>) {
    this.#data = data;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#data.id; }
  get chatId(): string { return this.#data.chatId; }
  get generationId(): string | null { return this.#data.generationId; }
  get parentVersionId(): string | null { return this.#data.parentVersionId; }
  get number(): number { return this.#data.number; }
  get origin(): VersionData["origin"] { return this.#data.origin; }
  get framework(): Framework { return this.#data.framework; }
  get title(): string { return this.#data.title; }
  get summary(): string { return this.#data.summary; }
  get createdAt(): Date { return this.#data.createdAt; }

  async startIteration(input: IterateInput): Promise<Generation<Framework>> {
    const chatData = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!chatData) throw new NotFoundError("Chat");
    return new Chat(chatData, this.#dependencies).startFromVersion(input, this.#data);
  }

  async iterate(input: IterateInput): Promise<Version<Framework>> {
    const chatData = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!chatData) throw new NotFoundError("Chat");
    return new Chat(chatData, this.#dependencies).generateFromVersion(input, this.#data);
  }

  async apply(input: ApplySourceChangesInput): Promise<Version<Framework>> {
    if (!input) throw new ConfigurationError("A source change set is required.");
    const changes = normalizeSourceChanges(input.changes);
    const files = applySourceChanges(await this.files(), changes);
    const title = normalizeVersionTitle(input.title ?? this.title);
    const summary = input.summary?.trim()
      || `Applied ${changes.length} source change${changes.length === 1 ? "" : "s"}.`;
    if (summary.length > 2_000) {
      throw new ConfigurationError("A version summary cannot exceed 2,000 characters.");
    }
    const data = await this.#dependencies.repository.createSourceVersion(
      this.#dependencies.scope,
      {
        id: createId(),
        chatId: this.chatId,
        parentVersionId: this.id,
        origin: "edited",
        framework: this.framework,
        title,
        summary,
        files,
        changes,
      },
    );
    return new Version(data, this.#dependencies);
  }

  async fork(input: ForkVersionInput = {}): Promise<Chat<Framework>> {
    const title = normalizeVersionTitle(input.title ?? `${this.title} fork`);
    const summary = normalizeVersionSummary(
      input.summary,
      `Forked from version ${this.number}.`,
    );
    const sourceChat = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!sourceChat) throw new NotFoundError("Chat");
    const forked = await this.#dependencies.repository.forkVersion(
      this.#dependencies.scope,
      {
        chatId: createId(),
        versionId: createId(),
        sourceVersionId: this.id,
        title,
        metadata: input.metadata === undefined
          ? sourceChat.metadata
          : normalizeChatMetadata(input.metadata),
        summary,
        framework: this.framework,
      },
    );
    return new Chat(forked.chat, this.#dependencies);
  }

  async restore(input: RestoreVersionInput = {}): Promise<Version<Framework>> {
    const title = normalizeVersionTitle(input.title ?? this.title);
    const summary = normalizeVersionSummary(
      input.summary,
      `Restored source from version ${this.number}.`,
    );
    const data = await this.#dependencies.repository.restoreVersion(
      this.#dependencies.scope,
      {
        id: createId(),
        chatId: this.chatId,
        sourceVersionId: this.id,
        title,
        summary,
        framework: this.framework,
      },
    );
    return new Version(data, this.#dependencies);
  }

  async files(): Promise<VersionFile[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.getVersionFiles(this.#dependencies.scope, this.id);
  }

  async changes(): Promise<SourceChange[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.getVersionChanges(this.#dependencies.scope, this.id);
  }

  async workspace(): Promise<AgentWorkspace<Version<Framework>>> {
    return new AgentWorkspace(
      await this.files(),
      (changes, input: AgentWorkspaceCommitInput) => this.apply({ ...input, changes }),
    );
  }

  async sandbox(options: SandboxOpenOptions = {}): Promise<SandboxSession> {
    return this.#dependencies.sandboxes.open(
      this.#dependencies.sandbox,
      this.#dependencies.scope,
      this.#data,
      await this.files(),
      options,
    );
  }

  async generation(): Promise<GenerationData | null> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (!this.generationId) return null;
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      this.generationId,
    );
    if (!generation) throw new NotFoundError("Generation");
    return generation;
  }

  async download(): Promise<DownloadArtifact> {
    return createSourceDownload(this.title, await this.files());
  }
}

async function assertActiveChat<Framework extends FrameworkId>(
  dependencies: ScopedDependencies<Framework>,
  chatId: string,
): Promise<void> {
  const chat = await dependencies.repository.getChat(dependencies.scope, chatId);
  if (!chat) throw new NotFoundError("Chat");
}

function normalizeChatTitle(value: string | undefined): string {
  const title = value?.trim() || "Untitled";
  if (title.length > 200) {
    throw new ConfigurationError("A chat title cannot exceed 200 characters.");
  }
  return title;
}

function normalizePageLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ConfigurationError("Page limit must be an integer between 1 and 100.");
  }
  return limit;
}

function normalizeVersionTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 120) {
    throw new ConfigurationError("A version title must contain between 1 and 120 characters.");
  }
  return title;
}

function normalizeVersionSummary(value: string | undefined, fallback: string): string {
  const summary = value?.trim() || fallback;
  if (summary.length > 2_000) {
    throw new ConfigurationError("A version summary cannot exceed 2,000 characters.");
  }
  return summary;
}

interface RunnerDependencies<Framework extends FrameworkId> {
  readonly framework: Framework;
  readonly repository: Repository;
  readonly generator: ProjectGenerator<Framework>;
  readonly skillResolver: SkillResolver;
  readonly registry: GenerationRunRegistry;
  readonly automatic: boolean;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly sandbox: SandboxAdapter | undefined;
  readonly sandboxes: SandboxRegistry;
  readonly agent: ReturnType<typeof normalizeAgentRunnerConfig>;
}

class GenerationRunner<Framework extends FrameworkId> {
  readonly #dependencies: RunnerDependencies<Framework>;
  readonly #embeddedWorkerId = `embedded-${createId()}`;

  constructor(dependencies: RunnerDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  schedule(scope: UserScope, generationId: string, attemptId: string): void {
    if (!this.#dependencies.automatic) return;
    void this.#dependencies.registry.start(
      generationId,
      async (signal) => {
        const lease = await this.#claim({
          id: this.#embeddedWorkerId,
          concurrency: 1,
          leaseMs: DEFAULT_WORKER_LEASE_MS,
          heartbeatMs: DEFAULT_WORKER_HEARTBEAT_MS,
          pollIntervalMs: DEFAULT_WORKER_POLL_INTERVAL_MS,
        }, attemptId);
        if (!lease || lease.scope.tenantId !== scope.tenantId || lease.scope.userId !== scope.userId) {
          return;
        }
        await this.#executeWithHeartbeat(lease, DEFAULT_WORKER_LEASE_MS, DEFAULT_WORKER_HEARTBEAT_MS, signal, true);
      },
    ).catch(() => undefined);
  }

  async runNext(options: NormalizedGenerationWorkerOptions, signal: AbortSignal): Promise<boolean> {
    const lease = await this.#claim(options);
    if (!lease) return false;
    await this.#dependencies.registry.start(
      lease.generationId,
      (runSignal) => this.#executeWithHeartbeat(
        lease,
        options.leaseMs,
        options.heartbeatMs,
        combineAbortSignals(runSignal, signal),
        false,
      ),
    );
    return true;
  }

  #claim(
    options: NormalizedGenerationWorkerOptions,
    attemptId?: string,
  ): Promise<GenerationWorkerLease | null> {
    return this.#dependencies.repository.claimGenerationAttempt({
      workerId: options.id,
      leaseToken: createId(),
      leaseMs: options.leaseMs,
      framework: this.#dependencies.framework,
      modelProvider: this.#dependencies.modelProvider,
      modelId: this.#dependencies.modelId,
      ...(attemptId ? { attemptId } : {}),
    });
  }

  async #executeWithHeartbeat(
    lease: GenerationWorkerLease,
    leaseMs: number,
    heartbeatMs: number,
    signal: AbortSignal,
    cancelOnAbort: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = this.#heartbeat(lease, leaseMs, heartbeatMs, controller);
    try {
      await this.#execute(lease, controller.signal, cancelOnAbort);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Generation attempt completed.", "AbortError"));
      }
      signal.removeEventListener("abort", forwardAbort);
      await heartbeat;
    }
  }

  async #heartbeat(
    lease: GenerationWorkerLease,
    leaseMs: number,
    heartbeatMs: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        await waitForPoll(heartbeatMs, controller.signal);
        const renewed = await this.#dependencies.repository.heartbeatGenerationAttempt(
          lease,
          leaseMs,
        );
        if (!renewed) {
          throw new GenerationWorkerLeaseLostError(lease.generationId, lease.attemptId);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort(error instanceof GenerationWorkerLeaseLostError
          ? error
          : new GenerationWorkerLeaseLostError(lease.generationId, lease.attemptId));
      }
    }
  }

  async #execute(
    lease: GenerationWorkerLease,
    signal: AbortSignal,
    cancelOnAbort: boolean,
  ): Promise<void> {
    const { scope, generationId, attemptId, leaseToken } = lease;
    let sandbox: SandboxSession | undefined;
    const trace = new DurableAgentTrace(async (type, data) => {
      signal.throwIfAborted();
      await this.#dependencies.repository.appendGenerationEvent(scope, {
        generationId,
        attemptId,
        leaseToken,
        type,
        data,
      });
    });
    const toolCalls = new DurableAgentToolCalls(
      this.#dependencies.repository,
      scope,
      generationId,
      attemptId,
      leaseToken,
      trace,
    );
    try {
      signal.throwIfAborted();

      const generation = await this.#dependencies.repository.getGeneration(scope, generationId);
      if (!generation) throw new NotFoundError("Generation");
      const chat = await this.#dependencies.repository.getChat<Framework>(scope, generation.chatId);
      if (!chat) throw new NotFoundError("Chat");

      let skills = await this.#dependencies.repository.getGenerationSkills(scope, generationId);
      if (skills === null) {
        skills = await this.#dependencies.skillResolver.resolveForPrompt(generation.prompt);
        await this.#dependencies.repository.attachGenerationSkills(
          scope,
          generationId,
          attemptId,
          leaseToken,
          skills,
        );
      }

      const [messages, previousFiles, tasks] = await Promise.all([
        this.#dependencies.repository.listMessages(scope, generation.chatId),
        generation.baseVersionId
          ? this.#dependencies.repository.getVersionFiles(scope, generation.baseVersionId)
          : Promise.resolve([]),
        this.#dependencies.repository.listGenerationTasks(scope, generationId),
      ]);
      signal.throwIfAborted();
      if (generation.baseVersionId && this.#dependencies.sandbox) {
        sandbox = await this.#dependencies.sandboxes.open(
          this.#dependencies.sandbox,
          scope,
          {
            id: generation.baseVersionId,
            chatId: generation.chatId,
            framework: chat.framework,
          },
          previousFiles,
          {
            timeoutMs: this.#dependencies.agent.maxDurationMs,
            ports: this.#dependencies.agent.sandboxPorts,
            signal,
          },
          {
            approvedActionKeys: tasks.flatMap((task) => (
              task.kind === "permission"
              && task.status === "resolved"
              && task.resolution?.kind === "permission"
              && task.resolution.decision === "allow"
              && task.proposedAction
                ? [task.proposedAction.idempotencyKey]
                : []
            )),
            deniedActionKeys: tasks.flatMap((task) => (
              task.kind === "permission"
              && task.status === "resolved"
              && task.resolution?.kind === "permission"
              && task.resolution.decision === "deny"
              && task.proposedAction
                ? [task.proposedAction.idempotencyKey]
                : []
            )),
          },
        );
      }

      const output = await this.#dependencies.generator.generate(
        {
          framework: chat.framework,
          prompt: generation.prompt,
          messages: messages.filter((message) => message.generationId !== generationId),
          previousFiles,
          skills,
          tasks,
          ...(sandbox ? { sandbox } : {}),
        },
        {
          signal,
          trace,
          toolCalls,
          onDelta: async (delta) => {
            signal.throwIfAborted();
            await this.#dependencies.repository.appendGenerationEvent(scope, {
              generationId,
              attemptId,
              leaseToken,
              type: "output.delta",
              data: { delta },
            });
          },
        },
      );
      signal.throwIfAborted();
      await trace.finish();

      if (output.kind === "task") {
        const inputTokens = output.usage.inputTokens ?? null;
        const outputTokens = output.usage.outputTokens ?? null;
        const totalTokens = output.usage.totalTokens ?? null;
        await this.#dependencies.repository.pauseGeneration(scope, {
          generationId,
          attemptId,
          leaseToken,
          taskId: createId(),
          task: output.task,
          assistantParts: [
            ...trace.completedParts(),
            { type: "status", data: { message: output.task.message, state: "waiting" } },
            { type: "text", data: { text: output.task.message } },
            usageMessagePart(inputTokens, outputTokens, totalTokens),
          ],
          inputTokens,
          outputTokens,
          totalTokens,
          finishReason: output.finishReason,
        });
        return;
      }

      const files = output.kind === "changes"
        ? applySourceChanges(previousFiles, output.changes)
        : preserveLockedFiles(previousFiles, output.files);
      const changes = output.kind === "changes" ? output.changes : null;
      const inputTokens = output.usage.inputTokens ?? null;
      const outputTokens = output.usage.outputTokens ?? null;
      const totalTokens = output.usage.totalTokens ?? null;
      await this.#dependencies.repository.completeGeneration(scope, {
        generationId,
        attemptId,
        leaseToken,
        parentVersionId: generation.baseVersionId,
        framework: chat.framework,
        title: output.title,
        summary: output.summary,
        files,
        changes,
        assistantMessage: output.summary,
        assistantParts: [
          ...mergeTraceAndFileEditParts(trace.completedParts(), files, changes),
          { type: "text", data: { text: output.summary } },
          usageMessagePart(inputTokens, outputTokens, totalTokens),
        ],
        inputTokens,
        outputTokens,
        totalTokens,
        finishReason: output.finishReason,
      });
    } catch (error) {
      await trace.failOpen({
        message: errorMessage(error),
        code: "generation_failed",
        retryable: true,
      }).catch(() => undefined);
      if (signal.aborted || isAbortError(error)) {
        if (!cancelOnAbort || signal.reason instanceof GenerationWorkerLeaseLostError) return;
        await this.#dependencies.repository.cancelGeneration(
          scope,
          generationId,
          errorMessage(signal.reason ?? error),
        ).catch(() => false);
        return;
      }
      if (error instanceof GenerationStateError) return;
      await this.#dependencies.repository.failGenerationAttempt(
        scope,
        generationId,
        attemptId,
        leaseToken,
        errorMessage(error),
      ).catch(() => undefined);
    } finally {
      await sandbox?.stop().catch(() => undefined);
    }
  }
}

type AgentPartEventType = Extract<GenerationEventType, `part.${string}`>;
type AgentPartEventAppend = <Type extends AgentPartEventType>(
  type: Type,
  data: GenerationEventDataMap[Type],
) => Promise<void>;

interface TraceEntry<Type extends MessagePartType = MessagePartType> {
  readonly id: string;
  readonly position: number;
  readonly type: Type;
  state: "active" | "completed" | "failed";
  data?: MessagePartDataMap[Type];
}

class DurableAgentTrace implements AgentTraceWriter {
  readonly #append: AgentPartEventAppend;
  readonly #entries: TraceEntry[] = [];
  #closed = false;

  constructor(append: AgentPartEventAppend) {
    this.#append = append;
  }

  async start<Type extends MessagePartType>(type: Type): Promise<AgentTracePart<Type>> {
    if (this.#closed) throw new GenerationStateError("trace", "The agent trace is closed.");
    const entry: TraceEntry<Type> = {
      id: createId(),
      position: this.#entries.length,
      type,
      state: "active",
    };
    await this.#append("part.started", {
      partId: entry.id,
      position: entry.position,
      type,
    });
    this.#entries.push(entry as TraceEntry);
    return {
      id: entry.id,
      type,
      delta: async (delta) => {
        this.#assertActive(entry);
        await this.#append("part.delta", { partId: entry.id, delta });
      },
      complete: async (data) => {
        this.#assertActive(entry);
        await this.#append("part.completed", {
          part: { id: entry.id, type, data } as MessagePartInput & { readonly id: string },
        });
        entry.data = data;
        entry.state = "completed";
      },
      fail: async (error) => {
        await this.#fail(entry, error);
      },
    };
  }

  completedParts(): MessagePartInput[] {
    return this.#entries.flatMap((entry) => entry.state === "completed"
      ? [{ id: entry.id, type: entry.type, data: entry.data! } as MessagePartInput]
      : []);
  }

  async finish(): Promise<void> {
    await this.failOpen({
      message: "The agent stopped before completing this trace part.",
      code: "incomplete_part",
      retryable: false,
    });
    this.#closed = true;
  }

  async failOpen(error: AgentTraceError): Promise<void> {
    for (const entry of this.#entries) {
      if (entry.state === "active") await this.#fail(entry, error);
    }
  }

  #assertActive(entry: TraceEntry): void {
    if (this.#closed || entry.state !== "active") {
      throw new GenerationStateError("trace", `Trace part ${entry.id} is no longer active.`);
    }
  }

  async #fail(entry: TraceEntry, error: AgentTraceError): Promise<void> {
    this.#assertActive(entry);
    await this.#append("part.failed", {
      partId: entry.id,
      error: {
        message: error.message,
        code: error.code ?? null,
        retryable: error.retryable ?? false,
      },
    });
    entry.state = "failed";
  }
}

class DurableAgentToolCalls implements AgentToolCallWriter {
  readonly #repository: Repository;
  readonly #scope: UserScope;
  readonly #generationId: string;
  readonly #attemptId: string;
  readonly #leaseToken: string;
  readonly #trace: AgentTraceWriter;

  constructor(
    repository: Repository,
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    trace: AgentTraceWriter,
  ) {
    this.#repository = repository;
    this.#scope = scope;
    this.#generationId = generationId;
    this.#attemptId = attemptId;
    this.#leaseToken = leaseToken;
    this.#trace = trace;
  }

  async start<Arguments extends JsonValue, Result extends JsonValue>(
    input: AgentToolCallInput<Arguments>,
  ): Promise<AgentToolCall<Arguments, Result>> {
    const created = await this.#repository.createToolCall(this.#scope, {
      id: createId(),
      generationId: this.#generationId,
      attemptId: this.#attemptId,
      leaseToken: this.#leaseToken,
      providerCallId: input.providerCallId,
      name: input.name,
      effect: input.effect,
      arguments: input.arguments,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    const tracePart = await this.#trace.start("tool-call");
    const initial = created.toolCall as ToolCallData<Arguments, Result>;
    let traceSettled = initial.status !== "pending";
    if (!created.created && initial.status !== "pending") {
      await tracePart.complete({
        toolCallId: initial.id,
        name: initial.name,
        state: initial.status === "succeeded" ? "completed" : "failed",
      });
    }

    const settleTrace = async (toolCall: ToolCallData): Promise<void> => {
      if (traceSettled) return;
      await tracePart.complete({
        toolCallId: toolCall.id,
        name: toolCall.name,
        state: toolCall.status === "succeeded" ? "completed" : "failed",
      });
      traceSettled = true;
    };
    return {
      toolCall: initial,
      created: created.created,
      succeed: async (result) => {
        const toolCall = await this.#repository.completeToolCall(this.#scope, {
          id: initial.id,
          generationId: this.#generationId,
          attemptId: initial.attemptId,
          leaseToken: this.#leaseToken,
          result,
        }) as ToolCallData<Arguments, Result>;
        await settleTrace(toolCall);
        return toolCall;
      },
      fail: async (error) => {
        const toolCall = await this.#repository.failToolCall(this.#scope, {
          id: initial.id,
          generationId: this.#generationId,
          attemptId: initial.attemptId,
          leaseToken: this.#leaseToken,
          error,
        }) as ToolCallData<Arguments, Result>;
        await settleTrace(toolCall);
        return toolCall;
      },
    };
  }
}

function mergeTraceAndFileEditParts(
  traceParts: readonly MessagePartInput[],
  files: readonly VersionFile[],
  changes: readonly SourceChange[] | null,
): MessagePartInput[] {
  const tracedEdits = new Set(traceParts.flatMap((part) => (
    part.type === "file-edit" ? [fileEditPartKey(part)] : []
  )));
  return [
    ...traceParts,
    ...fileEditMessageParts(files, changes).filter((part) => !tracedEdits.has(fileEditPartKey(part))),
  ];
}

function fileEditPartKey(part: MessagePartInput<"file-edit">): string {
  return part.data.operation === "move"
    ? `move:${part.data.from}:${part.data.to}`
    : `${part.data.operation}:${part.data.path}`;
}

function fileEditMessageParts(
  files: readonly VersionFile[],
  changes: readonly SourceChange[] | null,
): MessagePartInput<"file-edit">[] {
  if (!changes) {
    return files.map((file) => ({
      type: "file-edit",
      data: { operation: "write", path: file.path },
    }));
  }
  return changes.map((change) => {
    switch (change.type) {
      case "write":
        return { type: "file-edit", data: { operation: "write", path: change.path } };
      case "delete":
        return { type: "file-edit", data: { operation: "delete", path: change.path } };
      case "move":
        return {
          type: "file-edit",
          data: { operation: "move", from: change.from, to: change.to },
        };
    }
  });
}

function usageMessagePart(
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
): MessagePartInput<"usage"> {
  return {
    type: "usage",
    data: { inputTokens, outputTokens, totalTokens },
  };
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

class GenerationRunRegistry {
  readonly #runs = new Map<string, ActiveRun>();

  has(generationId: string): boolean {
    return this.#runs.has(generationId);
  }

  start(
    generationId: string,
    execute: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.#runs.has(generationId)) {
      throw new GenerationStateError(generationId, "Generation already has an active local attempt.");
    }
    const controller = new AbortController();
    const run: ActiveRun = {
      controller,
      promise: Promise.resolve()
        .then(() => execute(controller.signal))
        .finally(() => {
          if (this.#runs.get(generationId) === run) this.#runs.delete(generationId);
        }),
    };
    this.#runs.set(generationId, run);
    return run.promise;
  }

  abort(generationId: string, reason: string): boolean {
    const run = this.#runs.get(generationId);
    if (!run) return false;
    run.controller.abort(new DOMException(reason, "AbortError"));
    return true;
  }

  async abortAll(reason: string): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) run.controller.abort(new DOMException(reason, "AbortError"));
    await Promise.allSettled(runs.map((run) => run.promise));
  }
}

function unwrapGenerationOutcome<Framework extends FrameworkId>(
  outcome: GenerationOutcome<Framework>,
): Version<Framework> {
  switch (outcome.status) {
    case "succeeded":
      return outcome.version;
    case "waiting":
      throw new GenerationTaskRequiredError(
        outcome.generation.id,
        outcome.tasks.map((task) => task.id),
      );
    case "failed":
      throw new GenerationError(outcome.generation.id, outcome.error);
    case "cancelled":
      throw new GenerationCancelledError(outcome.generation.id, outcome.reason);
  }
}

function validateResolution(task: GenerationTaskData, resolution: GenerationTaskResolution): void {
  if (task.status !== "pending") {
    throw new GenerationStateError(task.generationId, `Task ${task.id} is already resolved.`);
  }
  if (task.kind !== resolution.kind) {
    throw new ConfigurationError(
      `Task ${task.id} requires a ${task.kind} resolution, not ${resolution.kind}.`,
    );
  }
  switch (resolution.kind) {
    case "plan":
      if (resolution.decision === "revise" && !resolution.feedback?.trim()) {
        throw new ConfigurationError("A revised plan requires feedback.");
      }
      break;
    case "question":
      if (!resolution.answer.trim()) {
        throw new ConfigurationError("A question resolution requires a non-empty answer.");
      }
      break;
    case "permission":
      if (resolution.note !== undefined && !resolution.note.trim()) {
        throw new ConfigurationError("A permission note cannot be empty when provided.");
      }
      break;
  }
}

function renderResolution(resolution: GenerationTaskResolution): string {
  switch (resolution.kind) {
    case "plan":
      return resolution.decision === "approve"
        ? "Plan approved. Continue with the proposed steps."
        : `Revise the plan with this feedback: ${resolution.feedback}`;
    case "question":
      return `Answer to the requested question: ${resolution.answer.trim()}`;
    case "permission":
      return [
        `Permission ${resolution.decision === "allow" ? "granted" : "denied"}.`,
        resolution.note?.trim(),
      ].filter(Boolean).join(" ");
  }
}

function normalizeCursor(cursor: string | undefined): string {
  if (cursor === undefined) return "0";
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) {
    throw new ConfigurationError("Generation event cursor must be a non-negative integer string.");
  }
  return cursor;
}

function normalizePollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(interval) || interval < 10 || interval > 60_000) {
    throw new ConfigurationError("Poll interval must be an integer between 10 and 60000 milliseconds.");
  }
  return interval;
}

function normalizeGenerationExecution(
  value: VibyConfig["generation"],
): "embedded" | "worker" {
  if (value === undefined) return "embedded";
  if (!value || typeof value !== "object") {
    throw new ConfigurationError("generation must be an object.");
  }
  const execution = value.execution ?? "embedded";
  if (execution !== "embedded" && execution !== "worker") {
    throw new ConfigurationError("generation.execution must be embedded or worker.");
  }
  return execution;
}

function normalizeRetentionMs(
  value: number | null | undefined,
  fallback: number | null,
): number | null {
  const retention = value === undefined ? fallback : value;
  if (retention === null) return null;
  if (!Number.isInteger(retention) || retention < 0 || retention > MAX_DELETED_CHAT_RETENTION_MS) {
    throw new ConfigurationError(
      `Deleted chat retention must be null or an integer between 0 and ${MAX_DELETED_CHAT_RETENTION_MS} milliseconds.`,
    );
  }
  return retention;
}

function normalizeChatRetentionConfig(value: VibyConfig["retention"]): number | null {
  if (value === undefined) return DEFAULT_DELETED_CHAT_RETENTION_MS;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("retention must be an object.");
  }
  return normalizeRetentionMs(value.deletedChatsMs, DEFAULT_DELETED_CHAT_RETENTION_MS);
}

function normalizeGenerationWorkerOptions(
  options: GenerationWorkerOptions,
): NormalizedGenerationWorkerOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Generation worker options must be an object.");
  }
  const id = assertIdentifier(options.id, "Generation worker id");
  const concurrency = options.concurrency ?? 1;
  const leaseMs = options.leaseMs ?? DEFAULT_WORKER_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.min(DEFAULT_WORKER_HEARTBEAT_MS, leaseMs / 3);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new ConfigurationError("Generation worker concurrency must be an integer between 1 and 32.");
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 900_000) {
    throw new ConfigurationError("Generation worker leaseMs must be an integer between 100 and 900000.");
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 25 || heartbeatMs >= leaseMs / 2) {
    throw new ConfigurationError("Generation worker heartbeatMs must be at least 25 and less than half leaseMs.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
    throw new ConfigurationError("Generation worker pollIntervalMs must be an integer between 10 and 60000.");
  }
  return { id, concurrency, leaseMs, heartbeatMs, pollIntervalMs };
}

function validateGenerationWorkerRunOptions(options: GenerationWorkerRunOptions): void {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Generation worker run options must be an object.");
  }
}

function assertReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new ConfigurationError("Cancellation reason cannot be empty.");
  if (normalized.length > 2_000) {
    throw new ConfigurationError("Cancellation reason cannot exceed 2000 characters.");
  }
  return normalized;
}

function isSettled(status: GenerationData["status"]): boolean {
  return status === "waiting"
    || status === "succeeded"
    || status === "failed"
    || status === "cancelled";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

class GenerationWorkerLeaseLostError extends Error {
  constructor(generationId: string, attemptId: string) {
    super(`Generation ${generationId} attempt ${attemptId} lost its worker lease.`);
    this.name = "GenerationWorkerLeaseLostError";
  }
}

function combineAbortSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  if (!second) return first;
  const controller = new AbortController();
  const abortFirst = () => abort(first.reason);
  const abortSecond = () => abort(second.reason);
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    first.removeEventListener("abort", abortFirst);
    second.removeEventListener("abort", abortSecond);
  };
  if (first.aborted) abort(first.reason);
  else if (second.aborted) abort(second.reason);
  else {
    first.addEventListener("abort", abortFirst, { once: true });
    second.addEventListener("abort", abortSecond, { once: true });
  }
  return controller.signal;
}

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
