import type {
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  FrameworkId,
  GenerationAttemptData,
  GenerationAttemptReason,
  GenerationData,
  GenerationConfigurationData,
  GenerationEvent,
  GenerationEventDataMap,
  GenerationEventType,
  GenerationTaskData,
  GenerationTaskRequest,
  GenerationTaskResolution,
  MessageData,
  MessagePartInput,
  ResolvedSkill,
  UserScope,
  VersionData,
  VersionFile,
  VersionOrigin,
  SourceChange,
  JsonValue,
  ToolCallData,
  ToolCallEffect,
} from "./types.js";
import type { GenerationCostData } from "./telemetry.js";
import type {
  OutboundEventDeliveryData,
  OutboundEventDeliveryStatus,
} from "./outbound-events.js";
import type {
  CreateSandboxLeaseRecord,
  SandboxLeaseData,
  SandboxLeaseStatus,
} from "./sandbox.js";

export interface ImportChatRecord<Framework extends FrameworkId = FrameworkId> {
  readonly chatId: string;
  readonly versionId: string;
  readonly title: string;
  readonly metadata: ChatMetadata;
  readonly summary: string;
  readonly framework: Framework;
  readonly files: readonly VersionFile[];
}

export interface ImportedChat<Framework extends FrameworkId = FrameworkId> {
  readonly chat: ChatData<Framework>;
  readonly version: VersionData<Framework>;
}

export interface CreateSourceVersionRecord<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly chatId: string;
  readonly parentVersionId: string;
  readonly origin: Exclude<VersionOrigin, "generated" | "imported">;
  readonly framework: Framework;
  readonly title: string;
  readonly summary: string;
  readonly files: readonly VersionFile[];
  readonly changes: readonly SourceChange[];
}

export interface ForkVersionRecord<Framework extends FrameworkId = FrameworkId> {
  readonly chatId: string;
  readonly versionId: string;
  readonly sourceVersionId: string;
  readonly title: string;
  readonly metadata: ChatMetadata;
  readonly summary: string;
  readonly framework: Framework;
}

export interface UpdateChatRecord {
  readonly title: string;
  readonly metadata: ChatMetadata;
}

export interface DeleteChatRecord {
  readonly deletedAt: Date;
  readonly purgeAfter: Date | null;
}

export interface RepositoryPage<Item> {
  readonly items: Item[];
  readonly hasMore: boolean;
}

export interface ChatPageCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

export interface MessagePageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface VersionPageCursor {
  readonly number: number;
}

export interface RestoreVersionRecord<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly chatId: string;
  readonly sourceVersionId: string;
  readonly title: string;
  readonly summary: string;
  readonly framework: Framework;
}

export interface CreateGenerationRecord {
  readonly id: string;
  readonly attemptId: string;
  readonly chatId: string;
  readonly baseVersionId: string | null;
  readonly prompt: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly configuration?: GenerationConfigurationData;
}

export interface CreatedGeneration {
  readonly generation: GenerationData;
  readonly attempt: GenerationAttemptData;
}

export interface CreateAttemptRecord {
  readonly id: string;
  readonly generationId: string;
  readonly reason: Exclude<GenerationAttemptReason, "initial" | "task_resolution">;
}

export interface CompleteGenerationRecord<Framework extends FrameworkId = FrameworkId> {
  readonly generationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly parentVersionId: string | null;
  readonly framework: Framework;
  readonly title: string;
  readonly summary: string;
  readonly files: readonly VersionFile[];
  readonly changes: readonly SourceChange[] | null;
  readonly assistantMessage: string;
  readonly assistantParts: readonly MessagePartInput[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string;
  readonly cost: GenerationCostData | null;
}

export interface PauseGenerationRecord {
  readonly generationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly taskId: string;
  readonly task: GenerationTaskRequest;
  readonly assistantParts: readonly MessagePartInput[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string;
  readonly cost: GenerationCostData | null;
}

export interface ResolveGenerationTaskRecord {
  readonly generationId: string;
  readonly taskId: string;
  readonly attemptId: string;
  readonly resolution: GenerationTaskResolution;
  readonly resolutionMessage: string;
}

export interface AppendGenerationEventRecord<Type extends GenerationEventType> {
  readonly generationId: string;
  readonly attemptId: string | null;
  readonly leaseToken: string;
  readonly type: Type;
  readonly data: GenerationEventDataMap[Type];
}

export interface CreateToolCallRecord {
  readonly id: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly providerCallId: string;
  readonly name: string;
  readonly effect: ToolCallEffect;
  readonly arguments: JsonValue;
  readonly idempotencyKey?: string;
}

export interface CreatedToolCall {
  readonly toolCall: ToolCallData;
  readonly created: boolean;
}

export interface CompleteToolCallRecord {
  readonly id: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly result: JsonValue;
}

export interface FailToolCallRecord {
  readonly id: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly error: string;
}

export interface ClaimGenerationAttemptRecord<Framework extends FrameworkId = FrameworkId> {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseMs: number;
  readonly framework: Framework;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly models?: readonly {
    readonly provider: string;
    readonly id: string;
  }[];
  readonly attemptId?: string;
}

export interface GenerationWorkerLease {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly scope: UserScope;
  readonly generationId: string;
  readonly attemptId: string;
  readonly expiresAt: Date;
}

export interface ClaimOutboundEventDeliveryRecord {
  readonly generationId: string;
  readonly eventCursor: string;
  readonly sinkId: string;
  readonly leaseToken: string;
  readonly leaseMs: number;
  readonly maxAttempts: number;
}

export interface OutboundEventDeliveryClaim {
  readonly delivery: OutboundEventDeliveryData;
  readonly leaseToken: string;
}

export interface FailOutboundEventDeliveryRecord {
  readonly generationId: string;
  readonly eventCursor: string;
  readonly sinkId: string;
  readonly leaseToken: string;
  readonly error: string;
  readonly retryDelayMs: number;
}

export interface Repository {
  assertReady(): Promise<void>;
  close(): Promise<void>;
  createChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: { id: string; title: string; metadata: ChatMetadata; framework: Framework },
  ): Promise<ChatData<Framework>>;
  importChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: ImportChatRecord<Framework>,
  ): Promise<ImportedChat<Framework>>;
  createSourceVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSourceVersionRecord<Framework>,
  ): Promise<VersionData<Framework>>;
  forkVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: ForkVersionRecord<Framework>,
  ): Promise<ImportedChat<Framework>>;
  restoreVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: RestoreVersionRecord<Framework>,
  ): Promise<VersionData<Framework>>;
  updateChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    input: UpdateChatRecord,
  ): Promise<ChatData<Framework>>;
  deleteChat(
    scope: UserScope,
    id: string,
    input: DeleteChatRecord,
  ): Promise<ChatDeletionData>;
  restoreChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    now: Date,
  ): Promise<ChatData<Framework>>;
  purgeDeletedChats(scope: UserScope, now: Date, limit: number): Promise<number>;
  getChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<ChatData<Framework> | null>;
  listChats<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
  ): Promise<Array<ChatData<Framework>>>;
  listChatPage<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
    after: ChatPageCursor | null,
    metadata: ChatMetadata,
  ): Promise<RepositoryPage<ChatData<Framework>>>;
  createGeneration(scope: UserScope, input: CreateGenerationRecord): Promise<CreatedGeneration>;
  startGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
  ): Promise<GenerationAttemptData>;
  claimGenerationAttempt<Framework extends FrameworkId>(
    input: ClaimGenerationAttemptRecord<Framework>,
  ): Promise<GenerationWorkerLease | null>;
  heartbeatGenerationAttempt(
    lease: GenerationWorkerLease,
    leaseMs: number,
  ): Promise<Date | null>;
  createGenerationAttempt(
    scope: UserScope,
    input: CreateAttemptRecord,
  ): Promise<GenerationAttemptData>;
  attachGenerationSkills(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    skills: readonly ResolvedSkill[],
  ): Promise<void>;
  getGenerationSkills(scope: UserScope, generationId: string): Promise<ResolvedSkill[] | null>;
  appendGenerationEvent<Type extends GenerationEventType>(
    scope: UserScope,
    input: AppendGenerationEventRecord<Type>,
  ): Promise<void>;
  createToolCall(scope: UserScope, input: CreateToolCallRecord): Promise<CreatedToolCall>;
  completeToolCall(scope: UserScope, input: CompleteToolCallRecord): Promise<ToolCallData>;
  failToolCall(scope: UserScope, input: FailToolCallRecord): Promise<ToolCallData>;
  completeGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    input: CompleteGenerationRecord<Framework>,
  ): Promise<VersionData<Framework>>;
  pauseGeneration(
    scope: UserScope,
    input: PauseGenerationRecord,
  ): Promise<GenerationTaskData>;
  resolveGenerationTask(
    scope: UserScope,
    input: ResolveGenerationTaskRecord,
  ): Promise<GenerationAttemptData>;
  failGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    error: string,
  ): Promise<void>;
  cancelGeneration(scope: UserScope, generationId: string, reason: string): Promise<boolean>;
  getGeneration(scope: UserScope, id: string): Promise<GenerationData | null>;
  listGenerationAttempts(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationAttemptData[]>;
  listGenerationEvents(
    scope: UserScope,
    generationId: string,
    after: string,
    limit: number,
  ): Promise<GenerationEvent[]>;
  claimOutboundEventDelivery(
    scope: UserScope,
    input: ClaimOutboundEventDeliveryRecord,
  ): Promise<OutboundEventDeliveryClaim | null>;
  getOutboundEventDelivery(
    scope: UserScope,
    generationId: string,
    eventCursor: string,
    sinkId: string,
  ): Promise<OutboundEventDeliveryData | null>;
  completeOutboundEventDelivery(
    scope: UserScope,
    claim: OutboundEventDeliveryClaim,
    deliveredAt: Date,
  ): Promise<OutboundEventDeliveryData>;
  failOutboundEventDelivery(
    scope: UserScope,
    input: FailOutboundEventDeliveryRecord,
  ): Promise<OutboundEventDeliveryData>;
  listOutboundEventDeliveries(
    scope: UserScope,
    generationId: string,
    sinkId: string,
    status?: OutboundEventDeliveryStatus,
  ): Promise<OutboundEventDeliveryData[]>;
  redriveOutboundEventDelivery(
    scope: UserScope,
    generationId: string,
    eventCursor: string,
    sinkId: string,
  ): Promise<OutboundEventDeliveryData>;
  listGenerationTasks(scope: UserScope, generationId: string): Promise<GenerationTaskData[]>;
  listToolCalls(scope: UserScope, generationId: string): Promise<ToolCallData[]>;
  getVersionByGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    generationId: string,
  ): Promise<VersionData<Framework> | null>;
  getVersion<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<VersionData<Framework> | null>;
  getLatestVersion<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<VersionData<Framework> | null>;
  listVersions<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<Array<VersionData<Framework>>>;
  listVersionPage<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: VersionPageCursor | null,
  ): Promise<RepositoryPage<VersionData<Framework>>>;
  listMessages(scope: UserScope, chatId: string): Promise<MessageData[]>;
  getMessage(scope: UserScope, chatId: string, id: string): Promise<MessageData | null>;
  listMessagePage(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: MessagePageCursor | null,
  ): Promise<RepositoryPage<MessageData>>;
  getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]>;
  getVersionChanges(scope: UserScope, versionId: string): Promise<SourceChange[]>;
  createSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSandboxLeaseRecord<Framework>,
  ): Promise<SandboxLeaseData<Framework>>;
  getSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<SandboxLeaseData<Framework> | null>;
  closeSandboxLease(
    scope: UserScope,
    id: string,
    status: Exclude<SandboxLeaseStatus, "active">,
  ): Promise<void>;
}
