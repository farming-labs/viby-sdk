import type {
  ChatData,
  ChatMetadata,
  FrameworkId,
  GenerationAttemptData,
  GenerationAttemptReason,
  GenerationData,
  GenerationEvent,
  GenerationEventDataMap,
  GenerationEventType,
  GenerationTaskData,
  GenerationTaskRequest,
  GenerationTaskResolution,
  MessageData,
  ResolvedSkill,
  UserScope,
  VersionData,
  VersionFile,
  VersionOrigin,
  SourceChange,
} from "./types.js";
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
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string;
}

export interface PauseGenerationRecord {
  readonly generationId: string;
  readonly attemptId: string;
  readonly leaseToken: string;
  readonly taskId: string;
  readonly task: GenerationTaskRequest;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string;
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

export interface ClaimGenerationAttemptRecord<Framework extends FrameworkId = FrameworkId> {
  readonly workerId: string;
  readonly leaseToken: string;
  readonly leaseMs: number;
  readonly framework: Framework;
  readonly modelProvider: string;
  readonly modelId: string;
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
  listGenerationTasks(scope: UserScope, generationId: string): Promise<GenerationTaskData[]>;
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
