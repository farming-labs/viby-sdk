import type {
  AttachmentContent,
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  DesignEvaluationData,
  FrameworkId,
  GenerationAttemptData,
  GenerationData,
  GenerationEvent,
  GenerationEventDataMap,
  GenerationEventType,
  GeneratedArtifactContent,
  GeneratedArtifactData,
  GenerationTaskData,
  MessageData,
  MessagePart,
  MessagePartInput,
  JsonValue,
  ProjectArtifactContent,
  ResolvedSkill,
  SourceChange,
  ToolCallData,
  UserScope,
  VersionData,
  VersionEntry,
  VersionFile,
  VisualArtifactContent,
  VisualArtifactData,
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
  ClaimOutboundEventDeliveryRecord,
  CompleteGenerationRecord,
  CompleteToolCallRecord,
  CreateAttemptRecord,
  CreatedGeneration,
  CreateGenerationRecord,
  CreateVisualArtifactRecord,
  CreateToolCallRecord,
  DeleteChatRecord,
  CreatedToolCall,
  CreateSourceVersionRecord,
  CreateDesignEvaluationRecord,
  DesignEvaluationPageCursor,
  ForkVersionRecord,
  FailOutboundEventDeliveryRecord,
  FailToolCallRecord,
  GenerationWorkerLease,
  ImportedChat,
  ImportChatRecord,
  MessagePageCursor,
  PauseGenerationRecord,
  OutboundEventDeliveryClaim,
  Repository,
  RepositoryPage,
  ResolveGenerationTaskRecord,
  RestoreVersionRecord,
  UpdateChatRecord,
  VersionPageCursor,
} from "../../src/repository.js";
import { createId, sha256 } from "../../src/utils.js";
import { ConfigurationError, GenerationStateError, NotFoundError } from "../../src/errors.js";
import { normalizeAndRedactToolPayload } from "../../src/redaction.js";
import type { GenerationCostData } from "../../src/telemetry.js";
import type {
  OutboundEventDeliveryData,
  OutboundEventDeliveryStatus,
} from "../../src/outbound-events.js";
import type {
  BeginRepositoryPushRecord,
  CompleteRepositoryPushRecord,
  FailRepositoryPushRecord,
  RepositoryLinkData,
  RepositoryPushData,
} from "../../src/repository-history.js";
import type {
  BeginDeploymentRecord,
  CompleteDeploymentRecord,
  DeploymentProjectLinkData,
  DeploymentRecordData,
  DeploymentStatusTransitionData,
  FailDeploymentRecord,
  ObserveDeploymentRecord,
} from "../../src/deployment-history.js";
import type {
  CreateDeploymentArtifactRecord,
  DeploymentArtifactContent,
  DeploymentArtifactData,
} from "../../src/deployment-preparation.js";

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
  readonly finishReason?: string | null;
  readonly parts: readonly MessagePartInput[];
  readonly createdAt: Date;
  readonly attachments?: CreateGenerationRecord["attachments"];
}

type MemoryOutboundEventDelivery = OutboundEventDeliveryData & ScopedRecord & {
  leaseToken: string | null;
  leaseExpiresAt: Date | null;
};

export class MemoryRepository implements Repository {
  readonly chats = new Map<string, MemoryChatRecord>();
  readonly generations = new Map<string, GenerationData & ScopedRecord>();
  readonly attempts = new Map<string, GenerationAttemptData & ScopedRecord>();
  readonly versions = new Map<string, VersionData & ScopedRecord>();
  readonly designEvaluations = new Map<string, DesignEvaluationData & ScopedRecord>();
  readonly messages: Array<MessageData & ScopedRecord> = [];
  readonly attachments = new Map<string, AttachmentContent & ScopedRecord>();
  readonly generatedArtifacts = new Map<string, GeneratedArtifactContent & ScopedRecord>();
  readonly visualArtifacts = new Map<string, VisualArtifactContent & ScopedRecord>();
  readonly files = new Map<string, VersionEntry[]>();
  readonly projectArtifacts = new Map<string, ProjectArtifactContent & ScopedRecord>();
  readonly changes = new Map<string, SourceChange[]>();
  readonly events: Array<GenerationEvent & ScopedRecord> = [];
  readonly tasks = new Map<string, GenerationTaskData & ScopedRecord>();
  readonly skills = new Map<string, ResolvedSkill[]>();
  readonly sandboxLeases = new Map<string, SandboxLeaseData & ScopedRecord>();
  readonly outboundDeliveries = new Map<string, MemoryOutboundEventDelivery>();
  readonly toolCalls = new Map<string, ToolCallData & ScopedRecord>();
  readonly repositoryLinks = new Map<string, RepositoryLinkData & ScopedRecord>();
  readonly repositoryPushes = new Map<string, RepositoryPushData & ScopedRecord>();
  readonly deploymentProjects = new Map<string, DeploymentProjectLinkData & ScopedRecord>();
  readonly deployments = new Map<string, DeploymentRecordData & ScopedRecord>();
  readonly deploymentArtifacts = new Map<string, DeploymentArtifactContent & ScopedRecord>();
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
    const artifacts = input.artifacts ?? [];
    this.files.set(version.id, [
      ...input.files.map((file) => ({ ...file, type: "text" as const })),
      ...artifacts.map(({ bytes: _bytes, ...entry }) => entry),
    ]);
    for (const artifact of artifacts) {
      this.projectArtifacts.set(artifact.artifactId, {
        id: artifact.artifactId,
        mediaType: artifact.mediaType,
        size: artifact.size,
        checksum: artifact.checksum,
        artifact: { store: "memory", key: `project/${artifact.artifactId}` },
        bytes: Uint8Array.from(artifact.bytes),
        createdAt: new Date(),
        ...scope,
      });
    }
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
    this.files.set(version.id, [
      ...input.files.map((file) => ({ ...file, type: "text" as const })),
      ...(input.artifacts ?? []),
    ]);
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
      for (const [artifactId, artifact] of this.projectArtifacts) {
        if (!inScope(artifact, scope)) continue;
        const referenced = [...this.files.values()].some((entries) => entries.some((entry) => (
          entry.type === "artifact" && entry.artifactId === artifactId
        )));
        if (!referenced) this.projectArtifacts.delete(artifactId);
      }
      for (const [evaluationId, evaluation] of this.designEvaluations) {
        if (versionIds.includes(evaluation.versionId)) this.designEvaluations.delete(evaluationId);
      }
      for (let index = this.messages.length - 1; index >= 0; index -= 1) {
        if (this.messages[index]?.chatId === id) this.messages.splice(index, 1);
      }
      for (const [attachmentId, attachment] of this.attachments) {
        if (attachment.chatId === id && inScope(attachment, scope)) {
          this.attachments.delete(attachmentId);
        }
      }
      for (const [artifactId, artifact] of this.generatedArtifacts) {
        if (artifact.chatId === id && inScope(artifact, scope)) {
          this.generatedArtifacts.delete(artifactId);
        }
      }
      for (const [artifactId, artifact] of this.visualArtifacts) {
        if (artifact.chatId === id && inScope(artifact, scope)) {
          this.visualArtifacts.delete(artifactId);
        }
      }
      for (const [artifactId, artifact] of this.deploymentArtifacts) {
        if (artifact.chatId === id && inScope(artifact, scope)) {
          this.deploymentArtifacts.delete(artifactId);
        }
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
      configuration: input.configuration ?? {
        model: "default",
        instructions: null,
        skills: {},
        metadata: {},
      },
      inputTokens: null,
      outputTokens: null,
      totalTokens: null,
      cost: null,
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
      cost: null,
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
      attachments: input.attachments ?? [],
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
        const models = input.models ?? [{ provider: input.modelProvider, id: input.modelId }];
        if (!models.some((model) => (
          generation.modelProvider === model.provider && generation.modelId === model.id
        ))) {
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
      cost: null,
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
    this.files.set(version.id, [
      ...input.files.map((file) => ({ ...file, type: "text" as const })),
      ...(input.projectArtifacts ?? []),
    ]);
    if (input.changes) {
      this.changes.set(version.id, input.changes.map((change) => ({ ...change })));
    }
    this.attempts.set(attempt.id, {
      ...attempt,
      status: "succeeded",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      cost: input.cost,
      finishReason: input.finishReason,
      completedAt,
    });
    this.generations.set(generation.id, {
      ...generation,
      status: "succeeded",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      cost: addCost(generation.cost, input.cost),
      error: null,
      completedAt,
    });
    this.#addMessage(scope, {
      chatId: generation.chatId,
      generationId: generation.id,
      attemptId: input.attemptId,
      role: "assistant",
      content: input.assistantMessage,
      finishReason: input.finishReason,
      parts: input.assistantParts,
      createdAt: completedAt,
    });
    this.#addGeneratedArtifacts(
      scope,
      generation.chatId,
      generation.id,
      attempt.id,
      version.id,
      input.artifacts ?? [],
      completedAt,
    );
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
      cost: input.cost,
      finishReason: input.finishReason,
      completedAt: now,
    });
    this.generations.set(generation.id, {
      ...generation,
      status: "waiting",
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      totalTokens: input.totalTokens,
      cost: addCost(generation.cost, input.cost),
      error: null,
    });
    this.#addMessage(scope, {
      chatId: generation.chatId,
      generationId: generation.id,
      attemptId: input.attemptId,
      role: "assistant",
      content: input.task.message,
      finishReason: input.finishReason,
      parts: input.assistantParts,
      createdAt: now,
    });
    this.#addGeneratedArtifacts(
      scope,
      generation.chatId,
      generation.id,
      attempt.id,
      null,
      input.artifacts ?? [],
      now,
    );
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
      cost: null,
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

  async claimOutboundEventDelivery(
    scope: UserScope,
    input: ClaimOutboundEventDeliveryRecord,
  ): Promise<OutboundEventDeliveryClaim | null> {
    this.#requireGeneration(scope, input.generationId);
    const event = this.events.find((candidate) => (
      inScope(candidate, scope)
      && candidate.generationId === input.generationId
      && candidate.cursor === input.eventCursor
    ));
    if (!event) return null;
    const key = outboundDeliveryKey(input.generationId, input.eventCursor, input.sinkId);
    const now = new Date();
    const existing = this.outboundDeliveries.get(key);
    const delivery: MemoryOutboundEventDelivery = existing ?? {
      generationId: input.generationId,
      eventCursor: input.eventCursor,
      eventId: `${input.generationId}:${input.eventCursor}`,
      sinkId: input.sinkId,
      status: "pending",
      attemptCount: 0,
      maxAttempts: input.maxAttempts,
      nextAttemptAt: now,
      leaseExpiresAt: null,
      lastError: null,
      deliveredAt: null,
      deadLetteredAt: null,
      createdAt: now,
      updatedAt: now,
      leaseToken: null,
      ...scope,
    };
    const claimable = delivery.attemptCount < delivery.maxAttempts && (
      (delivery.status === "pending" && delivery.nextAttemptAt <= now)
      || (delivery.status === "delivering" && delivery.leaseExpiresAt !== null
        && delivery.leaseExpiresAt <= now)
    );
    if (!claimable) {
      if (!existing) this.outboundDeliveries.set(key, delivery);
      return null;
    }
    const claimed: MemoryOutboundEventDelivery = {
      ...delivery,
      status: "delivering",
      attemptCount: delivery.attemptCount + 1,
      leaseToken: input.leaseToken,
      leaseExpiresAt: new Date(now.getTime() + input.leaseMs),
      updatedAt: now,
    };
    this.outboundDeliveries.set(key, claimed);
    return { delivery: publicOutboundDelivery(claimed), leaseToken: input.leaseToken };
  }

  async getOutboundEventDelivery(
    scope: UserScope,
    generationId: string,
    eventCursor: string,
    sinkId: string,
  ): Promise<OutboundEventDeliveryData | null> {
    const delivery = this.outboundDeliveries.get(
      outboundDeliveryKey(generationId, eventCursor, sinkId),
    );
    return delivery && inScope(delivery, scope) ? publicOutboundDelivery(delivery) : null;
  }

  async completeOutboundEventDelivery(
    scope: UserScope,
    claim: OutboundEventDeliveryClaim,
    deliveredAt: Date,
  ): Promise<OutboundEventDeliveryData> {
    const key = outboundDeliveryKey(
      claim.delivery.generationId,
      claim.delivery.eventCursor,
      claim.delivery.sinkId,
    );
    const delivery = this.outboundDeliveries.get(key);
    if (
      !delivery
      || !inScope(delivery, scope)
      || delivery.status !== "delivering"
      || delivery.leaseToken !== claim.leaseToken
    ) throw new GenerationStateError(claim.delivery.generationId, "Outbound event delivery lease is no longer active.");
    const completed: MemoryOutboundEventDelivery = {
      ...delivery,
      status: "delivered",
      lastError: null,
      deliveredAt,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: new Date(),
    };
    this.outboundDeliveries.set(key, completed);
    return publicOutboundDelivery(completed);
  }

  async failOutboundEventDelivery(
    scope: UserScope,
    input: FailOutboundEventDeliveryRecord,
  ): Promise<OutboundEventDeliveryData> {
    const key = outboundDeliveryKey(input.generationId, input.eventCursor, input.sinkId);
    const delivery = this.outboundDeliveries.get(key);
    if (
      !delivery
      || !inScope(delivery, scope)
      || delivery.status !== "delivering"
      || delivery.leaseToken !== input.leaseToken
    ) throw new GenerationStateError(input.generationId, "Outbound event delivery lease is no longer active.");
    const now = new Date();
    const deadLettered = delivery.attemptCount >= delivery.maxAttempts;
    const failed: MemoryOutboundEventDelivery = {
      ...delivery,
      status: deadLettered ? "dead_lettered" : "pending",
      nextAttemptAt: new Date(now.getTime() + input.retryDelayMs),
      lastError: input.error,
      deadLetteredAt: deadLettered ? now : null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
    this.outboundDeliveries.set(key, failed);
    return publicOutboundDelivery(failed);
  }

  async listOutboundEventDeliveries(
    scope: UserScope,
    generationId: string,
    sinkId: string,
    status?: OutboundEventDeliveryStatus,
  ): Promise<OutboundEventDeliveryData[]> {
    this.#requireGeneration(scope, generationId);
    return [...this.outboundDeliveries.values()]
      .filter((delivery) => (
        inScope(delivery, scope)
        && delivery.generationId === generationId
        && delivery.sinkId === sinkId
        && (status === undefined || delivery.status === status)
      ))
      .sort((left, right) => Number(left.eventCursor) - Number(right.eventCursor))
      .map(publicOutboundDelivery);
  }

  async redriveOutboundEventDelivery(
    scope: UserScope,
    generationId: string,
    eventCursor: string,
    sinkId: string,
  ): Promise<OutboundEventDeliveryData> {
    const key = outboundDeliveryKey(generationId, eventCursor, sinkId);
    const delivery = this.outboundDeliveries.get(key);
    if (!delivery || !inScope(delivery, scope) || delivery.status !== "dead_lettered") {
      throw new NotFoundError("Dead-lettered outbound event delivery");
    }
    const now = new Date();
    const pending: MemoryOutboundEventDelivery = {
      ...delivery,
      status: "pending",
      attemptCount: 0,
      nextAttemptAt: now,
      lastError: null,
      deadLetteredAt: null,
      leaseToken: null,
      leaseExpiresAt: null,
      updatedAt: now,
    };
    this.outboundDeliveries.set(key, pending);
    return publicOutboundDelivery(pending);
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

  async createDesignEvaluation(
    scope: UserScope,
    input: CreateDesignEvaluationRecord,
  ): Promise<DesignEvaluationData> {
    const version = await this.getVersion(scope, input.versionId);
    if (!version || version.chatId !== input.chatId) throw new NotFoundError("Version");
    const chat = await this.getChat(scope, version.chatId);
    if (!chat) throw new NotFoundError("Version");
    const evaluation: DesignEvaluationData & ScopedRecord = {
      id: input.id,
      chatId: version.chatId,
      versionId: version.id,
      generationId: version.generationId,
      evaluator: input.evaluator,
      status: input.status,
      score: input.score,
      summary: input.summary,
      criteria: JSON.parse(JSON.stringify(input.criteria)) as DesignEvaluationData["criteria"],
      evidence: JSON.parse(JSON.stringify(input.evidence)) as DesignEvaluationData["evidence"],
      metadata: JSON.parse(JSON.stringify(input.metadata)) as ChatMetadata,
      createdAt: new Date(),
      ...scope,
    };
    this.designEvaluations.set(evaluation.id, evaluation);
    return evaluation;
  }

  async getDesignEvaluation(
    scope: UserScope,
    versionId: string,
    id: string,
  ): Promise<DesignEvaluationData | null> {
    const evaluation = this.designEvaluations.get(id);
    return evaluation && evaluation.versionId === versionId && inScope(evaluation, scope)
      ? evaluation
      : null;
  }

  async listDesignEvaluationPage(
    scope: UserScope,
    versionId: string,
    limit: number,
    after: DesignEvaluationPageCursor | null,
  ): Promise<RepositoryPage<DesignEvaluationData>> {
    let records = [...this.designEvaluations.values()]
      .filter((evaluation) => evaluation.versionId === versionId && inScope(evaluation, scope))
      .sort((left, right) => (
        right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)
      ));
    if (after) {
      records = records.filter((evaluation) => (
        evaluation.createdAt < after.createdAt
        || (
          evaluation.createdAt.getTime() === after.createdAt.getTime()
          && evaluation.id < after.id
        )
      ));
    }
    return createPage(records, limit);
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

  async getAttachment(
    scope: UserScope,
    chatId: string,
    id: string,
  ): Promise<AttachmentContent | null> {
    const attachment = this.attachments.get(id);
    return attachment && attachment.chatId === chatId && inScope(attachment, scope)
      ? { ...attachment, bytes: Uint8Array.from(attachment.bytes) }
      : null;
  }

  async listGenerationAttachments(
    scope: UserScope,
    generationId: string,
  ): Promise<AttachmentContent[]> {
    return [...this.attachments.values()]
      .filter((attachment) => attachment.generationId === generationId && inScope(attachment, scope))
      .sort((left, right) => (
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      ))
      .map((attachment) => ({ ...attachment, bytes: Uint8Array.from(attachment.bytes) }));
  }

  async listGeneratedArtifacts(
    scope: UserScope,
    generationId: string,
  ): Promise<GeneratedArtifactData[]> {
    this.#requireGeneration(scope, generationId);
    return [...this.generatedArtifacts.values()]
      .filter((artifact) => artifact.generationId === generationId && inScope(artifact, scope))
      .sort((left, right) => (
        left.createdAt.getTime() - right.createdAt.getTime()
        || left.attemptId.localeCompare(right.attemptId)
        || left.position - right.position
        || left.id.localeCompare(right.id)
      ))
      .map(({ bytes: _bytes, tenantId: _tenantId, userId: _userId, ...artifact }) => artifact);
  }

  async getGeneratedArtifact(
    scope: UserScope,
    generationId: string,
    id: string,
  ): Promise<GeneratedArtifactContent | null> {
    this.#requireGeneration(scope, generationId);
    const artifact = this.generatedArtifacts.get(id);
    return artifact && artifact.generationId === generationId && inScope(artifact, scope)
      ? { ...artifact, bytes: Uint8Array.from(artifact.bytes) }
      : null;
  }

  async createVisualArtifact(
    scope: UserScope,
    input: CreateVisualArtifactRecord,
  ): Promise<VisualArtifactData> {
    const version = await this.getVersion(scope, input.versionId);
    if (!version || version.chatId !== input.chatId) throw new NotFoundError("Version");
    const artifact: VisualArtifactContent & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      versionId: input.versionId,
      pageId: input.pageId,
      path: input.path,
      url: input.url,
      filename: input.filename,
      mediaType: input.mediaType,
      width: input.width,
      height: input.height,
      size: input.size,
      checksum: input.checksum,
      artifact: { store: "memory", key: `visual/${input.versionId}/${input.id}` },
      bytes: Uint8Array.from(input.bytes),
      createdAt: new Date(),
      ...scope,
    };
    this.visualArtifacts.set(artifact.id, artifact);
    const { bytes: _bytes, tenantId: _tenantId, userId: _userId, ...data } = artifact;
    return data;
  }

  async listVisualArtifacts(scope: UserScope, versionId: string): Promise<VisualArtifactData[]> {
    const version = await this.getVersion(scope, versionId);
    if (!version) return [];
    return [...this.visualArtifacts.values()]
      .filter((artifact) => artifact.versionId === versionId && inScope(artifact, scope))
      .sort((left, right) => (
        left.createdAt.getTime() - right.createdAt.getTime() || left.id.localeCompare(right.id)
      ))
      .map(({ bytes: _bytes, tenantId: _tenantId, userId: _userId, ...artifact }) => artifact);
  }

  async getVisualArtifact(
    scope: UserScope,
    versionId: string,
    id: string,
  ): Promise<VisualArtifactContent | null> {
    const artifact = this.visualArtifacts.get(id);
    return artifact && artifact.versionId === versionId && inScope(artifact, scope)
      ? { ...artifact, bytes: Uint8Array.from(artifact.bytes) }
      : null;
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
    return version
      ? (this.files.get(versionId) ?? [])
          .filter((entry) => entry.type === "text")
          .map(({ type: _type, ...entry }) => entry)
      : [];
  }

  async getVersionEntries(scope: UserScope, versionId: string): Promise<VersionEntry[]> {
    const version = await this.getVersion(scope, versionId);
    return version
      ? (this.files.get(versionId) ?? [])
          .map((entry) => ({ ...entry }))
          .sort((left, right) => left.path.localeCompare(right.path))
      : [];
  }

  async getProjectArtifact(
    scope: UserScope,
    versionId: string,
    artifactId: string,
  ): Promise<ProjectArtifactContent | null> {
    const version = await this.getVersion(scope, versionId);
    const referenced = version && (this.files.get(versionId) ?? []).some((entry) => (
      entry.type === "artifact" && entry.artifactId === artifactId
    ));
    const artifact = referenced ? this.projectArtifacts.get(artifactId) : undefined;
    return artifact && inScope(artifact, scope)
      ? { ...artifact, bytes: Uint8Array.from(artifact.bytes) }
      : null;
  }

  async getVersionChanges(scope: UserScope, versionId: string): Promise<SourceChange[]> {
    const version = await this.getVersion(scope, versionId);
    return version ? (this.changes.get(versionId) ?? []).map((change) => ({ ...change })) : [];
  }

  async beginRepositoryPush(
    scope: UserScope,
    input: BeginRepositoryPushRecord,
  ): Promise<RepositoryPushData> {
    const version = await this.getVersion(scope, input.versionId);
    if (!version || version.chatId !== input.chatId) throw new NotFoundError("Repository push version");
    const existing = [...this.repositoryPushes.values()].find((push) => (
      inScope(push, scope) && push.idempotencyKey === input.idempotencyKey
    ));
    if (existing) return publicRepositoryPush(existing);
    const push: RepositoryPushData & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      versionId: input.versionId,
      repositoryLinkId: null,
      integrationId: input.integrationId,
      connectionId: input.connectionId,
      provider: input.provider,
      target: { ...input.target },
      branch: input.branch,
      commitMessage: input.commitMessage,
      expectedHead: input.expectedHead,
      status: "pending",
      commit: null,
      changedFiles: null,
      pullRequest: null,
      actualHead: null,
      error: null,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
      ...scope,
    };
    this.repositoryPushes.set(push.id, push);
    return publicRepositoryPush(push);
  }

  async completeRepositoryPush(
    scope: UserScope,
    input: CompleteRepositoryPushRecord,
  ): Promise<RepositoryPushData> {
    const push = this.repositoryPushes.get(input.id);
    if (!push || !inScope(push, scope)) throw new NotFoundError("Repository push");
    const existingLink = [...this.repositoryLinks.values()].find((link) => (
      inScope(link, scope)
      && link.chatId === push.chatId
      && link.integrationId === push.integrationId
      && link.connectionId === push.connectionId
      && link.repositoryId === input.repository.id
    ));
    const now = input.completedAt;
    const link: RepositoryLinkData & ScopedRecord = {
      id: existingLink?.id ?? createId(),
      chatId: push.chatId,
      integrationId: push.integrationId,
      connectionId: push.connectionId,
      provider: push.provider,
      repositoryId: input.repository.id,
      owner: input.repository.owner,
      name: input.repository.name,
      defaultBranch: input.repository.defaultBranch,
      visibility: input.repository.visibility,
      url: input.repository.url,
      createdAt: existingLink?.createdAt ?? now,
      updatedAt: now,
      ...scope,
    };
    this.repositoryLinks.set(link.id, link);
    const completed: RepositoryPushData & ScopedRecord = input.result.status === "pushed"
      ? {
          ...push,
          repositoryLinkId: link.id,
          status: "pushed",
          commit: { ...input.result.commit },
          changedFiles: input.result.changedFiles,
          pullRequest: input.result.pullRequest ? { ...input.result.pullRequest } : null,
          actualHead: null,
          error: null,
          updatedAt: now,
          completedAt: now,
        }
      : {
          ...push,
          repositoryLinkId: link.id,
          status: "conflict",
          commit: null,
          changedFiles: null,
          pullRequest: null,
          actualHead: input.result.actualHead,
          error: null,
          updatedAt: now,
          completedAt: now,
        };
    this.repositoryPushes.set(push.id, completed);
    return publicRepositoryPush(completed);
  }

  async failRepositoryPush(
    scope: UserScope,
    input: FailRepositoryPushRecord,
  ): Promise<RepositoryPushData> {
    const push = this.repositoryPushes.get(input.id);
    if (!push || !inScope(push, scope)) throw new NotFoundError("Repository push");
    if (push.status !== "pending") return publicRepositoryPush(push);
    const failed: RepositoryPushData & ScopedRecord = {
      ...push,
      status: "failed",
      error: input.error,
      updatedAt: input.completedAt,
      completedAt: input.completedAt,
    };
    this.repositoryPushes.set(push.id, failed);
    return publicRepositoryPush(failed);
  }

  async listRepositoryLinks(scope: UserScope, chatId: string): Promise<RepositoryLinkData[]> {
    const chat = await this.getChat(scope, chatId);
    if (!chat) throw new NotFoundError("Chat");
    return [...this.repositoryLinks.values()]
      .filter((link) => inScope(link, scope) && link.chatId === chatId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .map(publicRepositoryLink);
  }

  async listRepositoryPushes(
    scope: UserScope,
    input: { readonly chatId: string; readonly versionId?: string },
  ): Promise<RepositoryPushData[]> {
    const chat = await this.getChat(scope, input.chatId);
    if (!chat) throw new NotFoundError("Chat");
    return [...this.repositoryPushes.values()]
      .filter((push) => (
        inScope(push, scope)
        && push.chatId === input.chatId
        && (input.versionId === undefined || push.versionId === input.versionId)
      ))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(publicRepositoryPush);
  }

  async beginDeployment(
    scope: UserScope,
    input: BeginDeploymentRecord,
  ): Promise<DeploymentRecordData> {
    const version = await this.getVersion(scope, input.versionId);
    if (!version || version.chatId !== input.chatId) throw new NotFoundError("Deployment version");
    const existing = [...this.deployments.values()].find((deployment) => (
      inScope(deployment, scope) && deployment.idempotencyKey === input.idempotencyKey
    ));
    if (existing) return publicDeployment(existing);
    const transition: DeploymentStatusTransitionData = {
      id: createId(),
      deploymentId: input.id,
      status: "pending",
      url: null,
      error: null,
      createdAt: input.now,
    };
    const deployment: DeploymentRecordData & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      versionId: input.versionId,
      projectLinkId: null,
      preparationArtifactId: null,
      integrationId: input.integrationId,
      connectionId: input.connectionId,
      provider: input.provider,
      projectTarget: input.projectTarget,
      environment: input.environment,
      providerDeploymentId: null,
      providerCreatedAt: null,
      url: null,
      status: "pending",
      error: null,
      idempotencyKey: input.idempotencyKey,
      transitions: [transition],
      createdAt: input.now,
      updatedAt: input.now,
      completedAt: null,
      ...scope,
    };
    this.deployments.set(deployment.id, deployment);
    return publicDeployment(deployment);
  }

  async completeDeployment(
    scope: UserScope,
    input: CompleteDeploymentRecord,
  ): Promise<DeploymentRecordData> {
    const deployment = this.deployments.get(input.id);
    if (!deployment || !inScope(deployment, scope)) throw new NotFoundError("Deployment");
    const existingProject = [...this.deploymentProjects.values()].find((project) => (
      inScope(project, scope)
      && project.chatId === deployment.chatId
      && project.integrationId === deployment.integrationId
      && project.connectionId === deployment.connectionId
      && project.providerProjectId === input.project.id
    ));
    const project: DeploymentProjectLinkData & ScopedRecord = {
      id: existingProject?.id ?? createId(),
      chatId: deployment.chatId,
      integrationId: deployment.integrationId,
      connectionId: deployment.connectionId,
      provider: deployment.provider,
      providerProjectId: input.project.id,
      name: input.project.name,
      url: input.project.url,
      createdAt: existingProject?.createdAt ?? input.observedAt,
      updatedAt: input.observedAt,
      ...scope,
    };
    this.deploymentProjects.set(project.id, project);
    const completed = updateMemoryDeployment(
      deployment,
      input.deployment,
      input.observedAt,
      project.id,
    );
    this.deployments.set(completed.id, completed);
    return publicDeployment(completed);
  }

  async failDeployment(
    scope: UserScope,
    input: FailDeploymentRecord,
  ): Promise<DeploymentRecordData> {
    const deployment = this.deployments.get(input.id);
    if (!deployment || !inScope(deployment, scope)) throw new NotFoundError("Deployment");
    if (deployment.status !== "pending") return publicDeployment(deployment);
    const failed: DeploymentRecordData & ScopedRecord = {
      ...deployment,
      status: "failed",
      error: input.error,
      transitions: [...deployment.transitions, {
        id: createId(),
        deploymentId: deployment.id,
        status: "failed",
        url: deployment.url,
        error: input.error,
        createdAt: input.observedAt,
      }],
      updatedAt: input.observedAt,
      completedAt: input.observedAt,
    };
    this.deployments.set(failed.id, failed);
    return publicDeployment(failed);
  }

  async observeDeployment(
    scope: UserScope,
    input: ObserveDeploymentRecord,
  ): Promise<DeploymentRecordData | null> {
    const deployment = [...this.deployments.values()].find((candidate) => (
      inScope(candidate, scope)
      && candidate.integrationId === input.integrationId
      && candidate.connectionId === input.connectionId
      && candidate.provider === input.provider
      && candidate.providerDeploymentId === input.deployment.id
    ));
    if (!deployment) return null;
    const observed = updateMemoryDeployment(deployment, input.deployment, input.observedAt);
    this.deployments.set(observed.id, observed);
    return publicDeployment(observed);
  }

  async listDeploymentProjects(
    scope: UserScope,
    chatId: string,
  ): Promise<DeploymentProjectLinkData[]> {
    const chat = await this.getChat(scope, chatId);
    if (!chat) throw new NotFoundError("Chat");
    return [...this.deploymentProjects.values()]
      .filter((project) => inScope(project, scope) && project.chatId === chatId)
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime())
      .map(publicDeploymentProject);
  }

  async listDeployments(
    scope: UserScope,
    input: { readonly chatId: string; readonly versionId?: string },
  ): Promise<DeploymentRecordData[]> {
    const chat = await this.getChat(scope, input.chatId);
    if (!chat) throw new NotFoundError("Chat");
    return [...this.deployments.values()]
      .filter((deployment) => (
        inScope(deployment, scope)
        && deployment.chatId === input.chatId
        && (input.versionId === undefined || deployment.versionId === input.versionId)
      ))
      .sort((left, right) => right.createdAt.getTime() - left.createdAt.getTime())
      .map(publicDeployment);
  }

  async createDeploymentArtifact(
    scope: UserScope,
    input: CreateDeploymentArtifactRecord,
  ): Promise<DeploymentArtifactData> {
    const deployment = this.deployments.get(input.deploymentId);
    if (
      !deployment
      || !inScope(deployment, scope)
      || deployment.chatId !== input.chatId
      || deployment.versionId !== input.versionId
    ) throw new NotFoundError("Deployment");
    const existing = [...this.deploymentArtifacts.values()].find((artifact) => (
      inScope(artifact, scope) && artifact.deploymentId === input.deploymentId
    ));
    if (existing) return publicDeploymentArtifact(existing);
    if (input.bytes.byteLength !== input.size || sha256(input.bytes) !== input.checksum) {
      throw new ConfigurationError("Deployment artifact size or checksum is invalid.");
    }
    const artifact: DeploymentArtifactContent & ScopedRecord = {
      id: input.id,
      chatId: input.chatId,
      versionId: input.versionId,
      deploymentId: input.deploymentId,
      framework: input.framework,
      sandboxProvider: input.sandboxProvider,
      outputDirectory: input.outputDirectory,
      commands: input.commands.map((command) => ({
        ...command,
        args: [...command.args],
        environment: [...command.environment],
      })),
      fileCount: input.fileCount,
      mediaType: "application/zip",
      size: input.size,
      checksum: input.checksum,
      artifact: { store: "memory", key: `deployments/${input.deploymentId}/${input.id}.zip` },
      bytes: Uint8Array.from(input.bytes),
      createdAt: new Date(),
      ...scope,
    };
    this.deploymentArtifacts.set(artifact.id, artifact);
    this.deployments.set(deployment.id, {
      ...deployment,
      preparationArtifactId: artifact.id,
      updatedAt: artifact.createdAt,
    });
    return publicDeploymentArtifact(artifact);
  }

  async getDeploymentArtifact(
    scope: UserScope,
    deploymentId: string,
    artifactId: string,
  ): Promise<DeploymentArtifactContent | null> {
    const artifact = this.deploymentArtifacts.get(artifactId);
    if (!artifact || !inScope(artifact, scope) || artifact.deploymentId !== deploymentId) return null;
    const deployment = this.deployments.get(deploymentId);
    if (!deployment || !inScope(deployment, scope)) return null;
    return {
      ...publicDeploymentArtifact(artifact),
      bytes: Uint8Array.from(artifact.bytes),
    };
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
    for (const [index, attachment] of (input.attachments ?? []).entries()) {
      const data = message.attachments[index]!;
      this.attachments.set(data.id, {
        ...data,
        bytes: Uint8Array.from(attachment.bytes),
        ...scope,
      });
    }
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

  #addGeneratedArtifacts(
    scope: UserScope,
    chatId: string,
    generationId: string,
    attemptId: string,
    versionId: string | null,
    artifacts: NonNullable<CompleteGenerationRecord["artifacts"]>,
    createdAt: Date,
  ): void {
    for (const artifact of artifacts) {
      const data: GeneratedArtifactContent & ScopedRecord = {
        id: artifact.id,
        chatId,
        generationId,
        attemptId,
        versionId,
        position: artifact.position,
        kind: artifact.kind,
        filename: artifact.filename,
        mediaType: artifact.mediaType,
        size: artifact.size,
        checksum: artifact.checksum,
        artifact: { store: "memory", key: `generated/${generationId}/${artifact.id}` },
        bytes: Uint8Array.from(artifact.bytes),
        createdAt,
        ...scope,
      };
      this.generatedArtifacts.set(data.id, data);
      this.#append(scope, generationId, attemptId, "artifact.created", {
        artifactId: data.id,
        position: data.position,
        kind: data.kind,
        filename: data.filename,
        mediaType: data.mediaType,
        size: data.size,
        checksum: data.checksum,
      });
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

function publicRepositoryLink(record: RepositoryLinkData & ScopedRecord): RepositoryLinkData {
  const { tenantId: _tenantId, userId: _userId, ...data } = record;
  return { ...data };
}

function publicRepositoryPush(record: RepositoryPushData & ScopedRecord): RepositoryPushData {
  const { tenantId: _tenantId, userId: _userId, ...data } = record;
  return {
    ...data,
    target: { ...data.target },
    commit: data.commit ? { ...data.commit } : null,
    pullRequest: data.pullRequest ? { ...data.pullRequest } : null,
  };
}

function publicDeploymentProject(
  record: DeploymentProjectLinkData & ScopedRecord,
): DeploymentProjectLinkData {
  const { tenantId: _tenantId, userId: _userId, ...data } = record;
  return { ...data };
}

function publicDeployment(record: DeploymentRecordData & ScopedRecord): DeploymentRecordData {
  const { tenantId: _tenantId, userId: _userId, ...data } = record;
  return { ...data, transitions: data.transitions.map((transition) => ({ ...transition })) };
}

function publicDeploymentArtifact(
  record: DeploymentArtifactContent & ScopedRecord,
): DeploymentArtifactData {
  const { tenantId: _tenantId, userId: _userId, bytes: _bytes, ...data } = record;
  return {
    ...data,
    commands: data.commands.map((command) => ({
      ...command,
      args: [...command.args],
      environment: [...command.environment],
    })),
    artifact: { ...data.artifact },
  };
}

function updateMemoryDeployment(
  record: DeploymentRecordData & ScopedRecord,
  observation: {
    readonly id: string;
    readonly status: DeploymentRecordData["status"];
    readonly url: string | null;
    readonly createdAt?: Date;
  },
  observedAt: Date,
  projectLinkId = record.projectLinkId,
): DeploymentRecordData & ScopedRecord {
  const changed = record.status !== observation.status || record.url !== observation.url;
  const terminal = observation.status === "ready"
    || observation.status === "failed"
    || observation.status === "cancelled";
  return {
    ...record,
    projectLinkId,
    providerDeploymentId: observation.id,
    providerCreatedAt: observation.createdAt ?? record.providerCreatedAt,
    status: observation.status,
    url: observation.url,
    error: null,
    transitions: changed ? [...record.transitions, {
      id: createId(),
      deploymentId: record.id,
      status: observation.status,
      url: observation.url,
      error: null,
      createdAt: observedAt,
    }] : record.transitions,
    updatedAt: observedAt,
    completedAt: terminal ? observedAt : null,
  };
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
  const attachments = (input.attachments ?? []).map((attachment) => ({
    id: attachment.id,
    chatId: input.chatId,
    messageId: id,
    generationId: input.generationId,
    filename: attachment.filename,
    mediaType: attachment.mediaType,
    size: attachment.size,
    checksum: attachment.checksum,
    artifact: { store: "memory", key: `attachments/${attachment.id}` },
    createdAt: input.createdAt,
  }));
  return {
    id,
    chatId: input.chatId,
    generationId: input.generationId,
    role: input.role,
    content: input.content,
    finishReason: input.finishReason ?? null,
    parts,
    attachments,
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

function addCost(
  previous: GenerationCostData | null,
  current: GenerationCostData | null,
): GenerationCostData | null {
  if (!current) return previous;
  if (!previous) return current;
  if (previous.currency !== current.currency) {
    throw new ConfigurationError("Generation cost currency cannot change between attempts.");
  }
  return {
    amountMicros: previous.amountMicros + current.amountMicros,
    currency: current.currency,
  };
}

function outboundDeliveryKey(
  generationId: string,
  eventCursor: string,
  sinkId: string,
): string {
  return `${generationId}:${eventCursor}:${sinkId}`;
}

function publicOutboundDelivery(
  delivery: MemoryOutboundEventDelivery,
): OutboundEventDeliveryData {
  return {
    generationId: delivery.generationId,
    eventCursor: delivery.eventCursor,
    eventId: delivery.eventId,
    sinkId: delivery.sinkId,
    status: delivery.status,
    attemptCount: delivery.attemptCount,
    maxAttempts: delivery.maxAttempts,
    nextAttemptAt: delivery.nextAttemptAt,
    leaseExpiresAt: delivery.leaseExpiresAt,
    lastError: delivery.lastError,
    deliveredAt: delivery.deliveredAt,
    deadLetteredAt: delivery.deadLetteredAt,
    createdAt: delivery.createdAt,
    updatedAt: delivery.updatedAt,
  };
}
