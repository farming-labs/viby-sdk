import type {
  AttachmentContent,
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  DesignEvaluationData,
  DesignEvaluationEvidence,
  DesignEvaluationCriterionInput,
  DesignEvaluationStatus,
  GeneratedArtifactContent,
  GeneratedArtifactData,
  GeneratedArtifactKind,
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
  ProjectArtifactContent,
  VersionArtifact,
  VersionEntry,
  VisualArtifactContent,
  VisualArtifactData,
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
import type {
  BeginRepositoryPushRecord,
  CompleteRepositoryPushRecord,
  FailRepositoryPushRecord,
  RepositoryLinkData,
  RepositoryPushData,
} from "./repository-history.js";
import type { DeploymentHistoryStore } from "./deployment-history.js";
import type { PreviewSessionStore } from "./preview.js";
import type { ToolSourceRegistryStore } from "./tool-source-registry.js";

export interface ImportChatRecord<Framework extends FrameworkId = FrameworkId> {
  readonly chatId: string;
  readonly versionId: string;
  readonly title: string;
  readonly metadata: ChatMetadata;
  readonly summary: string;
  readonly framework: Framework;
  readonly files: readonly VersionFile[];
  readonly artifacts?: readonly CreateProjectArtifactRecord[];
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
  readonly artifacts?: readonly VersionArtifact[];
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

export interface DesignEvaluationPageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export interface CreateDesignEvaluationRecord {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly generationId: string | null;
  readonly evaluator: string;
  readonly status: DesignEvaluationStatus;
  readonly score: number;
  readonly summary: string;
  readonly criteria: readonly DesignEvaluationCriterionInput[];
  readonly evidence: readonly DesignEvaluationEvidence[];
  readonly metadata: ChatMetadata;
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
  readonly attachments?: readonly CreateAttachmentRecord[];
}

export interface CreateAttachmentRecord {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly checksum: string;
}

export interface CreateGeneratedArtifactRecord {
  readonly id: string;
  readonly position: number;
  readonly kind: GeneratedArtifactKind;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly checksum: string;
}

export interface CreateProjectArtifactRecord extends VersionArtifact {
  readonly bytes: Uint8Array;
}

export interface CreateVisualArtifactRecord {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly pageId: string;
  readonly path: string;
  readonly url: string;
  readonly filename: string;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly checksum: string;
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
  readonly projectArtifacts?: readonly VersionArtifact[];
  readonly changes: readonly SourceChange[] | null;
  readonly assistantMessage: string;
  readonly assistantParts: readonly MessagePartInput[];
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string;
  readonly cost: GenerationCostData | null;
  readonly artifacts?: readonly CreateGeneratedArtifactRecord[];
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
  readonly artifacts?: readonly CreateGeneratedArtifactRecord[];
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

export interface Repository
extends DeploymentHistoryStore, PreviewSessionStore, ToolSourceRegistryStore {
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
  createDesignEvaluation(
    scope: UserScope,
    input: CreateDesignEvaluationRecord,
  ): Promise<DesignEvaluationData>;
  getDesignEvaluation(
    scope: UserScope,
    versionId: string,
    id: string,
  ): Promise<DesignEvaluationData | null>;
  listDesignEvaluationPage(
    scope: UserScope,
    versionId: string,
    limit: number,
    after: DesignEvaluationPageCursor | null,
  ): Promise<RepositoryPage<DesignEvaluationData>>;
  listMessages(scope: UserScope, chatId: string): Promise<MessageData[]>;
  getMessage(scope: UserScope, chatId: string, id: string): Promise<MessageData | null>;
  getAttachment(scope: UserScope, chatId: string, id: string): Promise<AttachmentContent | null>;
  listGenerationAttachments(
    scope: UserScope,
    generationId: string,
  ): Promise<AttachmentContent[]>;
  listGeneratedArtifacts(
    scope: UserScope,
    generationId: string,
  ): Promise<GeneratedArtifactData[]>;
  getGeneratedArtifact(
    scope: UserScope,
    generationId: string,
    id: string,
  ): Promise<GeneratedArtifactContent | null>;
  createVisualArtifact(
    scope: UserScope,
    input: CreateVisualArtifactRecord,
  ): Promise<VisualArtifactData>;
  listVisualArtifacts(scope: UserScope, versionId: string): Promise<VisualArtifactData[]>;
  getVisualArtifact(
    scope: UserScope,
    versionId: string,
    id: string,
  ): Promise<VisualArtifactContent | null>;
  listMessagePage(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: MessagePageCursor | null,
  ): Promise<RepositoryPage<MessageData>>;
  getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]>;
  getVersionEntries(scope: UserScope, versionId: string): Promise<VersionEntry[]>;
  getProjectArtifact(
    scope: UserScope,
    versionId: string,
    artifactId: string,
  ): Promise<ProjectArtifactContent | null>;
  getVersionChanges(scope: UserScope, versionId: string): Promise<SourceChange[]>;
  beginRepositoryPush(
    scope: UserScope,
    input: BeginRepositoryPushRecord,
  ): Promise<RepositoryPushData>;
  completeRepositoryPush(
    scope: UserScope,
    input: CompleteRepositoryPushRecord,
  ): Promise<RepositoryPushData>;
  failRepositoryPush(
    scope: UserScope,
    input: FailRepositoryPushRecord,
  ): Promise<RepositoryPushData>;
  listRepositoryLinks(scope: UserScope, chatId: string): Promise<RepositoryLinkData[]>;
  listRepositoryPushes(
    scope: UserScope,
    input: { readonly chatId: string; readonly versionId?: string },
  ): Promise<RepositoryPushData[]>;
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
