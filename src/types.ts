import type { LanguageModel } from "ai";
import type {
  SandboxAdapter,
  SandboxCommandPolicy,
  SandboxCommandProposedAction,
} from "./sandbox.js";

export type FrameworkId =
  | "farm"
  | "tanstack-start"
  | "next"
  | (string & {});

export type BuiltInSkillCategory =
  | "core"
  | "product"
  | "design"
  | "frontend"
  | "backend"
  | "data"
  | "ai"
  | "testing"
  | "security"
  | "accessibility"
  | "performance"
  | "delivery";

export type SkillCategory = BuiltInSkillCategory | (string & {});

export type SkillsShSkillId = `${string}/${string}/${string}`;

export interface LocalSkillReference {
  readonly source: "file";
  readonly path: string;
}

export type SkillReference = SkillsShSkillId | LocalSkillReference;

export type SkillGroups = {
  readonly [category: string]: readonly SkillReference[] | undefined;
} & {
  readonly [Category in BuiltInSkillCategory]?: readonly SkillReference[];
};

export interface VibyConfig<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  readonly model: LanguageModel;
  readonly skills?: SkillGroups;
  readonly sandbox?: SandboxAdapter;
  readonly sandboxPolicy?: SandboxCommandPolicy;
  readonly agent?: AgentRunnerConfig;
  readonly generation?: {
    readonly execution?: "embedded" | "worker";
  };
}

export interface AgentRunnerConfig {
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
  readonly maxTokens?: number;
  readonly maxCommands?: number;
  readonly commandTimeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
  readonly sandboxPorts?: readonly number[];
}

export interface UserScope {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CreateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | {
  readonly [key: string]: JsonValue;
};

export type ChatMetadata = Readonly<Record<string, JsonValue>>;

export interface UpdateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
}

export interface PageOptions {
  readonly limit?: number;
  readonly after?: string;
}

export interface ChatListOptions extends PageOptions {
  readonly metadata?: ChatMetadata;
}

export interface CursorPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface SourceFileInput {
  readonly path: string;
  readonly content: string;
  readonly mediaType?: string;
}

export type ImportProjectSource =
  | {
      readonly type: "files";
      readonly files: readonly SourceFileInput[];
    }
  | {
      readonly type: "zip";
      readonly bytes: Uint8Array;
    };

export interface ImportProjectInput {
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: ChatMetadata;
  readonly source: ImportProjectSource;
}

export interface GenerateInput {
  readonly prompt: string;
}

export type IterateInput = GenerateInput;

export type SourceChange =
  | {
      readonly type: "write";
      readonly path: string;
      readonly content: string;
      readonly mediaType?: string;
    }
  | {
      readonly type: "delete";
      readonly path: string;
    }
  | {
      readonly type: "move";
      readonly from: string;
      readonly to: string;
    };

export interface ApplySourceChangesInput {
  readonly changes: readonly SourceChange[];
  readonly title?: string;
  readonly summary?: string;
}

export interface ForkVersionInput {
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: ChatMetadata;
}

export interface RestoreVersionInput {
  readonly title?: string;
  readonly summary?: string;
}

export type GenerationStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled";

export type GenerationAttemptStatus =
  | "queued"
  | "running"
  | "waiting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "interrupted";

export type GenerationAttemptReason =
  | "initial"
  | "retry"
  | "resume"
  | "task_resolution";

export interface ChatData<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly tenantId: string;
  readonly userId: string;
  readonly title: string;
  readonly metadata: ChatMetadata;
  readonly framework: Framework;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface MessageData {
  readonly id: string;
  readonly chatId: string;
  readonly generationId: string | null;
  readonly role: "user" | "assistant";
  readonly content: string;
  readonly parts: readonly MessagePart[];
  readonly createdAt: Date;
}

export type ToolCallEffect = "read" | "write" | "external";
export type ToolCallStatus = "pending" | "succeeded" | "failed";

export interface ToolCallData<
  Arguments extends JsonValue = JsonValue,
  Result extends JsonValue = JsonValue,
> {
  readonly id: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly messageId: string | null;
  readonly providerCallId: string;
  readonly name: string;
  readonly effect: ToolCallEffect;
  readonly arguments: Arguments;
  readonly result: Result | null;
  readonly status: ToolCallStatus;
  readonly error: string | null;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly completedAt: Date | null;
}

export const MESSAGE_PART_TYPES = [
  "text",
  "status",
  "reasoning-summary",
  "file-read",
  "file-edit",
  "search",
  "command",
  "tool-call",
  "error",
  "usage",
] as const;

export type MessagePartType = (typeof MESSAGE_PART_TYPES)[number];

export type FileEditMessagePartData =
  | {
      readonly operation: "write" | "delete";
      readonly path: string;
    }
  | {
      readonly operation: "move";
      readonly from: string;
      readonly to: string;
    };

export interface MessagePartDataMap {
  readonly text: { readonly text: string };
  readonly status: {
    readonly message: string;
    readonly state: "pending" | "running" | "waiting" | "completed";
  };
  readonly "reasoning-summary": { readonly text: string };
  readonly "file-read": { readonly path: string };
  readonly "file-edit": FileEditMessagePartData;
  readonly search: {
    readonly query: string;
    readonly path: string | null;
    readonly matches: number | null;
  };
  readonly command: {
    readonly command: string;
    readonly args: readonly string[];
    readonly exitCode: number | null;
  };
  readonly "tool-call": {
    readonly toolCallId: string;
    readonly name: string;
    readonly state: "pending" | "completed" | "failed";
  };
  readonly error: {
    readonly message: string;
    readonly code: string | null;
    readonly retryable: boolean;
  };
  readonly usage: {
    readonly inputTokens: number | null;
    readonly outputTokens: number | null;
    readonly totalTokens: number | null;
  };
}

export type MessagePart<Type extends MessagePartType = MessagePartType> =
  Type extends MessagePartType
    ? {
        readonly id: string;
        readonly messageId: string;
        readonly generationId: string | null;
        readonly attemptId: string | null;
        readonly position: number;
        readonly type: Type;
        readonly data: MessagePartDataMap[Type];
        readonly createdAt: Date;
      }
    : never;

export type MessagePartInput<Type extends MessagePartType = MessagePartType> =
  Type extends MessagePartType
    ? {
        readonly id?: string;
        readonly type: Type;
        readonly data: MessagePartDataMap[Type];
      }
    : never;

export type DurableMessagePartInput<Type extends MessagePartType = MessagePartType> =
  Type extends MessagePartType
    ? {
        readonly id: string;
        readonly type: Type;
        readonly data: MessagePartDataMap[Type];
      }
    : never;

export interface GenerationData {
  readonly id: string;
  readonly chatId: string;
  readonly baseVersionId: string | null;
  readonly activeAttemptId: string;
  readonly attemptCount: number;
  readonly prompt: string;
  readonly status: GenerationStatus;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

export interface GenerationAttemptData {
  readonly id: string;
  readonly generationId: string;
  readonly number: number;
  readonly reason: GenerationAttemptReason;
  readonly status: GenerationAttemptStatus;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly finishReason: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
  readonly workerId: string | null;
  readonly heartbeatAt: Date | null;
  readonly leaseExpiresAt: Date | null;
}

export interface PlanTaskRequest {
  readonly kind: "plan";
  readonly title: string;
  readonly message: string;
  readonly steps: readonly string[];
}

export interface QuestionTaskRequest {
  readonly kind: "question";
  readonly title: string;
  readonly message: string;
  readonly question: string;
  readonly choices: readonly string[];
  readonly allowFreeform: boolean;
}

export interface PermissionTaskRequest {
  readonly kind: "permission";
  readonly title: string;
  readonly message: string;
  readonly action: string;
  readonly permissions: readonly string[];
  readonly proposedAction?: SandboxCommandProposedAction;
}

export type GenerationTaskRequest =
  | PlanTaskRequest
  | QuestionTaskRequest
  | PermissionTaskRequest;

export interface PlanTaskResolution {
  readonly kind: "plan";
  readonly decision: "approve" | "revise";
  readonly feedback?: string;
}

export interface QuestionTaskResolution {
  readonly kind: "question";
  readonly answer: string;
}

export interface PermissionTaskResolution {
  readonly kind: "permission";
  readonly decision: "allow" | "deny";
  readonly note?: string;
}

export type GenerationTaskResolution =
  | PlanTaskResolution
  | QuestionTaskResolution
  | PermissionTaskResolution;

export type GenerationTaskData = {
  readonly id: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly status: "pending" | "resolved";
  readonly resolution: GenerationTaskResolution | null;
  readonly createdAt: Date;
  readonly resolvedAt: Date | null;
} & GenerationTaskRequest;

export type GenerationEventType =
  | "generation.created"
  | "attempt.queued"
  | "attempt.started"
  | "output.delta"
  | "part.started"
  | "part.delta"
  | "part.completed"
  | "part.failed"
  | "attempt.waiting"
  | "task.created"
  | "task.resolved"
  | "attempt.interrupted"
  | "attempt.succeeded"
  | "attempt.failed"
  | "attempt.cancelled"
  | "generation.succeeded"
  | "generation.failed"
  | "generation.cancelled";

export interface GenerationEventDataMap {
  readonly "generation.created": { readonly prompt: string };
  readonly "attempt.queued": {
    readonly number: number;
    readonly reason: GenerationAttemptReason;
  };
  readonly "attempt.started": {
    readonly number: number;
    readonly reason: GenerationAttemptReason;
  };
  readonly "output.delta": { readonly delta: string };
  readonly "part.started": {
    readonly partId: string;
    readonly position: number;
    readonly type: MessagePartType;
  };
  readonly "part.delta": { readonly partId: string; readonly delta: string };
  readonly "part.completed": { readonly part: DurableMessagePartInput };
  readonly "part.failed": {
    readonly partId: string;
    readonly error: {
      readonly message: string;
      readonly code: string | null;
      readonly retryable: boolean;
    };
  };
  readonly "attempt.waiting": { readonly taskId: string };
  readonly "task.created": { readonly task: GenerationTaskRequest & { readonly id: string } };
  readonly "task.resolved": {
    readonly taskId: string;
    readonly resolution: GenerationTaskResolution;
  };
  readonly "attempt.interrupted": { readonly number: number };
  readonly "attempt.succeeded": { readonly number: number; readonly versionId: string };
  readonly "attempt.failed": { readonly number: number; readonly error: string };
  readonly "attempt.cancelled": { readonly number: number; readonly reason: string };
  readonly "generation.succeeded": { readonly versionId: string };
  readonly "generation.failed": { readonly error: string };
  readonly "generation.cancelled": { readonly reason: string };
}

export type GenerationEvent<
  Type extends GenerationEventType = GenerationEventType,
> = Type extends GenerationEventType
  ? {
      readonly cursor: string;
      readonly generationId: string;
      readonly attemptId: string | null;
      readonly type: Type;
      readonly data: GenerationEventDataMap[Type];
      readonly createdAt: Date;
    }
  : never;

export interface GenerationEventPage {
  readonly events: readonly GenerationEvent[];
  readonly nextCursor: string | null;
}

export interface ResolveGenerationTaskInput {
  readonly taskId: string;
  readonly resolution: GenerationTaskResolution;
}

export interface GenerationWaitOptions {
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface GenerationEventOptions {
  readonly after?: string;
  readonly limit?: number;
}

export interface GenerationStreamOptions {
  readonly after?: string;
  readonly pollIntervalMs?: number;
  readonly signal?: AbortSignal;
}

export interface VersionData<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly chatId: string;
  readonly generationId: string | null;
  readonly parentVersionId: string | null;
  readonly number: number;
  readonly origin: VersionOrigin;
  readonly framework: Framework;
  readonly title: string;
  readonly summary: string;
  readonly createdAt: Date;
}

export type VersionOrigin = "generated" | "imported" | "edited" | "forked" | "restored";

export interface VersionFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
}

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

export interface ResolvedSkill {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source: "skills.sh" | "file";
  readonly locator: string;
  readonly contentHash: string;
  readonly files: readonly SkillFile[];
}
