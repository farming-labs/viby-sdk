import type {
  ChatData,
  FrameworkId,
  GenerationData,
  MessageData,
  UserScope,
  VersionData,
  VersionFile,
} from "../../src/types.js";
import type {
  CompleteGenerationRecord,
  CreateGenerationRecord,
  Repository,
} from "../../src/repository.js";
import { createId } from "../../src/utils.js";

interface ScopedRecord {
  tenantId: string;
  userId: string;
}

export class MemoryRepository implements Repository {
  readonly chats = new Map<string, ChatData & ScopedRecord>();
  readonly generations = new Map<string, GenerationData & ScopedRecord>();
  readonly versions = new Map<string, VersionData & ScopedRecord>();
  readonly messages: Array<MessageData & ScopedRecord> = [];
  readonly files = new Map<string, VersionFile[]>();
  closed = false;

  async assertReady(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }

  async createChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: { id: string; title: string; framework: Framework },
  ): Promise<ChatData<Framework>> {
    const now = new Date();
    const chat: ChatData<Framework> & ScopedRecord = {
      ...input,
      ...scope,
      createdAt: now,
      updatedAt: now,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  async getChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<ChatData<Framework> | null> {
    const chat = this.chats.get(id);
    return chat && inScope(chat, scope) ? chat as ChatData<Framework> : null;
  }

  async listChats<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
  ): Promise<Array<ChatData<Framework>>> {
    return [...this.chats.values()]
      .filter((chat) => inScope(chat, scope))
      .slice(0, limit) as Array<ChatData<Framework>>;
  }

  async createGeneration(scope: UserScope, input: CreateGenerationRecord): Promise<GenerationData> {
    const chat = await this.getChat(scope, input.chatId);
    if (!chat) throw new Error("Chat not found");
    const generation: GenerationData & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      status: "pending",
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      error: null,
      createdAt: new Date(),
      completedAt: null,
      ...scope,
    };
    this.generations.set(generation.id, generation);
    this.messages.push({
      id: createId(),
      chatId: input.chatId,
      generationId: input.id,
      role: "user",
      content: input.prompt,
      createdAt: new Date(),
      ...scope,
    });
    return generation;
  }

  async completeGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    input: CompleteGenerationRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    const generation = this.generations.get(input.generationId);
    if (!generation || !inScope(generation, scope)) throw new Error("Generation not found");
    const existing = [...this.versions.values()].filter(
      (version) => version.chatId === generation.chatId && inScope(version, scope),
    );
    const version: VersionData<Framework> & ScopedRecord = {
      id: createId(),
      chatId: generation.chatId,
      generationId: input.generationId,
      parentVersionId: input.parentVersionId,
      number: existing.length + 1,
      framework: input.framework,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      ...scope,
    };
    this.versions.set(version.id, version);
    this.files.set(version.id, [...input.files]);
    this.generations.set(input.generationId, {
      ...generation,
      status: "succeeded",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      completedAt: new Date(),
    });
    this.messages.push({
      id: createId(),
      chatId: generation.chatId,
      generationId: generation.id,
      role: "assistant",
      content: input.assistantMessage,
      createdAt: new Date(),
      ...scope,
    });
    return version;
  }

  async failGeneration(scope: UserScope, generationId: string, error: string): Promise<void> {
    const generation = this.generations.get(generationId);
    if (!generation || !inScope(generation, scope)) return;
    this.generations.set(generationId, {
      ...generation,
      status: "failed",
      error,
      completedAt: new Date(),
    });
  }

  async getGeneration(scope: UserScope, id: string): Promise<GenerationData | null> {
    const generation = this.generations.get(id);
    return generation && inScope(generation, scope) ? generation : null;
  }

  async getVersion<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<VersionData<Framework> | null> {
    const version = this.versions.get(id);
    return version && inScope(version, scope)
      ? version as unknown as VersionData<Framework>
      : null;
  }

  async getLatestVersion<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<VersionData<Framework> | null> {
    return ([...this.versions.values()]
      .filter((version) => version.chatId === chatId && inScope(version, scope))
      .sort((a, b) => b.number - a.number)[0] as VersionData<Framework> | undefined) ?? null;
  }

  async listVersions<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<Array<VersionData<Framework>>> {
    return [...this.versions.values()]
      .filter((version) => version.chatId === chatId && inScope(version, scope))
      .sort((a, b) => b.number - a.number) as unknown as Array<VersionData<Framework>>;
  }

  async listMessages(scope: UserScope, chatId: string): Promise<MessageData[]> {
    return this.messages.filter(
      (message) => message.chatId === chatId && inScope(message, scope),
    );
  }

  async getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]> {
    const version = await this.getVersion(scope, versionId);
    return version ? [...(this.files.get(versionId) ?? [])] : [];
  }
}

function inScope(record: ScopedRecord, scope: UserScope): boolean {
  return record.tenantId === scope.tenantId && record.userId === scope.userId;
}
