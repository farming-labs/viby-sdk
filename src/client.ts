import type {
  ChatData,
  CursorPage,
  ApplySourceChangesInput,
  CreateChatInput,
  FrameworkId,
  ForkVersionInput,
  GenerateInput,
  ImportProjectInput,
  GenerationAttemptData,
  GenerationData,
  GenerationEvent,
  GenerationEventOptions,
  GenerationEventPage,
  GenerationStreamOptions,
  GenerationTaskData,
  GenerationTaskResolution,
  GenerationWaitOptions,
  IterateInput,
  MessageData,
  PageOptions,
  ResolveGenerationTaskInput,
  RestoreVersionInput,
  UserScope,
  UpdateChatInput,
  VersionData,
  VersionFile,
  VibyConfig,
} from "./types.js";
import type { ProjectGenerator } from "./generator.js";
import type { Repository } from "./repository.js";
import { AiProjectGenerator } from "./generator.js";
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
import { applySourceChanges } from "./source-changes.js";
import {
  decodeChatCursor,
  decodeMessageCursor,
  decodeVersionCursor,
  encodeChatCursor,
  encodeMessageCursor,
  encodeVersionCursor,
} from "./cursors.js";
import { normalizeChatMetadata } from "./metadata.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_EVENT_LIMIT = 100;

export interface Viby<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  forUser(scope: UserScope): ScopedViby<Framework>;
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
    generator: new AiProjectGenerator(config.model),
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
  readonly #registry = new GenerationRunRegistry();
  readonly #runner: GenerationRunner<Framework>;

  constructor(
    config: VibyConfig<Framework>,
    dependencies: ClientDependencies<Framework>,
  ) {
    this.framework = config.framework;
    this.#repository = dependencies.repository;
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
    });
  }

  async close(): Promise<void> {
    await this.#registry.abortAll("Viby client closed.");
    await this.#repository.close();
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
}

export class ScopedViby<Framework extends FrameworkId = FrameworkId> {
  readonly scope: UserScope;
  readonly chats: ChatCollection<Framework>;
  readonly generations: GenerationCollection<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.scope = dependencies.scope;
    this.chats = new ChatCollection(dependencies);
    this.generations = new GenerationCollection(dependencies);
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

  async import(input: ImportProjectInput): Promise<Chat<Framework>> {
    if (!input || !input.source) {
      throw new ConfigurationError("Project import requires a files or ZIP source.");
    }
    const title = normalizeChatTitle(input.title);
    const summary = input.summary?.trim() || "Imported project source.";
    if (summary.length > 2_000) {
      throw new ConfigurationError("An import summary cannot exceed 2,000 characters.");
    }
    const files = importProjectFiles(input.source);
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

  async list(options: PageOptions = {}): Promise<CursorPage<Chat<Framework>>> {
    const limit = normalizePageLimit(options.limit);
    const page = await this.#dependencies.repository.listChatPage<Framework>(
      this.#dependencies.scope,
      limit,
      decodeChatCursor(options.after),
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

  async start(input: GenerateInput): Promise<Generation<Framework>> {
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
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      id,
    );
    if (!generation || generation.chatId !== this.id) throw new NotFoundError("Generation");
    return new Generation(generation.id, generation.chatId, this.#dependencies);
  }

  async latestVersion(): Promise<Version<Framework> | null> {
    const data = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return data ? new Version(data, this.#dependencies) : null;
  }

  async getVersion(id: string): Promise<Version<Framework>> {
    const data = await this.#dependencies.repository.getVersion<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!data || data.chatId !== this.id) throw new NotFoundError("Version");
    return new Version(data, this.#dependencies);
  }

  async listVersions(options: PageOptions = {}): Promise<CursorPage<Version<Framework>>> {
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
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      this.id,
    );
    if (!generation) throw new NotFoundError("Generation");
    return generation;
  }

  attempts(): Promise<GenerationAttemptData[]> {
    return this.#dependencies.repository.listGenerationAttempts(
      this.#dependencies.scope,
      this.id,
    );
  }

  tasks(): Promise<GenerationTaskData[]> {
    return this.#dependencies.repository.listGenerationTasks(
      this.#dependencies.scope,
      this.id,
    );
  }

  async events(options: GenerationEventOptions = {}): Promise<GenerationEventPage> {
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
    const files = applySourceChanges(await this.files(), input.changes);
    const title = normalizeVersionTitle(input.title ?? this.title);
    const summary = input.summary?.trim()
      || `Applied ${input.changes.length} source change${input.changes.length === 1 ? "" : "s"}.`;
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

  files(): Promise<VersionFile[]> {
    return this.#dependencies.repository.getVersionFiles(this.#dependencies.scope, this.id);
  }

  async generation(): Promise<GenerationData | null> {
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
}

class GenerationRunner<Framework extends FrameworkId> {
  readonly #dependencies: RunnerDependencies<Framework>;

  constructor(dependencies: RunnerDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  schedule(scope: UserScope, generationId: string, attemptId: string): void {
    this.#dependencies.registry.start(
      generationId,
      (signal) => this.#execute(scope, generationId, attemptId, signal),
    );
  }

  async #execute(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      await this.#dependencies.repository.startGenerationAttempt(scope, generationId, attemptId);
      signal.throwIfAborted();

      const generation = await this.#dependencies.repository.getGeneration(scope, generationId);
      if (!generation) throw new NotFoundError("Generation");
      const chat = await this.#dependencies.repository.getChat<Framework>(scope, generation.chatId);
      if (!chat) throw new NotFoundError("Chat");

      let skills = await this.#dependencies.repository.getGenerationSkills(scope, generationId);
      if (skills === null) {
        skills = await this.#dependencies.skillResolver.resolveForPrompt(generation.prompt);
        await this.#dependencies.repository.attachGenerationSkills(scope, generationId, skills);
      }

      const [messages, previousFiles, tasks] = await Promise.all([
        this.#dependencies.repository.listMessages(scope, generation.chatId),
        generation.baseVersionId
          ? this.#dependencies.repository.getVersionFiles(scope, generation.baseVersionId)
          : Promise.resolve([]),
        this.#dependencies.repository.listGenerationTasks(scope, generationId),
      ]);
      signal.throwIfAborted();

      const output = await this.#dependencies.generator.generate(
        {
          framework: chat.framework,
          prompt: generation.prompt,
          messages: messages.filter((message) => message.generationId !== generationId),
          previousFiles,
          skills,
          tasks,
        },
        {
          signal,
          onDelta: async (delta) => {
            signal.throwIfAborted();
            await this.#dependencies.repository.appendGenerationEvent(scope, {
              generationId,
              attemptId,
              type: "output.delta",
              data: { delta },
            });
          },
        },
      );
      signal.throwIfAborted();

      if (output.kind === "task") {
        await this.#dependencies.repository.pauseGeneration(scope, {
          generationId,
          attemptId,
          taskId: createId(),
          task: output.task,
          inputTokens: output.usage.inputTokens ?? null,
          outputTokens: output.usage.outputTokens ?? null,
          totalTokens: output.usage.totalTokens ?? null,
          finishReason: output.finishReason,
        });
        return;
      }

      await this.#dependencies.repository.completeGeneration(scope, {
        generationId,
        attemptId,
        parentVersionId: generation.baseVersionId,
        framework: chat.framework,
        title: output.title,
        summary: output.summary,
        files: output.files,
        assistantMessage: output.summary,
        inputTokens: output.usage.inputTokens ?? null,
        outputTokens: output.usage.outputTokens ?? null,
        totalTokens: output.usage.totalTokens ?? null,
        finishReason: output.finishReason,
      });
    } catch (error) {
      if (signal.aborted || isAbortError(error)) {
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
        errorMessage(error),
      ).catch(() => undefined);
    }
  }
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
  ): void {
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
