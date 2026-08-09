import type {
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  FrameworkId,
  GenerationAttemptData,
  GenerationData,
  GenerationEvent,
  GenerationEventDataMap,
  GenerationEventType,
  GenerationTaskData,
  MessageData,
  MessagePart,
  MessagePartInput,
  JsonValue,
  ResolvedSkill,
  SourceChange,
  ToolCallData,
  UserScope,
  VersionData,
  VersionFile,
} from "../../src/types.js";
import type {
  CreateSandboxLeaseRecord,
  SandboxLeaseData,
  SandboxLeaseStatus,
} from "../../src/sandbox.js";
import type {
  AppendGenerationEventRecord,
  ChatPageCursor,
  ClaimGenerationAttemptRecord,
  CompleteGenerationRecord,
  CompleteToolCallRecord,
  CreateAttemptRecord,
  CreatedGeneration,
  CreateGenerationRecord,
  CreateToolCallRecord,
  DeleteChatRecord,
  CreatedToolCall,
  CreateSourceVersionRecord,
  ForkVersionRecord,
  FailToolCallRecord,
  GenerationWorkerLease,
  ImportedChat,
  ImportChatRecord,
  MessagePageCursor,
  PauseGenerationRecord,
  Repository,
  RepositoryPage,
  ResolveGenerationTaskRecord,
  RestoreVersionRecord,
  UpdateChatRecord,
  VersionPageCursor,
} from "../../src/repository.js";
import { createId } from "../../src/utils.js";
import { ConfigurationError, GenerationStateError, NotFoundError } from "../../src/errors.js";
import { normalizeAndRedactToolPayload } from "../../src/redaction.js";

interface ScopedRecord {
  tenantId: string;
  userId: string;
}

type MemoryChatRecord = ChatData & {
  deletedAt: Date | null;
  purgeAfter: Date | null;
};

interface MemoryMessageInput {
  readonly chatId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly parts: readonly MessagePartInput[];
  readonly createdAt: Date;
}

export class MemoryRepository implements Repository {
  readonly chats = new Map<string, MemoryChatRecord>();
  readonly generations = new Map<string, GenerationData & ScopedRecord>();
  readonly attempts = new Map<string, GenerationAttemptData & ScopedRecord>();
  readonly versions = new Map<string, VersionData & ScopedRecord>();
  readonly messages: Array<MessageData & ScopedRecord> = [];
  readonly files = new Map<string, VersionFile[]>();
  readonly changes = new Map<string, SourceChange[]>();
  readonly events: Array<GenerationEvent & ScopedRecord> = [];
  readonly tasks = new Map<string, GenerationTaskData & ScopedRecord>();
  readonly skills = new Map<string, ResolvedSkill[]>();
  readonly sandboxLeases = new Map<string, SandboxLeaseData & ScopedRecord>();
  readonly toolCalls = new Map<string, ToolCallData & ScopedRecord>();
  readonly workerLeaseTokens = new Map<string, string>();
  closed = false;
  #cursor = 0;

  async assertReady(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }

  async createChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: { id: string; title: string; metadata: ChatData["metadata"]; framework: Framework },
  ): Promise<ChatData<Framework>> {
    const now = new Date();
    const chat: ChatData<Framework> & ScopedRecord & {
      deletedAt: Date | null;
      purgeAfter: Date | null;
    } = {
      ...input,
      ...scope,
      createdAt: now,
      updatedAt: now,
      deletedAt: null,
      purgeAfter: null,
    };
    this.chats.set(chat.id, chat);
    return chat;
  }

  async importChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: ImportChatRecord<Framework>,
  ): Promise<ImportedChat<Framework>> {
    const chat = await this.createChat(scope, {
      id: input.chatId,
      title: input.title,
      metadata: input.metadata,
      framework: input.framework,
    });
    const version: VersionData<Framework> & ScopedRecord = {
      id: input.versionId,
      chatId: input.chatId,
      generationId: null,
      parentVersionId: null,
      number: 1,
      origin: "imported",
      framework: input.framework,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      ...scope,
    };
    this.versions.set(version.id, version);
    this.files.set(version.id, [...input.files]);
    return { chat, version };
  }

  async createSourceVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSourceVersionRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    const chat = await this.getChat(scope, input.chatId);
    if (!chat) throw new NotFoundError("Chat");
    const parent = await this.getVersion(scope, input.parentVersionId);
    if (!parent || parent.chatId !== input.chatId) throw new NotFoundError("Parent version");
    const number = [...this.versions.values()]
      .filter((version) => version.chatId === input.chatId && inScope(version, scope))
      .reduce((highest, version) => Math.max(highest, version.number), 0) + 1;
    const version: VersionData<Framework> & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      generationId: null,
      parentVersionId: input.parentVersionId,
      number,
      origin: input.origin,
      framework: input.framework,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      ...scope,
    };
    this.versions.set(version.id, version);
    this.files.set(version.id, [...input.files]);
    this.changes.set(version.id, input.changes.map((change) => ({ ...change })));
    this.chats.set(chat.id, {
      ...chat,
      updatedAt: new Date(),
      deletedAt: null,
      purgeAfter: null,
    });
    return version;
  }

  async forkVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: ForkVersionRecord<Framework>,
  ): Promise<ImportedChat<Framework>> {
    const source = await this.getVersion(scope, input.sourceVersionId);
    if (!source) throw new NotFoundError("Source version");
    const chat = await this.createChat(scope, {
      id: input.chatId,
      title: input.title,
      metadata: input.metadata,
      framework: input.framework,
    });
    const version: VersionData<Framework> & ScopedRecord = {
      id: input.versionId,
      chatId: input.chatId,
      generationId: null,
      parentVersionId: source.id,
      number: 1,
      origin: "forked",
      framework: input.framework,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      ...scope,
    };
    this.versions.set(version.id, version);
    this.files.set(version.id, [...(this.files.get(source.id) ?? [])]);
    return { chat, version };
  }

  async restoreVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: RestoreVersionRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    const chat = await this.getChat(scope, input.chatId);
    if (!chat) throw new NotFoundError("Chat");
    const source = await this.getVersion(scope, input.sourceVersionId);
    if (!source || source.chatId !== input.chatId) throw new NotFoundError("Source version");
    const number = [...this.versions.values()]
      .filter((version) => version.chatId === input.chatId && inScope(version, scope))
      .reduce((highest, version) => Math.max(highest, version.number), 0) + 1;
    const version: VersionData<Framework> & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      generationId: null,
      parentVersionId: source.id,
      number,
      origin: "restored",
      framework: input.framework,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      ...scope,
    };
    this.versions.set(version.id, version);
    this.files.set(version.id, [...(this.files.get(source.id) ?? [])]);
    this.chats.set(chat.id, {
      ...chat,
      updatedAt: new Date(),
      deletedAt: null,
      purgeAfter: null,
    });
    return version;
  }

  async getChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<ChatData<Framework> | null> {
    const chat = this.chats.get(id);
    return chat && inScope(chat, scope) && chat.deletedAt === null
      ? chat as unknown as ChatData<Framework>
      : null;
  }

  async updateChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    input: UpdateChatRecord,
  ): Promise<ChatData<Framework>> {
    const chat = await this.getChat<Framework>(scope, id);
    if (!chat) throw new NotFoundError("Chat");
    const updated: MemoryChatRecord = {
      ...chat,
      ...input,
      updatedAt: new Date(),
      deletedAt: null,
      purgeAfter: null,
    };
    this.chats.set(id, updated);
    return updated as unknown as ChatData<Framework>;
  }

  async deleteChat(
    scope: UserScope,
    id: string,
    input: DeleteChatRecord,
  ): Promise<ChatDeletionData> {
    const chat = this.chats.get(id);
    if (!chat || !inScope(chat, scope) || chat.deletedAt) throw new NotFoundError("Chat");
    const active = [...this.generations.values()].some((generation) => (
      inScope(generation, scope)
      && generation.chatId === id
      && ["queued", "running", "waiting"].includes(generation.status)
    ));
    if (active) throw new GenerationStateError(id, "Chat has an active generation.");
    chat.deletedAt = new Date(input.deletedAt);
    chat.purgeAfter = input.purgeAfter ? new Date(input.purgeAfter) : null;
    return { chatId: id, deletedAt: chat.deletedAt, purgeAfter: chat.purgeAfter };
  }

  async restoreChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    now: Date,
  ): Promise<ChatData<Framework>> {
    const chat = this.chats.get(id);
    if (
      !chat
      || !inScope(chat, scope)
      || !chat.deletedAt
      || (chat.purgeAfter !== null && chat.purgeAfter <= now)
    ) throw new NotFoundError("Deleted chat");
    const restored: MemoryChatRecord = {
      ...chat,
      deletedAt: null,
      purgeAfter: null,
      updatedAt: new Date(),
    };
    this.chats.set(id, restored);
    return restored as unknown as ChatData<Framework>;
  }

  async purgeDeletedChats(scope: UserScope, now: Date, limit: number): Promise<number> {
    const ids = [...this.chats.values()]
      .filter((chat) => (
        inScope(chat, scope)
        && chat.deletedAt !== null
        && chat.purgeAfter !== null
        && chat.purgeAfter <= now
      ))
      .sort((left, right) => (left.purgeAfter!.getTime() - right.purgeAfter!.getTime()))
      .slice(0, limit)
      .map((chat) => chat.id);
    for (const id of ids) {
      this.chats.delete(id);
      const generationIds = [...this.generations.values()]
        .filter((generation) => generation.chatId === id && inScope(generation, scope))
        .map((generation) => generation.id);
      const versionIds = [...this.versions.values()]
        .filter((version) => version.chatId === id && inScope(version, scope))
        .map((version) => version.id);
      for (const generationId of generationIds) {
        this.generations.delete(generationId);
        this.skills.delete(generationId);
      }
      for (const [attemptId, attempt] of this.attempts) {
        if (generationIds.includes(attempt.generationId)) {
          this.attempts.delete(attemptId);
          this.workerLeaseTokens.delete(attemptId);
        }
      }
      for (const [taskId, task] of this.tasks) {
        if (generationIds.includes(task.generationId)) this.tasks.delete(taskId);
      }
      for (const [toolCallId, toolCall] of this.toolCalls) {
        if (generationIds.includes(toolCall.generationId)) this.toolCalls.delete(toolCallId);
      }
      for (const versionId of versionIds) {
        this.versions.delete(versionId);
        this.files.delete(versionId);
        this.changes.delete(versionId);
      }
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        if (this.messages[index]?.chatId === id) this.messages.splice(index, 1);
      }
      for (let index = this.events.length - 1; index >= 0; index -= 1) {
        if (generationIds.includes(this.events[index]!.generationId)) this.events.splice(index, 1);
      }
      for (const [leaseId, lease] of this.sandboxLeases) {
        if (lease.context.chatId === id && inScope(lease, scope)) this.sandboxLeases.delete(leaseId);
      }
    }
    return ids.length;
  }

  async listChats<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
  ): Promise<Array<ChatData<Framework>>> {
    return sortChats([...this.chats.values()].filter((chat) => (
      inScope(chat, scope) && chat.deletedAt === null
    )))
      .slice(0, limit) as unknown as Array<ChatData<Framework>>;
  }

  async listChatPage<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
    after: ChatPageCursor | null,
    metadata: ChatMetadata,
  ): Promise<RepositoryPage<ChatData<Framework>>> {
    let records = sortChats([...this.chats.values()].filter((chat) => (
      inScope(chat, scope) && chat.deletedAt === null && containsJson(chat.metadata, metadata)
    )));
    if (after) {
      records = records.filter((chat) => (
        chat.updatedAt < after.updatedAt
        || (chat.updatedAt.getTime() === after.updatedAt.getTime() && chat.id < after.id)
      ));
    }
    return createPage(records as unknown as Array<ChatData<Framework>>, limit);
  }

  async createGeneration(
    scope: UserScope,
    input: CreateGenerationRecord,
  ): Promise<CreatedGeneration> {
    const chat = await this.getChat(scope, input.chatId);
    if (!chat) throw new NotFoundError("Chat");
    const now = new Date();
    const generation: GenerationData & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      baseVersionId: input.baseVersionId,
      activeAttemptId: input.attemptId,
      attemptCount: 1,
      prompt: input.prompt,
      status: "queued",
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      ...scope,
    };
    const attempt: GenerationAttemptData & ScopedRecord = {
      id: input.attemptId,
      generationId: input.id,
      number: 1,
      reason: "initial",
      status: "queued",
      modelProvider: input.modelProvider,
      modelId: input.modelId,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      finishReason: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      workerId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      ...scope,
    };
    this.generations.set(generation.id, generation);
    this.attempts.set(attempt.id, attempt);
    this.#addMessage(scope, {
      chatId: input.chatId,
      generationId: input.id,
      attemptId: input.attemptId,
      role: "user",
      content: input.prompt,
      parts: [{ type: "text", data: { text: input.prompt } }],
      createdAt: now,
    });
    this.#append(scope, input.id, input.attemptId, "generation.created", {
      prompt: input.prompt,
    });
    this.#append(scope, input.id, input.attemptId, "attempt.queued", {
      number: 1,
      reason: "initial",
    });
    return { generation, attempt };
  }

  async startGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
  ): Promise<GenerationAttemptData> {
    const generation = this.#requireGeneration(scope, generationId);
    const attempt = this.#requireAttempt(scope, attemptId);
    if (generation.status !== "queued" || generation.activeAttemptId !== attemptId || attempt.status !== "queued") {
      throw new GenerationStateError(generationId, `Attempt ${attemptId} is not queued.`);
    }
    const now = new Date();
    const nextAttempt = { ...attempt, status: "running" as const, startedAt: now };
    const nextGeneration = {
      ...generation,
      status: "running" as const,
      startedAt: generation.startedAt ?? now,
      completedAt: null,
      error: null,
    };
    this.attempts.set(attemptId, nextAttempt);
    this.generations.set(generationId, nextGeneration);
    this.#append(scope, generationId, attemptId, "attempt.started", {
      number: attempt.number,
      reason: attempt.reason,
    });
    return nextAttempt;
  }

  async claimGenerationAttempt<Framework extends FrameworkId>(
    input: ClaimGenerationAttemptRecord<Framework>,
  ): Promise<GenerationWorkerLease | null> {
    const now = new Date();
    const candidate = [...this.attempts.values()]
      .filter((attempt) => {
        if (input.attemptId && attempt.id !== input.attemptId) return false;
        if (attempt.status !== "queued" && attempt.status !== "running") return false;
        if (attempt.leaseExpiresAt && attempt.leaseExpiresAt > now) return false;
        const generation = this.generations.get(attempt.generationId);
        if (!generation || generation.activeAttemptId !== attempt.id) return false;
        if (generation.status !== "queued" && generation.status !== "running") return false;
        if (generation.modelProvider !== input.modelProvider || generation.modelId !== input.modelId) {
          return false;
        }
        const chat = this.chats.get(generation.chatId);
        return chat?.framework === input.framework;
      })
      .sort((left, right) => left.createdAt.getTime() - right.createdAt.getTime())[0];
    if (!candidate) return null;
    const generation = this.generations.get(candidate.generationId)!;
    const wasQueued = candidate.status === "queued";
    const expiresAt = new Date(now.getTime() + input.leaseMs);
    this.attempts.set(candidate.id, {
      ...candidate,
      status: "running",
      startedAt: candidate.startedAt ?? now,
      workerId: input.workerId,
      heartbeatAt: now,
      leaseExpiresAt: expiresAt,
    });
    this.workerLeaseTokens.set(candidate.id, input.leaseToken);
    this.generations.set(generation.id, {
      ...generation,
      status: "running",
      startedAt: generation.startedAt ?? now,
      completedAt: null,
      error: null,
    });
    if (wasQueued) {
      this.#append(
        { tenantId: candidate.tenantId, userId: candidate.userId },
        generation.id,
        candidate.id,
        "attempt.started",
        { number: candidate.number, reason: candidate.reason },
      );
    }
    return {
      workerId: input.workerId,
      leaseToken: input.leaseToken,
      scope: { tenantId: candidate.tenantId, userId: candidate.userId },
      generationId: generation.id,
      attemptId: candidate.id,
      expiresAt,
    };
  }

  async heartbeatGenerationAttempt(
    lease: GenerationWorkerLease,
    leaseMs: number,
  ): Promise<Date | null> {
    const attempt = this.attempts.get(lease.attemptId);
    const now = new Date();
    if (
      !attempt
      || !inScope(attempt, lease.scope)
      || attempt.status !== "running"
      || attempt.workerId !== lease.workerId
      || this.workerLeaseTokens.get(attempt.id) !== lease.leaseToken
      || !attempt.leaseExpiresAt
      || attempt.leaseExpiresAt <= now
    ) return null;
    const expiresAt = new Date(now.getTime() + leaseMs);
    this.attempts.set(attempt.id, {
      ...attempt,
      heartbeatAt: now,
      leaseExpiresAt: expiresAt,
    });
    return expiresAt;
  }

  async createGenerationAttempt(
    scope: UserScope,
    input: CreateAttemptRecord,
  ): Promise<GenerationAttemptData> {
    const generation = this.#requireGeneration(scope, input.generationId);
    const allowed = input.reason === "retry"
      ? generation.status === "failed" || generation.status === "cancelled"
      : generation.status === "failed"
        || generation.status === "cancelled"
        || generation.status === "queued"
        || generation.status === "running";
    if (!allowed) {
      throw new GenerationStateError(
        generation.id,
        `Generation ${generation.id} cannot ${input.reason} from ${generation.status}.`,
      );
    }
    if (generation.status === "queued" || generation.status === "running") {
      const current = this.#requireAttempt(scope, generation.activeAttemptId);
      if (current.leaseExpiresAt && current.leaseExpiresAt.getTime() > Date.now()) {
        throw new GenerationStateError(generation.id, `Generation ${generation.id} has an active worker lease.`);
      }
      const interrupted = { ...current, status: "interrupted" as const, completedAt: new Date() };
      this.attempts.set(current.id, interrupted);
      this.#append(scope, generation.id, current.id, "attempt.interrupted", {
        number: current.number,
      });
    }

    const number = generation.attemptCount + 1;
    const attempt: GenerationAttemptData & ScopedRecord = {
      id: input.id,
      generationId: generation.id,
      number,
      reason: input.reason,
      status: "queued",
      modelProvider: generation.modelProvider,
      modelId: generation.modelId,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      finishReason: null,
      error: null,
      createdAt: new Date(),
      startedAt: null,
      completedAt: null,
      workerId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      ...scope,
    };
    this.attempts.set(attempt.id, attempt);
    this.generations.set(generation.id, {
      ...generation,
      activeAttemptId: attempt.id,
      attemptCount: number,
      status: "queued",
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      error: null,
      completedAt: null,
    });
    this.#append(scope, generation.id, attempt.id, "attempt.queued", {
      number,
      reason: input.reason,
    });
    return attempt;
  }

  async attachGenerationSkills(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    skills: readonly ResolvedSkill[],
  ): Promise<void> {
    const generation = this.#requireGeneration(scope, generationId);
    const attempt = this.#requireAttempt(scope, attemptId);
    if (generation.activeAttemptId !== attemptId || !this.#hasWorkerLease(attempt, leaseToken)) {
      throw new GenerationStateError(generationId, "The generation worker lease is no longer active.");
    }
    if (!this.skills.has(generationId)) this.skills.set(generationId, [...skills]);
  }

  async getGenerationSkills(
    scope: UserScope,
    generationId: string,
  ): Promise<ResolvedSkill[] | null> {
    this.#requireGeneration(scope, generationId);
    const skills = this.skills.get(generationId);
    return skills ? [...skills] : null;
  }

  async appendGenerationEvent<Type extends GenerationEventType>(
    scope: UserScope,
    input: AppendGenerationEventRecord<Type>,
  ): Promise<void> {
    const generation = this.#requireGeneration(scope, input.generationId);
    const attempt = input.attemptId ? this.#requireAttempt(scope, input.attemptId) : null;
    if (
      generation.status !== "running"
      || !attempt
      || generation.activeAttemptId !== attempt.id
      || !this.#hasWorkerLease(attempt, input.leaseToken)
    ) {
      throw new GenerationStateError(input.generationId, "The generation worker lease is no longer active.");
    }
    this.#append(scope, input.generationId, input.attemptId, input.type, input.data);
  }

  async createToolCall(
    scope: UserScope,
    input: CreateToolCallRecord,
  ): Promise<CreatedToolCall> {
    const generation = this.#requireGeneration(scope, input.generationId);
    const attempt = this.#requireAttempt(scope, input.attemptId);
    if (
      generation.status !== "running"
      || generation.activeAttemptId !== attempt.id
      || !this.#hasWorkerLease(attempt, input.leaseToken)
    ) {
      throw new GenerationStateError(input.generationId, "The generation worker lease is no longer active.");
    }
    const providerCallId = normalizeMemoryToolText(input.providerCallId, "provider call id", 500);
    const name = normalizeMemoryToolText(input.name, "tool name", 200);
    const idempotencyKey = input.idempotencyKey === undefined
      ? null
      : normalizeMemoryToolText(input.idempotencyKey, "idempotency key", 500);
    if (input.effect === "external" && idempotencyKey === null) {
      throw new ConfigurationError(`External tool ${name} requires an idempotency key.`);
    }
    const existing = [...this.toolCalls.values()].find((toolCall) => (
      inScope(toolCall, scope)
      && (input.effect === "external"
        ? toolCall.effect === "external"
          && toolCall.name === name
          && toolCall.idempotencyKey === idempotencyKey
        : toolCall.generationId === input.generationId
          && toolCall.attemptId === input.attemptId
          && toolCall.providerCallId === providerCallId)
    ));
    if (existing) return { toolCall: existing, created: false };
    const toolCall: ToolCallData & ScopedRecord = {
      id: input.id,
      generationId: input.generationId,
      attemptId: input.attemptId,
      messageId: null,
      providerCallId,
      name,
      effect: input.effect,
      arguments: normalizeAndRedactToolPayload(input.arguments),
      result: null,
      status: "pending",
      error: null,
      idempotencyKey,
      createdAt: new Date(),
      completedAt: null,
      ...scope,
    };
    this.toolCalls.set(toolCall.id, toolCall);
    return { toolCall, created: true };
  }

  async completeToolCall(
    scope: UserScope,
    input: CompleteToolCallRecord,
  ): Promise<ToolCallData> {
    return this.#settleToolCall(scope, input, "succeeded");
  }

  async failToolCall(
    scope: UserScope,
    input: FailToolCallRecord,
  ): Promise<ToolCallData> {
    return this.#settleToolCall(scope, input, "failed");
  }

  async #settleToolCall(
    scope: UserScope,
    input: CompleteToolCallRecord | FailToolCallRecord,
    status: "succeeded" | "failed",
  ): Promise<ToolCallData> {
    const toolCall = this.toolCalls.get(input.id);
    if (
      !toolCall
      || !inScope(toolCall, scope)
      || toolCall.generationId !== input.generationId
      || toolCall.attemptId !== input.attemptId
    ) throw new NotFoundError("Tool call");
    if (toolCall.status !== "pending") return toolCall;
    const generation = this.#requireGeneration(scope, input.generationId);
    const attempt = this.#requireAttempt(scope, input.attemptId);
    if (generation.activeAttemptId !== attempt.id || !this.#hasWorkerLease(attempt, input.leaseToken)) {
      throw new GenerationStateError(input.generationId, "The generation worker lease is no longer active.");
    }
    const updated: ToolCallData & ScopedRecord = {
      ...toolCall,
      status,
      result: status === "succeeded"
        ? normalizeAndRedactToolPayload((input as CompleteToolCallRecord).result)
        : null,
      error: status === "failed"
        ? normalizeMemoryToolText((input as FailToolCallRecord).error, "tool error", 10_000)
        : null,
      completedAt: new Date(),
    };
    this.toolCalls.set(updated.id, updated);
    return updated;
  }

  async listToolCalls(scope: UserScope, generationId: string): Promise<ToolCallData[]> {
    this.#requireGeneration(scope, generationId);
    return [...this.toolCalls.values()]
      .filter((toolCall) => inScope(toolCall, scope) && toolCall.generationId === generationId)
      .sort((left, right) => (
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      ));
  }

  async completeGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    input: CompleteGenerationRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    const generation = this.#requireGeneration(scope, input.generationId);
    const attempt = this.#requireAttempt(scope, input.attemptId);
    if (
      generation.status !== "running"
      || generation.activeAttemptId !== input.attemptId
      || !this.#hasWorkerLease(attempt, input.leaseToken)
    ) {
      throw new GenerationStateError(generation.id, `Generation ${generation.id} is not running.`);
    }
    const existing = [...this.versions.values()].filter(
      (version) => version.chatId === generation.chatId && inScope(version, scope),
    );
    const version: VersionData<Framework> & ScopedRecord = {
      id: createId(),
      chatId: generation.chatId,
      generationId: input.generationId,
      parentVersionId: input.parentVersionId,
      number: existing.length + 1,
      origin: "generated",
      framework: input.framework,
      title: input.title,
      summary: input.summary,
      createdAt: new Date(),
      ...scope,
    };
    const completedAt = new Date();
    this.versions.set(version.id, version);
    this.files.set(version.id, [...input.files]);
    if (input.changes) {
      this.changes.set(version.id, input.changes.map((change) => ({ ...change })));
    }
    this.attempts.set(attempt.id, {
      ...attempt,
      status: "succeeded",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      finishReason: input.finishReason,
      completedAt,
    });
    this.generations.set(generation.id, {
      ...generation,
      status: "succeeded",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      error: null,
      completedAt,
    });
    this.#addMessage(scope, {
      chatId: generation.chatId,
      generationId: generation.id,
      attemptId: input.attemptId,
      role: "assistant",
      content: input.assistantMessage,
      parts: input.assistantParts,
      createdAt: completedAt,
    });
    this.#append(scope, generation.id, attempt.id, "attempt.succeeded", {
      number: attempt.number,
      versionId: version.id,
    });
    this.#append(scope, generation.id, attempt.id, "generation.succeeded", {
      versionId: version.id,
    });
    return version;
  }

  async pauseGeneration(
    scope: UserScope,
    input: PauseGenerationRecord,
  ): Promise<GenerationTaskData> {
    const generation = this.#requireGeneration(scope, input.generationId);
    const attempt = this.#requireAttempt(scope, input.attemptId);
    if (
      generation.status !== "running"
      || generation.activeAttemptId !== input.attemptId
      || !this.#hasWorkerLease(attempt, input.leaseToken)
    ) {
      throw new GenerationStateError(generation.id, `Generation ${generation.id} is not running.`);
    }
    const now = new Date();
    const task = {
      ...input.task,
      id: input.taskId,
      generationId: input.generationId,
      attemptId: input.attemptId,
      status: "pending" as const,
      resolution: null,
      createdAt: now,
      resolvedAt: null,
      ...scope,
    } as GenerationTaskData & ScopedRecord;
    this.tasks.set(task.id, task);
    this.attempts.set(attempt.id, {
      ...attempt,
      status: "waiting",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      finishReason: input.finishReason,
      completedAt: now,
    });
    this.generations.set(generation.id, {
      ...generation,
      status: "waiting",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      error: null,
    });
    this.#addMessage(scope, {
      chatId: generation.chatId,
      generationId: generation.id,
      attemptId: input.attemptId,
      role: "assistant",
      content: input.task.message,
      parts: input.assistantParts,
      createdAt: now,
    });
    this.#append(scope, generation.id, attempt.id, "attempt.waiting", { taskId: task.id });
    this.#append(scope, generation.id, attempt.id, "task.created", {
      task: { id: task.id, ...input.task },
    });
    return task;
  }

  async resolveGenerationTask(
    scope: UserScope,
    input: ResolveGenerationTaskRecord,
  ): Promise<GenerationAttemptData> {
    const generation = this.#requireGeneration(scope, input.generationId);
    const task = this.tasks.get(input.taskId);
    if (!task || !inScope(task, scope) || task.generationId !== generation.id) {
      throw new NotFoundError("Generation task");
    }
    if (generation.status !== "waiting" || task.status !== "pending") {
      throw new GenerationStateError(generation.id, `Task ${task.id} cannot be resolved.`);
    }
    const now = new Date();
    this.tasks.set(task.id, {
      ...task,
      status: "resolved",
      resolution: input.resolution,
      resolvedAt: now,
    } as GenerationTaskData & ScopedRecord);
    this.#addMessage(scope, {
      chatId: generation.chatId,
      generationId: generation.id,
      attemptId: input.attemptId,
      role: "user",
      content: input.resolutionMessage,
      parts: [{ type: "text", data: { text: input.resolutionMessage } }],
      createdAt: now,
    });

    const number = generation.attemptCount + 1;
    const attempt: GenerationAttemptData & ScopedRecord = {
      id: input.attemptId,
      generationId: generation.id,
      number,
      reason: "task_resolution",
      status: "queued",
      modelProvider: generation.modelProvider,
      modelId: generation.modelId,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      finishReason: null,
      error: null,
      createdAt: now,
      startedAt: null,
      completedAt: null,
      workerId: null,
      heartbeatAt: null,
      leaseExpiresAt: null,
      ...scope,
    };
    this.attempts.set(attempt.id, attempt);
    this.generations.set(generation.id, {
      ...generation,
      status: "queued",
      activeAttemptId: attempt.id,
      attemptCount: number,
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      error: null,
      completedAt: null,
    });
    this.#append(scope, generation.id, task.attemptId, "task.resolved", {
      taskId: task.id,
      resolution: input.resolution,
    });
    this.#append(scope, generation.id, attempt.id, "attempt.queued", {
      number,
      reason: "task_resolution",
    });
    return attempt;
  }

  async failGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    const generation = this.#requireGeneration(scope, generationId);
    const attempt = this.#requireAttempt(scope, attemptId);
    if (
      generation.status !== "running"
      || generation.activeAttemptId !== attemptId
      || !this.#hasWorkerLease(attempt, leaseToken)
    ) return;
    const completedAt = new Date();
    this.attempts.set(attempt.id, { ...attempt, status: "failed", error, completedAt });
    this.generations.set(generation.id, {
      ...generation,
      status: "failed",
      error,
      completedAt,
    });
    this.#append(scope, generation.id, attempt.id, "attempt.failed", {
      number: attempt.number,
      error,
    });
    this.#append(scope, generation.id, attempt.id, "generation.failed", { error });
  }

  async cancelGeneration(scope: UserScope, generationId: string, reason: string): Promise<boolean> {
    const generation = this.#requireGeneration(scope, generationId);
    if (["succeeded", "failed", "cancelled"].includes(generation.status)) return false;
    const attempt = this.#requireAttempt(scope, generation.activeAttemptId);
    const completedAt = new Date();
    this.attempts.set(attempt.id, { ...attempt, status: "cancelled", error: reason, completedAt });
    this.generations.set(generation.id, {
      ...generation,
      status: "cancelled",
      error: reason,
      completedAt,
    });
    this.#append(scope, generation.id, attempt.id, "attempt.cancelled", {
      number: attempt.number,
      reason,
    });
    this.#append(scope, generation.id, attempt.id, "generation.cancelled", { reason });
    return true;
  }

  async getGeneration(scope: UserScope, id: string): Promise<GenerationData | null> {
    const generation = this.generations.get(id);
    return generation && inScope(generation, scope) ? generation : null;
  }

  async listGenerationAttempts(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationAttemptData[]> {
    this.#requireGeneration(scope, generationId);
    return [...this.attempts.values()]
      .filter((attempt) => attempt.generationId === generationId && inScope(attempt, scope))
      .sort((a, b) => a.number - b.number);
  }

  async listGenerationEvents(
    scope: UserScope,
    generationId: string,
    after: string,
    limit: number,
  ): Promise<GenerationEvent[]> {
    this.#requireGeneration(scope, generationId);
    const cursor = Number(after);
    return this.events
      .filter((event) => event.generationId === generationId && inScope(event, scope))
      .filter((event) => Number(event.cursor) > cursor)
      .slice(0, limit);
  }

  async listGenerationTasks(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationTaskData[]> {
    this.#requireGeneration(scope, generationId);
    return [...this.tasks.values()]
      .filter((task) => task.generationId === generationId && inScope(task, scope));
  }

  async getVersionByGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    generationId: string,
  ): Promise<VersionData<Framework> | null> {
    return ([...this.versions.values()].find(
      (version) => version.generationId === generationId && inScope(version, scope),
    ) as VersionData<Framework> | undefined) ?? null;
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

  async listVersionPage<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: VersionPageCursor | null,
  ): Promise<RepositoryPage<VersionData<Framework>>> {
    let records = [...this.versions.values()]
      .filter((version) => version.chatId === chatId && inScope(version, scope))
      .sort((left, right) => right.number - left.number);
    if (after) records = records.filter((version) => version.number < after.number);
    return createPage(records as unknown as Array<VersionData<Framework>>, limit);
  }

  async listMessages(scope: UserScope, chatId: string): Promise<MessageData[]> {
    return this.messages.filter(
      (message) => message.chatId === chatId && inScope(message, scope),
    );
  }

  async getMessage(scope: UserScope, chatId: string, id: string): Promise<MessageData | null> {
    return this.messages.find((message) => (
      message.id === id && message.chatId === chatId && inScope(message, scope)
    )) ?? null;
  }

  async listMessagePage(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: MessagePageCursor | null,
  ): Promise<RepositoryPage<MessageData>> {
    let records = this.messages
      .filter((message) => message.chatId === chatId && inScope(message, scope))
      .sort(compareMessages);
    if (after) {
      records = records.filter((message) => (
        message.createdAt > after.createdAt
        || (message.createdAt.getTime() === after.createdAt.getTime() && message.id > after.id)
      ));
    }
    return createPage(records, limit);
  }

  async getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]> {
    const version = await this.getVersion(scope, versionId);
    return version ? [...(this.files.get(versionId) ?? [])] : [];
  }

  async getVersionChanges(scope: UserScope, versionId: string): Promise<SourceChange[]> {
    const version = await this.getVersion(scope, versionId);
    return version ? (this.changes.get(versionId) ?? []).map((change) => ({ ...change })) : [];
  }

  async createSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSandboxLeaseRecord<Framework>,
  ): Promise<SandboxLeaseData<Framework>> {
    const version = await this.getVersion(scope, input.context.versionId);
    if (!version || version.chatId !== input.context.chatId) {
      throw new NotFoundError("Sandbox version");
    }
    const now = new Date();
    const lease: SandboxLeaseData<Framework> & ScopedRecord = {
      id: input.id,
      sandboxId: input.sandboxId,
      provider: input.provider,
      context: input.context,
      ports: [...input.ports],
      status: "active",
      expiresAt: input.expiresAt,
      createdAt: now,
      updatedAt: now,
      stoppedAt: null,
      ...scope,
    };
    this.sandboxLeases.set(lease.id, lease);
    return lease;
  }

  async getSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<SandboxLeaseData<Framework> | null> {
    const lease = this.sandboxLeases.get(id);
    return lease && inScope(lease, scope)
      ? lease as unknown as SandboxLeaseData<Framework>
      : null;
  }

  async closeSandboxLease(
    scope: UserScope,
    id: string,
    status: Exclude<SandboxLeaseStatus, "active">,
  ): Promise<void> {
    const lease = this.sandboxLeases.get(id);
    if (!lease || !inScope(lease, scope) || lease.status !== "active") return;
    const now = new Date();
    this.sandboxLeases.set(id, {
      ...lease,
      status,
      updatedAt: now,
      stoppedAt: now,
    });
  }

  #addMessage(scope: UserScope, input: MemoryMessageInput): void {
    const message = createMemoryMessage(scope, input);
    this.messages.push(message);
    for (const part of input.parts) {
      if (part.type !== "tool-call") continue;
      const toolCall = this.toolCalls.get(part.data.toolCallId);
      if (
        toolCall
        && inScope(toolCall, scope)
        && toolCall.generationId === input.generationId
        && toolCall.attemptId === input.attemptId
      ) {
        this.toolCalls.set(toolCall.id, { ...toolCall, messageId: message.id });
      }
    }
  }

  #requireGeneration(scope: UserScope, id: string): GenerationData & ScopedRecord {
    const generation = this.generations.get(id);
    if (!generation || !inScope(generation, scope)) throw new NotFoundError("Generation");
    return generation;
  }

  #requireAttempt(scope: UserScope, id: string): GenerationAttemptData & ScopedRecord {
    const attempt = this.attempts.get(id);
    if (!attempt || !inScope(attempt, scope)) throw new NotFoundError("Generation attempt");
    return attempt;
  }

  #hasWorkerLease(attempt: GenerationAttemptData, leaseToken: string): boolean {
    return attempt.status === "running"
      && this.workerLeaseTokens.get(attempt.id) === leaseToken
      && attempt.leaseExpiresAt !== null
      && attempt.leaseExpiresAt.getTime() > Date.now();
  }

  #append<Type extends GenerationEventType>(
    scope: UserScope,
    generationId: string,
    attemptId: string | null,
    type: Type,
    data: GenerationEventDataMap[Type],
  ): void {
    this.#cursor += 1;
    this.events.push({
      cursor: String(this.#cursor),
      generationId,
      attemptId,
      type,
      data,
      createdAt: new Date(),
      ...scope,
    } as GenerationEvent & ScopedRecord);
  }
}

function inScope(record: ScopedRecord, scope: UserScope): boolean {
  return record.tenantId === scope.tenantId && record.userId === scope.userId;
}

function sortChats<Item extends ChatData>(chats: Item[]): Item[] {
  return chats.sort((left, right) => (
    right.updatedAt.getTime() - left.updatedAt.getTime() || right.id.localeCompare(left.id)
  ));
}

function containsJson(value: JsonValue, filter: JsonValue): boolean {
  if (Array.isArray(filter)) {
    return Array.isArray(value) && filter.every((entry) => (
      value.some((candidate) => containsJson(candidate, entry))
    ));
  }
  if (filter !== null && typeof filter === "object") {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
    return Object.entries(filter).every(([key, entry]) => (
      Object.hasOwn(value, key) && containsJson(value[key]!, entry)
    ));
  }
  return Object.is(value, filter);
}

function createMemoryMessage(
  scope: UserScope,
  input: MemoryMessageInput,
): MessageData & ScopedRecord {
  const id = createId();
  const parts = input.parts.map((part, position) => ({
    id: part.id ?? createId(),
    messageId: id,
    generationId: input.generationId,
    attemptId: input.attemptId,
    position,
    type: part.type,
    data: JSON.parse(JSON.stringify(part.data)) as MessagePart["data"],
    createdAt: input.createdAt,
  } as MessagePart));
  return {
    id,
    chatId: input.chatId,
    generationId: input.generationId,
    role: input.role,
    content: input.content,
    parts,
    createdAt: input.createdAt,
    ...scope,
  };
}

function normalizeMemoryToolText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConfigurationError(`The ${label} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function compareMessages(left: MessageData, right: MessageData): number {
  return left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id);
}

function createPage<Item>(items: Item[], limit: number): RepositoryPage<Item> {
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}
