import type {
  ChatData,
  CreateChatInput,
  FrameworkId,
  GenerateInput,
  GenerationData,
  IterateInput,
  MessageData,
  UserScope,
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
  GenerationError,
  NotFoundError,
} from "./errors.js";
import {
  assertIdentifier,
  assertPrompt,
  createId,
  errorMessage,
} from "./utils.js";
import { createSourceDownload, type DownloadArtifact } from "./download.js";

export interface Viby<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  forUser(scope: UserScope): ScopedViby<Framework>;
  close(): Promise<void>;
}

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
      "DATABASE_URL is required. Viby stores tenant-scoped chats, generations, versions, and files in your Postgres database.",
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
  readonly #generator: ProjectGenerator<Framework>;
  readonly #skillResolver: SkillResolver;
  readonly #modelProvider: string;
  readonly #modelId: string;

  constructor(
    config: VibyConfig<Framework>,
    dependencies: ClientDependencies<Framework>,
  ) {
    this.framework = config.framework;
    this.#repository = dependencies.repository;
    this.#generator = dependencies.generator;
    this.#skillResolver = dependencies.skillResolver;
    if (typeof config.model === "string") {
      this.#modelProvider = config.model.split("/", 1)[0] || "gateway";
      this.#modelId = config.model;
    } else {
      this.#modelProvider = config.model.provider;
      this.#modelId = config.model.modelId;
    }
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
      generator: this.#generator,
      skillResolver: this.#skillResolver,
      modelProvider: this.#modelProvider,
      modelId: this.#modelId,
    });
  }

  close(): Promise<void> {
    return this.#repository.close();
  }
}

interface ScopedDependencies<Framework extends FrameworkId> {
  readonly scope: UserScope;
  readonly framework: Framework;
  readonly repository: Repository;
  readonly generator: ProjectGenerator<Framework>;
  readonly skillResolver: SkillResolver;
  readonly modelProvider: string;
  readonly modelId: string;
}

export class ScopedViby<Framework extends FrameworkId = FrameworkId> {
  readonly scope: UserScope;
  readonly chats: ChatCollection<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.scope = dependencies.scope;
    this.chats = new ChatCollection(dependencies);
  }
}

export class ChatCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async create(input: CreateChatInput = {}): Promise<Chat<Framework>> {
    const title = input.title?.trim() || "Untitled";
    if (title.length > 200) {
      throw new ConfigurationError("A chat title cannot exceed 200 characters.");
    }
    const data = await this.#dependencies.repository.createChat(this.#dependencies.scope, {
      id: createId(),
      title,
      framework: this.#dependencies.framework,
    });
    return new Chat(data, this.#dependencies);
  }

  async get(id: string): Promise<Chat<Framework>> {
    const data = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!data) throw new NotFoundError("Chat");
    return new Chat(data, this.#dependencies);
  }

  async list(options: { limit?: number } = {}): Promise<Array<Chat<Framework>>> {
    const limit = options.limit ?? 20;
    if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
      throw new ConfigurationError("Chat list limit must be an integer between 1 and 100.");
    }
    const records = await this.#dependencies.repository.listChats<Framework>(
      this.#dependencies.scope,
      limit,
    );
    return records.map((record) => new Chat(record, this.#dependencies));
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
  get framework(): Framework { return this.#data.framework; }
  get createdAt(): Date { return this.#data.createdAt; }
  get updatedAt(): Date { return this.#data.updatedAt; }

  async generate(input: GenerateInput): Promise<Version<Framework>> {
    const latest = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return this.#generateFrom(input, latest);
  }

  async latestVersion(): Promise<Version<Framework> | null> {
    const data = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return data ? new Version(data, this.#dependencies) : null;
  }

  async listVersions(): Promise<Array<Version<Framework>>> {
    const records = await this.#dependencies.repository.listVersions<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return records.map((record) => new Version(record, this.#dependencies));
  }

  listMessages(): Promise<MessageData[]> {
    return this.#dependencies.repository.listMessages(this.#dependencies.scope, this.id);
  }

  async #generateFrom(
    input: GenerateInput,
    baseVersion: VersionData<Framework> | null,
  ): Promise<Version<Framework>> {
    const prompt = assertPrompt(input.prompt);
    const [messages, previousFiles, skills] = await Promise.all([
      this.#dependencies.repository.listMessages(this.#dependencies.scope, this.id),
      baseVersion
        ? this.#dependencies.repository.getVersionFiles(this.#dependencies.scope, baseVersion.id)
        : Promise.resolve([]),
      this.#dependencies.skillResolver.resolveForPrompt(prompt),
    ]);
    const generationId = createId();
    await this.#dependencies.repository.createGeneration(this.#dependencies.scope, {
      id: generationId,
      chatId: this.id,
      baseVersionId: baseVersion?.id ?? null,
      prompt,
      modelProvider: this.#dependencies.modelProvider,
      modelId: this.#dependencies.modelId,
      skills,
    });

    try {
      const output = await this.#dependencies.generator.generate({
        framework: this.framework,
        prompt,
        messages,
        previousFiles,
        skills,
      });
      const data = await this.#dependencies.repository.completeGeneration(
        this.#dependencies.scope,
        {
          generationId,
          parentVersionId: baseVersion?.id ?? null,
          framework: this.framework,
          title: output.title,
          summary: output.summary,
          files: output.files,
          assistantMessage: output.summary,
          inputTokens: output.usage.inputTokens ?? null,
          outputTokens: output.usage.outputTokens ?? null,
          totalTokens: output.usage.totalTokens ?? null,
          finishReason: output.finishReason,
        },
      );
      return new Version(data, this.#dependencies);
    } catch (error) {
      const message = errorMessage(error);
      await this.#dependencies.repository.failGeneration(
        this.#dependencies.scope,
        generationId,
        message,
      );
      throw new GenerationError(generationId, message, { cause: error });
    }
  }

  generateFromVersion(
    input: GenerateInput,
    version: VersionData<Framework>,
  ): Promise<Version<Framework>> {
    return this.#generateFrom(input, version);
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
  get generationId(): string { return this.#data.generationId; }
  get parentVersionId(): string | null { return this.#data.parentVersionId; }
  get number(): number { return this.#data.number; }
  get framework(): Framework { return this.#data.framework; }
  get title(): string { return this.#data.title; }
  get summary(): string { return this.#data.summary; }
  get createdAt(): Date { return this.#data.createdAt; }

  async iterate(input: IterateInput): Promise<Version<Framework>> {
    const chatData = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!chatData) throw new NotFoundError("Chat");
    return new Chat(chatData, this.#dependencies).generateFromVersion(input, this.#data);
  }

  files(): Promise<VersionFile[]> {
    return this.#dependencies.repository.getVersionFiles(this.#dependencies.scope, this.id);
  }

  async generation(): Promise<GenerationData> {
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
