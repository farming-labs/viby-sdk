import type {
  ChatData,
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
} from "./types.js";

export interface ImportChatRecord<Framework extends FrameworkId = FrameworkId> {
  readonly chatId: string;
  readonly versionId: string;
  readonly title: string;
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
}

export interface ForkVersionRecord<Framework extends FrameworkId = FrameworkId> {
  readonly chatId: string;
  readonly versionId: string;
  readonly sourceVersionId: string;
  readonly title: string;
  readonly summary: string;
  readonly framework: Framework;
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
  readonly parentVersionId: string | null;
  readonly framework: Framework;
  readonly title: string;
  readonly summary: string;
  readonly files: readonly VersionFile[];
  readonly assistantMessage: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string;
}

export interface PauseGenerationRecord {
  readonly generationId: string;
  readonly attemptId: string;
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
  readonly type: Type;
  readonly data: GenerationEventDataMap[Type];
}

export interface Repository {
  assertReady(): Promise<void>;
  close(): Promise<void>;
  createChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: { id: string; title: string; framework: Framework },
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
  getChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<ChatData<Framework> | null>;
  listChats<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
  ): Promise<Array<ChatData<Framework>>>;
  createGeneration(scope: UserScope, input: CreateGenerationRecord): Promise<CreatedGeneration>;
  startGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
  ): Promise<GenerationAttemptData>;
  createGenerationAttempt(
    scope: UserScope,
    input: CreateAttemptRecord,
  ): Promise<GenerationAttemptData>;
  attachGenerationSkills(
    scope: UserScope,
    generationId: string,
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
  listMessages(scope: UserScope, chatId: string): Promise<MessageData[]>;
  getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]>;
}
