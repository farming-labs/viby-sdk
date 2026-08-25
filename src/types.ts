import type { LanguageModel } from "ai";
import type { CodingAgent, GenerationEngine } from "./generation-engine.js";
import type { ArtifactReference, ArtifactStore } from "./artifact-store.js";
import type { BrowserAdapter } from "./browser.js";
import type { PersistenceAdapter } from "./persistence.js";
import type { OutboundEventSink } from "./outbound-events.js";
import type { VibyIntegrations } from "./integrations.js";
import type { IntegrationConnectionStore, SecretStore } from "./integration-store.js";
import type {
  SandboxAdapter,
  SandboxCommandPolicy,
  SandboxCommandProposedAction,
} from "./sandbox.js";
import type { GenerationCostConfig, GenerationCostData, VibyTelemetry } from "./telemetry.js";
import type { DeploymentPreparationConfig } from "./deployment-preparation.js";
import type { VibyStorage } from "./storage.js";
import type { EnvironmentConfig } from "./environment.js";
import type { ToolSourcesConfig, ToolSourceProposedAction } from "./tool-source.js";
import type { ToolSourceRegistrationSnapshot } from "./tool-source-registry.js";
import type { PreviewConfig } from "./preview.js";
import type { FrameworkId } from "./frameworks.js";

export type { BuiltInFrameworkId, FrameworkId } from "./frameworks.js";

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

/** An immutable skill supplied directly by the host without filesystem or network access. */
export interface InlineSkillReference {
  readonly source: "inline";
  readonly name: string;
  readonly description?: string;
  readonly files: readonly SkillFile[];
}

/** An opaque, serializable locator owned by a configured skill resolver. */
export interface ResolverSkillReference {
  readonly source: "resolver";
  readonly resolver: string;
  readonly locator: string;
  readonly metadata?: ChatMetadata;
}

export type SkillReference =
  | SkillsShSkillId
  | LocalSkillReference
  | InlineSkillReference
  | ResolverSkillReference;

export interface SkillResolutionInput {
  readonly reference: SkillReference;
  readonly category: string;
  readonly prompt: string;
}

export interface SkillResolutionOutput {
  readonly name: string;
  readonly description?: string;
  readonly source?: string;
  readonly locator?: string;
  readonly contentHash?: string;
  readonly files: readonly SkillFile[];
}

/** Resolves one host-owned reference. Return null to defer to another resolver or a built-in adapter. */
export interface SkillResolverAdapter {
  readonly id: string;
  resolve(input: SkillResolutionInput): Promise<SkillResolutionOutput | null>;
}

export type SkillGroups = {
  readonly [category: string]: readonly SkillReference[] | undefined;
} & {
  readonly [Category in BuiltInSkillCategory]?: readonly SkillReference[];
};

interface VibyBaseConfig<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  /** Structured database, binary artifacts, connection metadata, and secret storage. */
  readonly storage?: VibyStorage;
  /** Optional external capabilities grouped by their provider-neutral product category. */
  readonly integrations?: VibyIntegrations;
  /** Optional sandbox build contract used when a deployment adapter requires prebuilt files. */
  readonly deployment?: {
    readonly preparation?: DeploymentPreparationConfig<Framework>;
  };
  /** @deprecated Use storage.connections. */
  readonly connectionStore?: IntegrationConnectionStore;
  /** @deprecated Use storage.secrets. */
  readonly secretStore?: SecretStore;
  /** @deprecated Use storage.database. */
  readonly persistence?: PersistenceAdapter;
  /** @deprecated Use storage.artifacts. */
  readonly artifactStore?: ArtifactStore;
  /** Provider-neutral browser used by preview inspection and visual evaluation workflows. */
  readonly browser?: BrowserAdapter;
  /** Durable project environment variables. Omit to disable automatic injection. */
  readonly environment?: EnvironmentConfig;
  readonly skills?: SkillGroups;
  /** Optional resolver for custom catalogs, databases, object stores, or Git-backed skill sources. */
  readonly skillResolver?: SkillResolverAdapter;
  readonly sandbox?: SandboxAdapter;
  readonly sandboxPolicy?: SandboxCommandPolicy;
  /** Optional durable sandbox-backed preview lifecycle. */
  readonly preview?: PreviewConfig;
  /** Host-configured tools selected and authorized independently for every chat. */
  readonly tools?: ToolSourcesConfig<Framework>;
  readonly generation?: {
    readonly execution?: "embedded" | "worker";
    /** Execution limits used by the built-in AI SDK agent runner. */
    readonly limits?: AgentRunnerConfig;
    /** Optional sandbox checks that must pass before an immutable version is committed. */
    readonly quality?: GenerationQualityConfig;
    /** Optional eager, reusable workspace lifecycle for generated projects. */
    readonly workspace?: GenerationWorkspaceConfig;
  };
  readonly retention?: {
    readonly deletedChatsMs?: number | null;
  };
  readonly events?: {
    readonly sinks?: readonly OutboundEventSink[];
  };
  readonly telemetry?: VibyTelemetry;
  readonly cost?: GenerationCostConfig;
}

export type VibyConfig<Framework extends FrameworkId = FrameworkId> = VibyBaseConfig<Framework> &
  (
    | {
        /** Convenient AI SDK shortcut. */
        readonly model: LanguageModel;
        readonly models?: Readonly<Record<string, LanguageModel>>;
        /** @deprecated Use generation.limits. */
        readonly agent?: AgentRunnerConfig;
        readonly agents?: never;
        readonly engine?: never;
        readonly engines?: never;
      }
    | {
        /** Packaged coding-agent shortcut, such as codex({ model }). */
        readonly agent: CodingAgent<Framework>;
        readonly agents?: Readonly<Record<string, CodingAgent<Framework>>>;
        readonly model?: never;
        readonly models?: never;
        readonly engine?: never;
        readonly engines?: never;
      }
    | {
        /** Advanced provider-neutral agent, model-runtime, or orchestration boundary. */
        readonly engine: GenerationEngine<Framework>;
        readonly engines?: Readonly<Record<string, GenerationEngine<Framework>>>;
        readonly agent?: never;
        readonly agents?: never;
        readonly model?: never;
        readonly models?: never;
      }
  );

export interface AgentRunnerConfig {
  readonly maxSteps?: number;
  readonly maxDurationMs?: number;
  readonly maxTokens?: number;
  /** Maximum tokens emitted by one model step. Defaults to 16,384 or maxTokens when lower. */
  readonly maxOutputTokens?: number;
  readonly maxCommands?: number;
  readonly commandTimeoutMs?: number;
  readonly maxCommandOutputBytes?: number;
  readonly sandboxPorts?: readonly number[];
}

export interface GenerationQualityCommand {
  /** Stable identifier surfaced in durable generation events. */
  readonly id: string;
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
}

export interface GenerationQualityFailure {
  readonly checkId: string;
  readonly phase: "prepare" | "check";
  readonly exitCode: number;
  readonly durationMs: number;
  /** Raw command output. Return only explicitly sanitized text from `formatFailure`. */
  readonly stdout: string;
  /** Raw command output. Return only explicitly sanitized text from `formatFailure`. */
  readonly stderr: string;
}

export interface GenerationQualityConfig {
  /** Preparation commands such as dependency installation. */
  readonly prepare?: readonly GenerationQualityCommand[];
  /** Required checks such as typecheck, test, and build. */
  readonly checks: readonly GenerationQualityCommand[];
  /** Maximum final checks to run concurrently. Defaults to 1. */
  readonly checkConcurrency?: number;
  /**
   * Read candidate text files back from the sandbox after successful commands
   * and commit those exact contents. This supports provider-neutral formatters
   * and codemods without discovering command-created files implicitly.
   */
  readonly captureSourceChanges?: boolean;
  /**
   * Automatically create a diagnostic-aware retry after a quality command
   * fails. Defaults to 0; keep this small because every repair calls the
   * configured generation engine again.
   */
  readonly repairAttempts?: number;
  /**
   * Converts a failed command result into safe, user-facing diagnostics.
   * Raw output is never persisted unless the host explicitly returns it here.
   */
  readonly formatFailure?: (failure: GenerationQualityFailure) => string | null | undefined;
}

export interface GenerationWorkspaceConfig {
  /**
   * Start the configured preview from the base version while generation runs,
   * then keep the same sandbox and preview alive for the generated version.
   */
  readonly preview: "eager";
}

export interface UserScope {
  readonly tenantId: string;
  readonly userId: string;
}

export interface CreateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
}

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | {
      readonly [key: string]: JsonValue;
    };

export type ChatMetadata = Readonly<Record<string, JsonValue>>;

export interface UpdateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
}

export interface DeleteChatInput {
  readonly retentionMs?: number | null;
}

export interface ChatDeletionData {
  readonly chatId: string;
  readonly deletedAt: Date;
  readonly purgeAfter: Date | null;
}

export interface PurgeDeletedChatsInput {
  readonly limit?: number;
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
  readonly type?: "text";
  readonly path: string;
  readonly content: string;
  readonly mediaType?: string;
  readonly locked?: boolean;
}

export interface SourceArtifactInput {
  readonly type: "artifact";
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly mediaType?: string;
  readonly locked?: boolean;
}

export type SourceEntryInput = SourceFileInput | SourceArtifactInput;

export interface ImportFilePolicy {
  readonly locked?: "all" | readonly string[];
}

export type ImportProjectSource =
  | {
      readonly type: "files";
      readonly files: readonly SourceEntryInput[];
    }
  | {
      readonly type: "zip";
      readonly bytes: Uint8Array;
    };

export interface ImportProjectInput {
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: ChatMetadata;
  readonly filePolicy?: ImportFilePolicy;
  readonly source: ImportProjectSource;
}

export interface GenerateInput {
  readonly prompt: string;
  /** Stable alias from `VibyConfig.models`. Omit to use the default `model`. */
  readonly model?: string;
  /** Stable alias from `VibyConfig.agents`. Omit to use the default `agent`. */
  readonly agent?: string;
  /** Stable alias from `VibyConfig.engines`. Omit to use the default `engine`. */
  readonly engine?: string;
  readonly instructions?: string;
  readonly skills?: SkillGroups;
  readonly metadata?: ChatMetadata;
  readonly attachments?: readonly AttachmentInput[];
}

export type InspectInput = GenerateInput;
export type GenerationOperation = "change" | "inspect";

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

export type GenerationAttemptReason = "initial" | "retry" | "resume" | "task_resolution";

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
  /** The model completion reason for assistant messages. User and historical messages are null. */
  readonly finishReason: string | null;
  readonly parts: readonly MessagePart[];
  readonly attachments: readonly AttachmentData[];
  readonly createdAt: Date;
}

export interface AttachmentInput {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface GenerationSteeringInput {
  readonly prompt: string;
  /** Optional key that makes repeated host requests return the original steering record. */
  readonly idempotencyKey?: string;
  readonly attachments?: readonly AttachmentInput[];
}

export type GenerationSteeringStatus = "queued" | "applied";

/** A durable instruction submitted while a generation is still active. */
export interface GenerationSteeringData {
  readonly id: string;
  readonly generationId: string;
  readonly messageId: string;
  readonly submittedAttemptId: string;
  readonly appliedAttemptId: string | null;
  readonly prompt: string;
  readonly status: GenerationSteeringStatus;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
  readonly appliedAt: Date | null;
}

export interface AttachmentData {
  readonly id: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly generationId: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly artifact: ArtifactReference;
  readonly createdAt: Date;
}

export interface AttachmentContent extends AttachmentData {
  readonly bytes: Uint8Array;
}

export type GeneratedArtifactKind = "image" | "audio" | "video" | "document" | "binary";

export interface GeneratedArtifactData {
  readonly id: string;
  readonly chatId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly versionId: string | null;
  readonly position: number;
  readonly kind: GeneratedArtifactKind;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly artifact: ArtifactReference;
  readonly createdAt: Date;
}

export interface GeneratedArtifactContent extends GeneratedArtifactData {
  readonly bytes: Uint8Array;
}

export interface VisualArtifactData {
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
  readonly size: number;
  readonly checksum: string;
  readonly artifact: ArtifactReference;
  readonly createdAt: Date;
}

export interface VisualArtifactContent extends VisualArtifactData {
  readonly bytes: Uint8Array;
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
      /** `write` is retained for records created before create/update classification was added. */
      readonly operation: "create" | "update" | "write" | "delete";
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
    /** Wall-clock duration of the exact generation attempt that produced this usage. */
    readonly durationMs?: number;
    readonly cost?: GenerationCostData;
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
  readonly configuration: GenerationConfigurationData;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cost: GenerationCostData | null;
  readonly error: string | null;
  readonly createdAt: Date;
  readonly startedAt: Date | null;
  readonly completedAt: Date | null;
}

/** The exact, serializable request configuration stored with a durable generation. */
export interface GenerationConfigurationData {
  readonly model: string;
  /** Durable operation kind. Missing on records created before read-only inspection shipped. */
  readonly operation?: GenerationOperation;
  /** The configured execution surface used to resolve the durable alias. */
  readonly executor?: "model" | "agent" | "engine";
  readonly instructions: string | null;
  readonly skills: SkillGroups;
  readonly metadata: ChatMetadata;
  /** Exact public durable tool-source revisions selected when this generation was queued. */
  readonly toolSources?: readonly ToolSourceRegistrationSnapshot[];
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
  readonly cost: GenerationCostData | null;
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
  readonly proposedToolAction?: ToolSourceProposedAction;
}

export type GenerationTaskRequest = PlanTaskRequest | QuestionTaskRequest | PermissionTaskRequest;

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
  | "steering.queued"
  | "steering.applied"
  | "output.delta"
  | "part.started"
  | "part.delta"
  | "part.completed"
  | "part.failed"
  | "artifact.created"
  | "workspace.started"
  | "workspace.prepared"
  | "preview.ready"
  | "preview.failed"
  | "quality.started"
  | "quality.completed"
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
  readonly "steering.queued": {
    readonly steeringId: string;
    readonly messageId: string;
    readonly prompt: string;
  };
  readonly "steering.applied": {
    readonly steeringId: string;
    readonly messageId: string;
    readonly prompt: string;
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
  readonly "artifact.created": {
    readonly artifactId: string;
    readonly position: number;
    readonly kind: GeneratedArtifactKind;
    readonly filename: string;
    readonly mediaType: string;
    readonly size: number;
    readonly checksum: string;
  };
  readonly "workspace.started": {
    readonly previewId: string;
    readonly sandboxProvider: string;
  };
  readonly "workspace.prepared": {
    readonly previewId: string;
    readonly filesWritten: number;
  };
  readonly "preview.ready": {
    readonly previewId: string;
    readonly url: string;
  };
  readonly "preview.failed": {
    readonly previewId: string;
    readonly error: string;
  };
  readonly "quality.started": {
    readonly checkId: string;
    readonly phase: "prepare" | "check";
  };
  readonly "quality.completed": {
    readonly checkId: string;
    readonly phase: "prepare" | "check";
    readonly status: "passed" | "failed";
    readonly exitCode: number | null;
    readonly durationMs: number | null;
    /** Sanitized host-provided diagnostics. Older durable events may omit this field. */
    readonly detail?: string | null;
  };
  readonly "attempt.waiting": { readonly taskId: string };
  readonly "task.created": { readonly task: GenerationTaskRequest & { readonly id: string } };
  readonly "task.resolved": {
    readonly taskId: string;
    readonly resolution: GenerationTaskResolution;
  };
  readonly "attempt.interrupted": { readonly number: number };
  readonly "attempt.succeeded": {
    readonly number: number;
    readonly versionId: string | null;
    readonly responseMessageId?: string;
  };
  readonly "attempt.failed": { readonly number: number; readonly error: string };
  readonly "attempt.cancelled": { readonly number: number; readonly reason: string };
  readonly "generation.succeeded": {
    readonly versionId: string | null;
    readonly responseMessageId?: string;
  };
  readonly "generation.failed": { readonly error: string };
  readonly "generation.cancelled": { readonly reason: string };
}

export type GenerationEvent<Type extends GenerationEventType = GenerationEventType> =
  Type extends GenerationEventType
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

export type DesignEvaluationStatus = "passed" | "warning" | "failed";

export type DesignEvaluationEvidence =
  | {
      readonly type: "version-file";
      readonly path: string;
      readonly description?: string;
    }
  | {
      readonly type: "attachment";
      readonly attachmentId: string;
      readonly description?: string;
    }
  | {
      readonly type: "artifact";
      readonly artifactId: string;
      readonly description?: string;
    }
  | {
      readonly type: "url";
      readonly url: string;
      readonly description?: string;
    }
  | {
      readonly type: "note";
      readonly text: string;
    };

export interface DesignEvaluationCriterionInput {
  readonly id: string;
  readonly label: string;
  readonly status: DesignEvaluationStatus;
  readonly score: number;
  readonly summary: string;
  readonly evidence?: readonly DesignEvaluationEvidence[];
}

export interface RecordDesignEvaluationInput {
  readonly evaluator: string;
  readonly status: DesignEvaluationStatus;
  readonly score: number;
  readonly summary: string;
  readonly criteria: readonly DesignEvaluationCriterionInput[];
  readonly evidence?: readonly DesignEvaluationEvidence[];
  readonly metadata?: ChatMetadata;
}

export interface DesignEvaluationData {
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
  readonly createdAt: Date;
}

export type VersionOrigin = "generated" | "imported" | "edited" | "forked" | "restored";

export interface VersionFile {
  readonly path: string;
  readonly content: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly locked: boolean;
}

export interface VersionTextEntry extends VersionFile {
  readonly type: "text";
}

export interface VersionArtifact {
  readonly type: "artifact";
  readonly path: string;
  readonly artifactId: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly locked: boolean;
}

export type VersionEntry = VersionTextEntry | VersionArtifact;

export interface ProjectArtifactData {
  readonly id: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly artifact: ArtifactReference;
  readonly createdAt: Date;
}

export interface ProjectArtifactContent extends ProjectArtifactData {
  readonly bytes: Uint8Array;
}

export interface SkillFile {
  readonly path: string;
  readonly content: string;
}

export interface ResolvedSkill {
  readonly name: string;
  readonly description: string;
  readonly category: string;
  readonly source: string;
  readonly locator: string;
  readonly contentHash: string;
  readonly files: readonly SkillFile[];
}
