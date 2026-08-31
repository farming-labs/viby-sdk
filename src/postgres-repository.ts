import postgres from "postgres";
import {
  normalizeArtifactStoreId,
  type ArtifactStore,
  type ArtifactStoreContext,
} from "./artifact-store.js";
import type { OutboundEventDeliveryData, OutboundEventDeliveryStatus } from "./outbound-events.js";
import type {
  AttachmentContent,
  AttachmentData,
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  DesignEvaluationData,
  DesignEvaluationCriterionInput,
  DesignEvaluationEvidence,
  DesignEvaluationStatus,
  FrameworkId,
  GenerationAttemptData,
  GenerationConfigurationData,
  GenerationAttemptReason,
  GenerationAttemptStatus,
  GenerationData,
  GenerationEvent,
  GenerationEventType,
  GenerationStatus,
  GenerationSteeringData,
  GenerationSteeringStatus,
  GenerationTaskData,
  GenerationTaskRequest,
  GenerationTaskResolution,
  GeneratedArtifactContent,
  GeneratedArtifactData,
  GeneratedArtifactKind,
  JsonValue,
  MessageData,
  MessagePart,
  MessagePartInput,
  MessagePartType,
  ProjectArtifactContent,
  ResolvedSkill,
  SourceChange,
  ToolCallData,
  ToolCallEffect,
  ToolCallStatus,
  UserScope,
  VersionData,
  VersionArtifact,
  VersionEntry,
  VersionFile,
  VisualArtifactContent,
  VisualArtifactData,
} from "./types.js";
import type {
  RepositoryCommitData,
  RepositoryPullRequestData,
  RepositoryVisibility,
} from "./integrations.js";
import type { DeploymentEnvironment, DeploymentStatus } from "./integrations.js";
import type { GenerationCostData } from "./telemetry.js";
import type { CreateSandboxLeaseRecord, SandboxLeaseData, SandboxLeaseStatus } from "./sandbox.js";
import type {
  AppendGenerationEventRecord,
  ChatReadSnapshot,
  ChatReadSnapshotOptions,
  ChatPageCursor,
  ClaimGenerationAttemptRecord,
  ClaimOutboundEventDeliveryRecord,
  ClearGenerationEngineCheckpointRecord,
  CompleteGenerationRecord,
  CompleteGenerationResponseRecord,
  CompleteToolCallRecord,
  CreateAttemptRecord,
  CreatedGeneration,
  CreateGenerationRecord,
  CreateGenerationSteeringRecord,
  ConsumeGenerationSteeringRecord,
  CreateGeneratedArtifactRecord,
  CreateProjectArtifactRecord,
  RepairGenerationAttemptRecord,
  CreateVisualArtifactRecord,
  CreateToolCallRecord,
  DeleteChatRecord,
  CreatedToolCall,
  CreateSourceVersionRecord,
  CreateDesignEvaluationRecord,
  DesignEvaluationPageCursor,
  ForkVersionRecord,
  FailToolCallRecord,
  FailOutboundEventDeliveryRecord,
  GenerationReadSnapshot,
  GenerationWorkerLease,
  OutboundEventDeliveryClaim,
  ImportedChat,
  ImportChatRecord,
  MessagePageCursor,
  PauseGenerationRecord,
  Repository,
  RepositoryPage,
  ResolveGenerationTaskRecord,
  RestoreVersionRecord,
  SaveGenerationEngineCheckpointRecord,
  UpdateChatRecord,
  VersionPageCursor,
} from "./repository.js";
import type { GenerationEngineCheckpointData } from "./generator.js";
import type {
  CreateMessageFeedbackRecord,
  MessageFeedbackData,
  MessageFeedbackRating,
  MessageFeedbackReason,
} from "./message-feedback.js";
import type {
  BeginRepositoryPushRecord,
  CompleteRepositoryPushRecord,
  FailRepositoryPushRecord,
  RepositoryLinkData,
  RepositoryPushData,
  RepositoryPushStatus,
} from "./repository-history.js";
import type {
  CreatePreviewSessionRecord,
  PreviewSessionData,
  PreviewSessionListOptions,
  PreviewStatus,
} from "./preview.js";
import type {
  CreateToolSourceRegistrationRecord,
  ToolSourceRegistrationData,
  ToolSourceRegistrationListOptions,
  ToolSourceRegistrationStatus,
  UpdateToolSourceRegistrationRecord,
} from "./tool-source-registry.js";
import type {
  CreateToolSourceAuthorizationSessionRecord,
  StoredToolSourceConnection,
  ToolSourceAuthorizationSessionData,
  UpdateToolSourceConnectionRecord,
  UpsertToolSourceConnectionRecord,
} from "./tool-source-authorization.js";
import type { IntegrationConnectionStatus } from "./integration-store.js";
import type {
  BeginDeploymentRecord,
  CompleteDeploymentRecord,
  DeploymentHistoryStatus,
  DeploymentProjectLinkData,
  DeploymentRecordData,
  DeploymentStatusTransitionData,
  FailDeploymentRecord,
  ObserveDeploymentRecord,
} from "./deployment-history.js";
import type {
  CreateDeploymentArtifactRecord,
  DeploymentArtifactCommand,
  DeploymentArtifactContent,
  DeploymentArtifactData,
} from "./deployment-preparation.js";
import { createId, sha256 } from "./utils.js";
import { normalizeAndRedactToolPayload } from "./redaction.js";
import {
  ConfigurationError,
  DatabaseNotReadyError,
  GenerationStateError,
  GenerationSteeringPendingError,
  NotFoundError,
} from "./errors.js";

interface ChatRow {
  id: string;
  tenant_id: string;
  user_id: string;
  title: string;
  metadata: ChatMetadata;
  framework: string;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
  purge_after: Date | null;
}

interface MessageFeedbackRow {
  id: string;
  chat_id: string;
  message_id: string;
  generation_id: string;
  attempt_id: string;
  version_id: string | null;
  model_provider: string;
  model_id: string;
  rating: MessageFeedbackRating;
  reasons: MessageFeedbackReason[];
  comment: string | null;
  metadata: ChatMetadata;
  idempotency_key: string | null;
  created_at: Date;
}

interface MessageFeedbackContextRow {
  generation_id: string;
  attempt_id: string;
  version_id: string | null;
  model_provider: string;
  model_id: string;
}

interface GenerationRow {
  id: string;
  chat_id: string;
  base_version_id: string | null;
  active_attempt_id: string;
  attempt_count: number;
  prompt: string;
  status: GenerationStatus;
  model_provider: string;
  model_id: string;
  configuration: GenerationConfigurationData;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_micros: string | number | null;
  cost_currency: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
}

interface GenerationAttemptRow {
  id: string;
  generation_id: string;
  number: number;
  reason: GenerationAttemptReason;
  status: GenerationAttemptStatus;
  model_provider: string;
  model_id: string;
  input_tokens: number | null;
  output_tokens: number | null;
  total_tokens: number | null;
  estimated_cost_micros: string | number | null;
  cost_currency: string | null;
  finish_reason: string | null;
  error: string | null;
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  worker_id: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  heartbeat_at: Date | null;
}

interface GenerationAttemptClaimRow extends GenerationAttemptRow {
  tenant_id: string;
  user_id: string;
}

interface GenerationEngineCheckpointRow {
  generation_id: string;
  attempt_id: string;
  revision: number;
  cursor: string | null;
  state: JsonValue;
  created_at: Date;
  updated_at: Date;
}

interface GenerationEventRow {
  cursor: string | number | bigint;
  generation_id: string;
  attempt_id: string | null;
  type: GenerationEventType;
  data: unknown;
  created_at: Date;
}

interface OutboundEventDeliveryRow {
  generation_id: string;
  event_cursor: string | number | bigint;
  sink_id: string;
  status: OutboundEventDeliveryStatus;
  attempt_count: number;
  max_attempts: number;
  next_attempt_at: Date;
  lease_expires_at: Date | null;
  last_error: string | null;
  delivered_at: Date | null;
  dead_lettered_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface GenerationTaskRow {
  id: string;
  generation_id: string;
  attempt_id: string;
  status: "pending" | "resolved";
  payload: GenerationTaskRequest;
  resolution: GenerationTaskResolution | null;
  created_at: Date;
  resolved_at: Date | null;
}

interface GenerationSteeringRow {
  id: string;
  generation_id: string;
  message_id: string;
  submitted_attempt_id: string;
  applied_attempt_id: string | null;
  prompt: string;
  status: GenerationSteeringStatus;
  idempotency_key: string | null;
  created_at: Date;
  applied_at: Date | null;
}

interface SkillSnapshotRow {
  name: string;
  description: string;
  category: string;
  source: string;
  locator: string;
  content_hash: string;
  files: ResolvedSkill["files"];
}

interface VersionRow {
  id: string;
  chat_id: string;
  generation_id: string | null;
  parent_version_id: string | null;
  number: number;
  origin: VersionData["origin"];
  framework: string;
  title: string;
  summary: string;
  created_at: Date;
}

interface DesignEvaluationRow {
  id: string;
  chat_id: string;
  version_id: string;
  generation_id: string | null;
  evaluator: string;
  status: DesignEvaluationStatus;
  score: number;
  summary: string;
  criteria: DesignEvaluationCriterionInput[];
  evidence: DesignEvaluationEvidence[];
  metadata: ChatMetadata;
  created_at: Date;
}

interface MessageRow {
  id: string;
  chat_id: string;
  generation_id: string | null;
  role: "user" | "assistant";
  content: string;
  finish_reason: string | null;
  created_at: Date;
}

interface MessagePartRow {
  id: string;
  message_id: string;
  generation_id: string | null;
  attempt_id: string | null;
  position: number;
  type: MessagePartType;
  data: MessagePart["data"];
  created_at: Date;
}

interface AttachmentRow {
  id: string;
  chat_id: string;
  message_id: string;
  generation_id: string;
  filename: string;
  media_type: string;
  size: number;
  checksum: string;
  artifact_store: string;
  artifact_key: string;
  content?: Uint8Array;
  created_at: Date;
}

interface ChatSnapshotRow {
  readonly chat: ChatRow;
  readonly messages: MessageRow[];
  readonly versions: VersionRow[];
  readonly parts: MessagePartRow[];
  readonly attachments: AttachmentRow[];
}

interface GenerationSnapshotRow {
  readonly generation: GenerationRow;
  readonly attempts: GenerationAttemptRow[];
  readonly tasks: GenerationTaskRow[];
  readonly steering: GenerationSteeringRow[];
  readonly tool_calls: ToolCallRow[];
  readonly artifacts: GeneratedArtifactRow[];
  readonly version: VersionRow | null;
}

interface StoredAttachmentInput {
  readonly id: string;
  readonly filename: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly artifactStore: string;
  readonly artifactKey: string;
}

interface GeneratedArtifactRow {
  id: string;
  chat_id: string;
  generation_id: string;
  attempt_id: string;
  version_id: string | null;
  position: number;
  kind: GeneratedArtifactKind;
  filename: string;
  media_type: string;
  size: number;
  checksum: string;
  artifact_store: string;
  artifact_key: string;
  created_at: Date;
}

interface StoredGeneratedArtifactInput extends Omit<CreateGeneratedArtifactRecord, "bytes"> {
  readonly artifactStore: string;
  readonly artifactKey: string;
}

interface ProjectArtifactRow {
  id: string;
  media_type: string;
  size: number;
  checksum: string;
  artifact_store: string;
  artifact_key: string;
  created_at: Date;
}

interface StoredProjectArtifactInput extends Omit<CreateProjectArtifactRecord, "bytes"> {
  readonly artifactStore: string;
  readonly artifactKey: string;
}

interface VisualArtifactRow {
  id: string;
  chat_id: string;
  version_id: string;
  page_id: string;
  path: string;
  url: string;
  filename: string;
  media_type: "image/png" | "image/jpeg";
  width: number;
  height: number;
  size: number;
  checksum: string;
  artifact_store: string;
  artifact_key: string;
  created_at: Date;
}

interface StoredArtifactLocation {
  readonly id: string;
  readonly artifact_store: string;
  readonly artifact_key: string;
  readonly kind: "attachment" | "generated" | "project" | "visual" | "deployment";
}

interface ToolCallRow {
  id: string;
  generation_id: string;
  attempt_id: string;
  message_id: string | null;
  provider_call_id: string;
  name: string;
  effect: ToolCallEffect;
  arguments: ToolCallData["arguments"];
  result: ToolCallData["result"];
  status: ToolCallStatus;
  error: string | null;
  idempotency_key: string | null;
  created_at: Date;
  completed_at: Date | null;
}

interface VersionFileRow {
  path: string;
  kind: "text" | "artifact";
  content: string | null;
  artifact_id: string | null;
  media_type: string;
  size: number;
  checksum: string;
  locked: boolean;
}

interface SandboxLeaseRow {
  id: string;
  tenant_id: string;
  user_id: string;
  chat_id: string;
  version_id: string;
  framework: string;
  provider: string;
  sandbox_id: string;
  ports: number[];
  status: SandboxLeaseStatus;
  expires_at: Date;
  stopped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface PreviewSessionRow {
  id: string;
  chat_id: string;
  version_id: string;
  sandbox_lease_id: string;
  sandbox_provider: string;
  framework: string;
  port: number;
  path: string;
  url: string | null;
  status: PreviewStatus;
  error: string | null;
  expires_at: Date;
  ready_at: Date | null;
  stopped_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface ToolSourceRegistrationRow {
  id: string;
  type: string;
  name: string;
  description: string | null;
  configuration: Record<string, JsonValue>;
  status: ToolSourceRegistrationStatus;
  created_at: Date;
  updated_at: Date;
}

interface ToolSourceAuthorizationSessionRow {
  tenant_id: string;
  user_id: string;
  id: string;
  tool_source_id: string;
  provider: string;
  state_hash: string;
  callback_url: string;
  return_to: string;
  scopes: string[];
  session_secret_ref: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

interface ToolSourceConnectionRow {
  id: string;
  tool_source_id: string;
  provider: string;
  external_account_id: string;
  external_account_name: string;
  external_account_url: string | null;
  external_account_metadata: Record<string, JsonValue> | null;
  secret_ref: string | null;
  status: IntegrationConnectionStatus;
  scopes: string[];
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface RepositoryLinkRow {
  id: string;
  chat_id: string;
  integration_id: string;
  connection_id: string;
  provider: string;
  provider_repository_id: string;
  owner: string;
  name: string;
  default_branch: string;
  visibility: RepositoryVisibility;
  url: string;
  created_at: Date;
  updated_at: Date;
}

interface RepositoryPushRow {
  id: string;
  chat_id: string;
  version_id: string;
  repository_link_id: string | null;
  integration_id: string;
  connection_id: string;
  provider: string;
  repository_owner: string;
  repository_name: string;
  branch: string;
  commit_message: string;
  expected_head: string | null;
  status: RepositoryPushStatus;
  commit: RepositoryCommitData | null;
  changed_files: number | null;
  pull_request: RepositoryPullRequestData | null;
  actual_head: string | null;
  error: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface DeploymentProjectLinkRow {
  id: string;
  chat_id: string;
  integration_id: string;
  connection_id: string;
  provider: string;
  provider_project_id: string;
  name: string;
  url: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DeploymentRow {
  id: string;
  chat_id: string;
  version_id: string;
  project_link_id: string | null;
  preparation_artifact_id: string | null;
  integration_id: string;
  connection_id: string;
  provider: string;
  project_target: string;
  environment: DeploymentEnvironment;
  provider_deployment_id: string | null;
  provider_created_at: Date | null;
  url: string | null;
  status: DeploymentHistoryStatus;
  error: string | null;
  idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface DeploymentArtifactRow {
  id: string;
  chat_id: string;
  version_id: string;
  deployment_id: string;
  framework: FrameworkId;
  sandbox_provider: string;
  output_directory: string;
  commands: DeploymentArtifactCommand[];
  file_count: number;
  media_type: "application/zip";
  size: number;
  checksum: string;
  artifact_store: string;
  artifact_key: string;
  created_at: Date;
}

interface DeploymentStatusTransitionRow {
  id: string;
  deployment_id: string;
  status: DeploymentHistoryStatus;
  url: string | null;
  error: string | null;
  created_at: Date;
}

export class PostgresRepository implements Repository {
  readonly #sql: ReturnType<typeof postgres>;
  readonly #artifactStore: ArtifactStore | undefined;
  #ready = false;
  #readyPromise: Promise<void> | undefined;

  constructor(databaseUrl: string, artifactStore?: ArtifactStore) {
    if (artifactStore) normalizeArtifactStoreId(artifactStore.id);
    this.#artifactStore = artifactStore;
    this.#sql = postgres(databaseUrl, {
      max: 10,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => undefined,
    });
  }

  async assertReady(): Promise<void> {
    if (this.#ready) return;
    this.#readyPromise ??= this.#checkReady();
    try {
      await this.#readyPromise;
    } catch (error) {
      this.#readyPromise = undefined;
      throw error;
    }
  }

  async #checkReady(): Promise<void> {
    const [row] = await this.#sql<{ ready: boolean }[]>`
      SELECT
        to_regclass('viby.chats') IS NOT NULL
        AND to_regclass('viby.generation_attempts') IS NOT NULL
        AND to_regclass('viby.generation_engine_checkpoints') IS NOT NULL
        AND to_regclass('viby.message_feedback') IS NOT NULL
        AND to_regclass('viby.generation_events') IS NOT NULL
        AND to_regclass('viby.generation_tasks') IS NOT NULL
        AND to_regclass('viby.generation_steering') IS NOT NULL
        AND to_regclass('viby.sandbox_leases') IS NOT NULL
        AND to_regclass('viby.preview_sessions') IS NOT NULL
        AND to_regclass('viby.tool_sources') IS NOT NULL
        AND to_regclass('viby.chat_tool_sources') IS NOT NULL
        AND to_regclass('viby.tool_source_authorization_sessions') IS NOT NULL
        AND to_regclass('viby.tool_source_connections') IS NOT NULL
        AND to_regclass('viby.version_changes') IS NOT NULL
        AND to_regclass('viby.message_parts') IS NOT NULL
        AND to_regclass('viby.tool_calls') IS NOT NULL
        AND to_regclass('viby.outbound_event_deliveries') IS NOT NULL
        AND to_regclass('viby.generated_artifacts') IS NOT NULL
        AND to_regclass('viby.visual_artifacts') IS NOT NULL
        AND to_regclass('viby.project_artifacts') IS NOT NULL
        AND to_regclass('viby.repository_links') IS NOT NULL
        AND to_regclass('viby.repository_pushes') IS NOT NULL
        AND to_regclass('viby.deployment_project_links') IS NOT NULL
        AND to_regclass('viby.deployments') IS NOT NULL
        AND to_regclass('viby.deployment_status_transitions') IS NOT NULL
        AND to_regclass('viby.deployment_artifacts') IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'viby' AND table_name = 'attachments'
            AND column_name = 'artifact_key'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'viby' AND table_name = 'version_files'
            AND column_name = 'artifact_id'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'viby' AND table_name = 'deployments'
            AND column_name = 'preparation_artifact_id'
        )
        AND EXISTS (
          SELECT 1 FROM information_schema.columns
          WHERE table_schema = 'viby' AND table_name = 'generations'
            AND column_name = 'estimated_cost_micros'
        ) AS ready
    `;
    if (!row?.ready) throw new DatabaseNotReadyError();
    this.#ready = true;
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async createChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: { id: string; title: string; metadata: ChatMetadata; framework: Framework },
  ): Promise<ChatData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<ChatRow[]>`
      INSERT INTO viby.chats (id, tenant_id, user_id, title, metadata, framework)
      VALUES (
        ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.title},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.metadata)))}, ${input.framework}
      )
      RETURNING *
    `;
    if (!row) throw new Error("Postgres did not return the created chat.");
    return mapChat<Framework>(row);
  }

  async importChat<Framework extends FrameworkId>(
    scope: UserScope,
    input: ImportChatRecord<Framework>,
  ): Promise<ImportedChat<Framework>> {
    await this.assertReady();
    const artifacts = await this.#storeProjectArtifacts(scope, input.artifacts ?? []);
    try {
      const result = await this.#sql.begin(async (sql) => {
        const [chat] = await sql<ChatRow[]>`
          INSERT INTO viby.chats (id, tenant_id, user_id, title, metadata, framework)
          VALUES (
            ${input.chatId}, ${scope.tenantId}, ${scope.userId}, ${input.title},
            ${sql.json(JSON.parse(JSON.stringify(input.metadata)))}, ${input.framework}
          )
          RETURNING *
        `;
        if (!chat) throw new Error("Postgres did not return the imported chat.");

        const [version] = await sql<VersionRow[]>`
          INSERT INTO viby.versions (
            id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
            number, origin, framework, title, summary
          ) VALUES (
            ${input.versionId}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, NULL, NULL,
            1, 'imported', ${input.framework}, ${input.title}, ${input.summary}
          )
          RETURNING *
        `;
        if (!version) throw new Error("Postgres did not return the imported version.");
        await insertProjectArtifacts(sql, scope, artifacts);
        await insertVersionEntries(sql, scope, input.versionId, input.files, artifacts);
        return { chat, version };
      });

      return {
        chat: mapChat<Framework>(result.chat),
        version: mapVersion<Framework>(result.version),
      };
    } catch (error) {
      await this.#cleanupProjectArtifacts(scope, artifacts);
      throw error;
    }
  }

  async createSourceVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSourceVersionRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [chat] = await sql<{ id: string }[]>`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.chatId}
        FOR UPDATE
      `;
      if (!chat) throw new NotFoundError("Chat");

      const [parent] = await sql<{ id: string }[]>`
        SELECT id FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.parentVersionId} AND chat_id = ${input.chatId}
        LIMIT 1
      `;
      if (!parent) throw new NotFoundError("Parent version");

      const [numberRow] = await sql<{ number: number }[]>`
        SELECT COALESCE(MAX(number), 0)::integer + 1 AS number
        FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${input.chatId}
      `;
      const [version] = await sql<VersionRow[]>`
        INSERT INTO viby.versions (
          id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
          number, origin, framework, title, summary
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, NULL,
          ${input.parentVersionId}, ${numberRow?.number ?? 1}, ${input.origin},
          ${input.framework}, ${input.title}, ${input.summary}
        )
        RETURNING *
      `;
      if (!version) throw new Error("Postgres did not return the source version.");

      await insertVersionEntries(sql, scope, input.id, input.files, input.artifacts ?? []);

      for (const [position, change] of input.changes.entries()) {
        await sql`
          INSERT INTO viby.version_changes (
            tenant_id, user_id, version_id, position, change
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${input.id}, ${position},
            ${sql.json(JSON.parse(JSON.stringify(change)))}
          )
        `;
      }
      await sql`
        UPDATE viby.chats SET updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.chatId}
      `;
      return version;
    });
    return mapVersion<Framework>(row);
  }

  async forkVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: ForkVersionRecord<Framework>,
  ): Promise<ImportedChat<Framework>> {
    await this.assertReady();
    const result = await this.#sql.begin(async (sql) => {
      const [source] = await sql<VersionRow[]>`
        SELECT * FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.sourceVersionId}
        LIMIT 1
      `;
      if (!source) throw new NotFoundError("Source version");

      const files = await sql<VersionFileRow[]>`
        SELECT path, kind, content, artifact_id, media_type, size, checksum, locked
        FROM viby.version_files
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND version_id = ${source.id}
        ORDER BY path
      `;
      const [chat] = await sql<ChatRow[]>`
        INSERT INTO viby.chats (id, tenant_id, user_id, title, metadata, framework)
        VALUES (
          ${input.chatId}, ${scope.tenantId}, ${scope.userId}, ${input.title},
          ${sql.json(JSON.parse(JSON.stringify(input.metadata)))}, ${input.framework}
        )
        RETURNING *
      `;
      if (!chat) throw new Error("Postgres did not return the forked chat.");
      const [version] = await sql<VersionRow[]>`
        INSERT INTO viby.versions (
          id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
          number, origin, framework, title, summary
        ) VALUES (
          ${input.versionId}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, NULL,
          ${source.id}, 1, 'forked', ${input.framework}, ${input.title}, ${input.summary}
        )
        RETURNING *
      `;
      if (!version) throw new Error("Postgres did not return the forked version.");
      await copyVersionEntryRows(sql, scope, input.versionId, files);
      return { chat, version };
    });
    return {
      chat: mapChat<Framework>(result.chat),
      version: mapVersion<Framework>(result.version),
    };
  }

  async restoreVersion<Framework extends FrameworkId>(
    scope: UserScope,
    input: RestoreVersionRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [chat] = await sql<{ id: string }[]>`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.chatId}
        FOR UPDATE
      `;
      if (!chat) throw new NotFoundError("Chat");
      const [source] = await sql<VersionRow[]>`
        SELECT * FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.sourceVersionId} AND chat_id = ${input.chatId}
        LIMIT 1
      `;
      if (!source) throw new NotFoundError("Source version");
      const files = await sql<VersionFileRow[]>`
        SELECT path, kind, content, artifact_id, media_type, size, checksum, locked
        FROM viby.version_files
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND version_id = ${source.id}
        ORDER BY path
      `;
      const [numberRow] = await sql<{ number: number }[]>`
        SELECT COALESCE(MAX(number), 0)::integer + 1 AS number
        FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${input.chatId}
      `;
      const [version] = await sql<VersionRow[]>`
        INSERT INTO viby.versions (
          id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
          number, origin, framework, title, summary
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, NULL,
          ${source.id}, ${numberRow?.number ?? 1}, 'restored', ${input.framework},
          ${input.title}, ${input.summary}
        )
        RETURNING *
      `;
      if (!version) throw new Error("Postgres did not return the restored version.");
      await copyVersionEntryRows(sql, scope, input.id, files);
      await sql`
        UPDATE viby.chats SET updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.chatId}
      `;
      return version;
    });
    return mapVersion<Framework>(row);
  }

  async getChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<ChatData<Framework> | null> {
    if (!isUuid(id)) return null;
    await this.assertReady();
    const [row] = await this.#sql<ChatRow[]>`
      SELECT * FROM viby.chats
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    return row ? mapChat<Framework>(row) : null;
  }

  async readChatSnapshot<Framework extends FrameworkId>(
    scope: UserScope,
    options: ChatReadSnapshotOptions,
  ): Promise<ChatReadSnapshot<Framework> | null> {
    if (!isUuid(options.chatId)) return null;
    await this.assertReady();
    const messageAfterAt = options.messages.after?.createdAt.toISOString() ?? null;
    const messageAfterId = options.messages.after?.id ?? null;
    const versionAfter = options.versions.after?.number ?? null;
    const [row] = await this.#sql<ChatSnapshotRow[]>`
      WITH selected_chat AS (
        SELECT * FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${options.chatId} AND deleted_at IS NULL
        LIMIT 1
      ), selected_messages AS (
        SELECT id, chat_id, generation_id, role, content, finish_reason, created_at
        FROM viby.messages
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${options.chatId}
          AND EXISTS (SELECT 1 FROM selected_chat)
          AND (
            ${messageAfterAt}::timestamptz IS NULL
            OR date_trunc('milliseconds', created_at) > ${messageAfterAt}::timestamptz
            OR (
              date_trunc('milliseconds', created_at) = ${messageAfterAt}::timestamptz
              AND id > ${messageAfterId}::uuid
            )
          )
        ORDER BY date_trunc('milliseconds', created_at), id
        LIMIT ${options.messages.limit + 1}
      ), selected_versions AS (
        SELECT id, chat_id, generation_id, parent_version_id, number, origin,
          framework, title, summary, created_at
        FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${options.chatId}
          AND EXISTS (SELECT 1 FROM selected_chat)
          AND (${versionAfter}::integer IS NULL OR number < ${versionAfter}::integer)
        ORDER BY number DESC
        LIMIT ${options.versions.limit + 1}
      )
      SELECT
        to_jsonb(chat) AS chat,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(message)
            ORDER BY date_trunc('milliseconds', message.created_at), message.id)
          FROM selected_messages AS message
        ), '[]'::jsonb) AS messages,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(version) ORDER BY version.number DESC)
          FROM selected_versions AS version
        ), '[]'::jsonb) AS versions,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(part) ORDER BY part.message_id, part.position)
          FROM viby.message_parts AS part
          WHERE part.tenant_id = ${scope.tenantId} AND part.user_id = ${scope.userId}
            AND part.message_id IN (SELECT id FROM selected_messages)
        ), '[]'::jsonb) AS parts,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(attachment)
            ORDER BY attachment.message_id, attachment.created_at, attachment.id)
          FROM viby.attachments AS attachment
          WHERE attachment.tenant_id = ${scope.tenantId} AND attachment.user_id = ${scope.userId}
            AND attachment.message_id IN (SELECT id FROM selected_messages)
        ), '[]'::jsonb) AS attachments
      FROM selected_chat AS chat
    `;
    if (!row) return null;

    const parts = new Map<string, MessagePart[]>();
    for (const part of row.parts) {
      const current = parts.get(part.message_id) ?? [];
      current.push(mapMessagePart(withCreatedAt(part)));
      parts.set(part.message_id, current);
    }
    const attachments = new Map<string, AttachmentData[]>();
    for (const attachment of row.attachments) {
      const current = attachments.get(attachment.message_id) ?? [];
      current.push(mapAttachment(withCreatedAt(attachment)));
      attachments.set(attachment.message_id, current);
    }
    const messages = row.messages.map((message) => {
      const hydrated = withCreatedAt(message);
      return mapMessage(hydrated, parts.get(hydrated.id) ?? [], attachments.get(hydrated.id) ?? []);
    });
    return {
      chat: mapChat<Framework>({
        ...row.chat,
        created_at: repositoryDate(row.chat.created_at),
        updated_at: repositoryDate(row.chat.updated_at),
        deleted_at: repositoryNullableDate(row.chat.deleted_at),
        purge_after: repositoryNullableDate(row.chat.purge_after),
      }),
      messages: createPage(messages, options.messages.limit),
      versions: createPage(
        row.versions.map((version) => mapVersion<Framework>(withCreatedAt(version))),
        options.versions.limit,
      ),
    };
  }

  async updateChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    input: UpdateChatRecord,
  ): Promise<ChatData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<ChatRow[]>`
      UPDATE viby.chats SET
        title = ${input.title},
        metadata = ${this.#sql.json(JSON.parse(JSON.stringify(input.metadata)))},
        updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
        AND deleted_at IS NULL
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Chat");
    return mapChat<Framework>(row);
  }

  async deleteChat(
    scope: UserScope,
    id: string,
    input: DeleteChatRecord,
  ): Promise<ChatDeletionData> {
    await this.assertReady();
    return this.#sql.begin(async (sql) => {
      const [chat] = await sql<ChatRow[]>`
        SELECT * FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${id} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!chat) throw new NotFoundError("Chat");
      const [active] = await sql<{ id: string }[]>`
        SELECT id FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${id} AND status IN ('queued', 'running', 'waiting')
        LIMIT 1
      `;
      if (active) throw new GenerationStateError(id, "Chat has an active generation.");
      const [deleted] = await sql<ChatRow[]>`
        UPDATE viby.chats SET
          deleted_at = ${input.deletedAt}, purge_after = ${input.purgeAfter}
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
        RETURNING *
      `;
      if (!deleted?.deleted_at) throw new Error("Postgres did not return the deleted chat.");
      return {
        chatId: deleted.id,
        deletedAt: deleted.deleted_at,
        purgeAfter: deleted.purge_after,
      };
    });
  }

  async restoreChat<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    now: Date,
  ): Promise<ChatData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<ChatRow[]>`
      UPDATE viby.chats SET deleted_at = NULL, purge_after = NULL, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
        AND deleted_at IS NOT NULL
        AND (purge_after IS NULL OR purge_after > ${now})
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Deleted chat");
    return mapChat<Framework>(row);
  }

  async purgeDeletedChats(scope: UserScope, now: Date, limit: number): Promise<number> {
    await this.assertReady();
    const result = await this.#sql.begin(async (sql) => {
      const candidates = await sql<{ id: string }[]>`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND deleted_at IS NOT NULL AND purge_after IS NOT NULL AND purge_after <= ${now}
        ORDER BY purge_after, id
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      `;
      if (candidates.length === 0) return { count: 0, artifacts: [] as StoredArtifactLocation[] };
      const ids = candidates.map(({ id }) => id);
      const artifacts = await sql<StoredArtifactLocation[]>`
        SELECT id, artifact_store, artifact_key, 'attachment'::text AS kind
        FROM viby.attachments
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ANY(${sql.array(ids)}::uuid[])
        UNION ALL
        SELECT id, artifact_store, artifact_key, 'generated'::text AS kind
        FROM viby.generated_artifacts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ANY(${sql.array(ids)}::uuid[])
        UNION ALL
        SELECT id, artifact_store, artifact_key, 'visual'::text AS kind
        FROM viby.visual_artifacts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ANY(${sql.array(ids)}::uuid[])
        UNION ALL
        SELECT id, artifact_store, artifact_key, 'deployment'::text AS kind
        FROM viby.deployment_artifacts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ANY(${sql.array(ids)}::uuid[])
      `;
      const projectArtifactIds = await sql<{ id: string }[]>`
        SELECT DISTINCT entry.artifact_id AS id
        FROM viby.version_files AS entry
        JOIN viby.versions AS version ON version.id = entry.version_id
        WHERE entry.tenant_id = ${scope.tenantId} AND entry.user_id = ${scope.userId}
          AND version.chat_id = ANY(${sql.array(ids)}::uuid[])
          AND entry.artifact_id IS NOT NULL
      `;
      const deleted = await sql<{ id: string }[]>`
        DELETE FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ANY(${sql.array(ids)}::uuid[])
        RETURNING id
      `;
      const projectArtifacts =
        projectArtifactIds.length === 0
          ? []
          : await sql<StoredArtifactLocation[]>`
            DELETE FROM viby.project_artifacts AS artifact
            WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
              AND artifact.id = ANY(${sql.array(projectArtifactIds.map(({ id }) => id))}::uuid[])
              AND NOT EXISTS (
                SELECT 1 FROM viby.version_files AS entry
                WHERE entry.artifact_id = artifact.id
              )
            RETURNING artifact.id, artifact.artifact_store, artifact.artifact_key,
              'project'::text AS kind
          `;
      return { count: deleted.length, artifacts: [...artifacts, ...projectArtifacts] };
    });
    await Promise.allSettled(
      result.artifacts.map((artifact) => this.#deleteStoredArtifact(scope, artifact)),
    );
    return result.count;
  }

  async listChats<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
  ): Promise<Array<ChatData<Framework>>> {
    await this.assertReady();
    const rows = await this.#sql<ChatRow[]>`
      SELECT * FROM viby.chats
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND deleted_at IS NULL
      ORDER BY updated_at DESC
      LIMIT ${limit}
    `;
    return rows.map(mapChat<Framework>);
  }

  async listChatPage<Framework extends FrameworkId>(
    scope: UserScope,
    limit: number,
    after: ChatPageCursor | null,
    metadata: ChatMetadata,
  ): Promise<RepositoryPage<ChatData<Framework>>> {
    await this.assertReady();
    const filter = this.#sql.json(JSON.parse(JSON.stringify(metadata)));
    const rows = after
      ? await this.#sql<ChatRow[]>`
          SELECT * FROM viby.chats
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND deleted_at IS NULL
            AND metadata @> ${filter}::jsonb
            AND (
              date_trunc('milliseconds', updated_at) < ${after.updatedAt}
              OR (
                date_trunc('milliseconds', updated_at) = ${after.updatedAt}
                AND id < ${after.id}
              )
            )
          ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC
          LIMIT ${limit + 1}
        `
      : await this.#sql<ChatRow[]>`
          SELECT * FROM viby.chats
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND deleted_at IS NULL
            AND metadata @> ${filter}::jsonb
          ORDER BY date_trunc('milliseconds', updated_at) DESC, id DESC
          LIMIT ${limit + 1}
        `;
    return createPage(rows.map(mapChat<Framework>), limit);
  }

  async createGeneration(
    scope: UserScope,
    input: CreateGenerationRecord,
  ): Promise<CreatedGeneration> {
    await this.assertReady();
    const attachments = await this.#storeAttachments(scope, input);
    let result: { generation: GenerationRow; attempt: GenerationAttemptRow };
    try {
      result = await this.#sql.begin(async (sql) => {
        const [generation] = await sql<GenerationRow[]>`
        INSERT INTO viby.generations (
          id, tenant_id, user_id, chat_id, base_version_id, active_attempt_id,
          attempt_count, prompt, status, model_provider, model_id, configuration
        )
        SELECT ${input.id}, ${scope.tenantId}, ${scope.userId}, id, ${input.baseVersionId},
          ${input.attemptId}, 1, ${input.prompt}, 'queued', ${input.modelProvider}, ${input.modelId},
          ${sql.json(
            JSON.parse(JSON.stringify(input.configuration ?? defaultGenerationConfiguration())),
          )}
        FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.chatId}
          AND deleted_at IS NULL
          AND (
            ${input.baseVersionId}::uuid IS NULL
            OR EXISTS (
              SELECT 1 FROM viby.versions AS base
              WHERE base.tenant_id = ${scope.tenantId}
                AND base.user_id = ${scope.userId}
                AND base.chat_id = ${input.chatId}
                AND base.id = ${input.baseVersionId}::uuid
            )
          )
        RETURNING *
      `;
        if (!generation) throw new NotFoundError("Chat");

        const [attempt] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status, model_provider, model_id
        ) VALUES (
          ${input.attemptId}, ${scope.tenantId}, ${scope.userId}, ${input.id}, 1,
          'initial', 'queued', ${input.modelProvider}, ${input.modelId}
        )
        RETURNING *
      `;
        if (!attempt) throw new Error("Postgres did not return the created attempt.");

        await insertMessage(sql, scope, {
          chatId: input.chatId,
          generationId: input.id,
          attemptId: input.attemptId,
          role: "user",
          content: input.prompt,
          parts: [{ type: "text", data: { text: input.prompt } }],
          attachments,
        });
        await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.id}, ${input.attemptId},
          'generation.created', ${sql.json({ prompt: input.prompt })}
        )
      `;
        await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.id}, ${input.attemptId},
          'attempt.queued', ${sql.json({ number: 1, reason: "initial" })}
        )
      `;
        return { generation, attempt };
      });
    } catch (error) {
      await Promise.allSettled(
        attachments.map((attachment) =>
          this.#artifactStore!.delete(
            attachment.artifactKey,
            attachmentContext(scope, attachment.id),
          ),
        ),
      );
      throw error;
    }

    return {
      generation: mapGeneration(result.generation),
      attempt: mapAttempt(result.attempt),
    };
  }

  async createGenerationSteering(
    scope: UserScope,
    input: CreateGenerationSteeringRecord,
  ): Promise<GenerationSteeringData> {
    await this.assertReady();
    if (input.idempotencyKey) {
      const [existing] = await this.#sql<GenerationSteeringRow[]>`
        SELECT * FROM viby.generation_steering
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId}
          AND idempotency_key = ${input.idempotencyKey}
      `;
      if (existing) return mapGenerationSteering(existing);
    }
    const attachments = await this.#storeAttachments(scope, input);
    try {
      const result = await this.#sql.begin(async (sql) => {
        const [generation] = await sql<GenerationRow[]>`
          SELECT * FROM viby.generations
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND id = ${input.generationId}
          FOR UPDATE
        `;
        if (!generation) throw new NotFoundError("Generation");
        if (!(["queued", "running", "waiting"] as GenerationStatus[]).includes(generation.status)) {
          throw new GenerationStateError(
            input.generationId,
            `Generation ${input.generationId} cannot be steered from ${generation.status}.`,
          );
        }
        if (input.idempotencyKey) {
          const [existing] = await sql<GenerationSteeringRow[]>`
            SELECT * FROM viby.generation_steering
            WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
              AND generation_id = ${input.generationId}
              AND idempotency_key = ${input.idempotencyKey}
          `;
          if (existing) return { row: existing, created: false };
        }
        await insertMessage(sql, scope, {
          id: input.messageId,
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: generation.active_attempt_id,
          role: "user",
          content: input.prompt,
          parts: [{ type: "text", data: { text: input.prompt } }],
          attachments,
        });
        const [steering] = await sql<GenerationSteeringRow[]>`
          INSERT INTO viby.generation_steering (
            id, tenant_id, user_id, generation_id, message_id,
            submitted_attempt_id, prompt, idempotency_key
          ) VALUES (
            ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.generationId},
            ${input.messageId}, ${generation.active_attempt_id}, ${input.prompt},
            ${input.idempotencyKey ?? null}
          )
          RETURNING *
        `;
        if (!steering) throw new Error("Postgres did not return the created steering record.");
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${input.generationId},
            ${generation.active_attempt_id}, 'steering.queued',
            ${sql.json({ steeringId: input.id, messageId: input.messageId, prompt: input.prompt })}
          )
        `;
        await sql`
          UPDATE viby.chats SET updated_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND id = ${generation.chat_id}
        `;
        return { row: steering, created: true };
      });
      if (!result.created) {
        await Promise.allSettled(
          attachments.map((attachment) =>
            this.#artifactStore!.delete(
              attachment.artifactKey,
              attachmentContext(scope, attachment.id),
            ),
          ),
        );
      }
      return mapGenerationSteering(result.row);
    } catch (error) {
      await Promise.allSettled(
        attachments.map((attachment) =>
          this.#artifactStore!.delete(
            attachment.artifactKey,
            attachmentContext(scope, attachment.id),
          ),
        ),
      );
      throw error;
    }
  }

  async listGenerationSteering(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationSteeringData[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationSteeringRow[]>`
      SELECT steering.* FROM viby.generation_steering AS steering
      JOIN viby.generations AS generation ON generation.id = steering.generation_id
      WHERE steering.tenant_id = ${scope.tenantId} AND steering.user_id = ${scope.userId}
        AND steering.generation_id = ${generationId}
        AND generation.tenant_id = steering.tenant_id AND generation.user_id = steering.user_id
      ORDER BY steering.created_at, steering.id
    `;
    return rows.map(mapGenerationSteering);
  }

  async consumeGenerationSteering(
    scope: UserScope,
    input: ConsumeGenerationSteeringRecord,
  ): Promise<GenerationSteeringData[]> {
    await this.assertReady();
    const rows = await this.#sql.begin(async (sql) => {
      await assertActiveToolAttempt(sql, scope, input);
      const queued = await sql<GenerationSteeringRow[]>`
        SELECT * FROM viby.generation_steering
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId} AND status = 'queued'
        ORDER BY created_at, id
        FOR UPDATE
      `;
      const applied: GenerationSteeringRow[] = [];
      for (const steering of queued) {
        const [updated] = await sql<GenerationSteeringRow[]>`
          UPDATE viby.generation_steering SET
            status = 'applied', applied_attempt_id = ${input.attemptId}, applied_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND id = ${steering.id} AND status = 'queued'
          RETURNING *
        `;
        if (!updated) continue;
        applied.push(updated);
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
            'steering.applied',
            ${sql.json({
              steeringId: updated.id,
              messageId: updated.message_id,
              prompt: updated.prompt,
            })}
          )
        `;
      }
      return applied;
    });
    return rows.map(mapGenerationSteering);
  }

  async getGenerationEngineCheckpoint(
    scope: UserScope,
    generationId: string,
    attemptId: string,
  ): Promise<GenerationEngineCheckpointData | null> {
    await this.assertReady();
    const [row] = await this.#sql<GenerationEngineCheckpointRow[]>`
      SELECT checkpoint.* FROM viby.generation_engine_checkpoints AS checkpoint
      JOIN viby.generations AS generation ON generation.id = checkpoint.generation_id
      JOIN viby.generation_attempts AS attempt ON attempt.id = checkpoint.attempt_id
      WHERE checkpoint.tenant_id = ${scope.tenantId} AND checkpoint.user_id = ${scope.userId}
        AND checkpoint.generation_id = ${generationId} AND checkpoint.attempt_id = ${attemptId}
        AND generation.tenant_id = checkpoint.tenant_id
        AND generation.user_id = checkpoint.user_id
        AND attempt.generation_id = checkpoint.generation_id
      LIMIT 1
    `;
    return row ? mapGenerationEngineCheckpoint(row) : null;
  }

  async saveGenerationEngineCheckpoint(
    scope: UserScope,
    input: SaveGenerationEngineCheckpointRecord,
  ): Promise<GenerationEngineCheckpointData> {
    await this.assertReady();
    const state = normalizeGenerationCheckpointState(input.state);
    const cursor = normalizeGenerationCheckpointCursor(input.cursor);
    const [row] = await this.#sql<GenerationEngineCheckpointRow[]>`
      INSERT INTO viby.generation_engine_checkpoints AS checkpoint (
        tenant_id, user_id, generation_id, attempt_id, cursor, state
      )
      SELECT ${scope.tenantId}, ${scope.userId}, generation.id, attempt.id, ${cursor},
        ${this.#sql.json(state)}
      FROM viby.generations AS generation
      JOIN viby.generation_attempts AS attempt ON attempt.id = generation.active_attempt_id
      WHERE generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
        AND generation.id = ${input.generationId} AND generation.status = 'running'
        AND attempt.id = ${input.attemptId} AND attempt.status = 'running'
        AND attempt.lease_token = ${input.leaseToken} AND attempt.lease_expires_at > now()
      ON CONFLICT (tenant_id, user_id, generation_id, attempt_id)
      DO UPDATE SET
        revision = checkpoint.revision + 1,
        cursor = EXCLUDED.cursor,
        state = EXCLUDED.state,
        updated_at = now()
      RETURNING *
    `;
    if (!row) {
      throw new GenerationStateError(
        input.generationId,
        "The generation worker lease is no longer active.",
      );
    }
    return mapGenerationEngineCheckpoint(row);
  }

  async clearGenerationEngineCheckpoint(
    scope: UserScope,
    input: ClearGenerationEngineCheckpointRecord,
  ): Promise<void> {
    await this.assertReady();
    const rows = await this.#sql<{ attempt_id: string }[]>`
      DELETE FROM viby.generation_engine_checkpoints AS checkpoint
      USING viby.generations AS generation, viby.generation_attempts AS attempt
      WHERE checkpoint.tenant_id = ${scope.tenantId} AND checkpoint.user_id = ${scope.userId}
        AND checkpoint.generation_id = ${input.generationId}
        AND checkpoint.attempt_id = ${input.attemptId}
        AND generation.id = checkpoint.generation_id AND generation.status = 'running'
        AND generation.active_attempt_id = attempt.id
        AND attempt.id = checkpoint.attempt_id AND attempt.status = 'running'
        AND attempt.lease_token = ${input.leaseToken} AND attempt.lease_expires_at > now()
      RETURNING checkpoint.attempt_id
    `;
    if (rows.length === 0) {
      const active = await this.#sql<{ active: boolean }[]>`
        SELECT true AS active FROM viby.generations AS generation
        JOIN viby.generation_attempts AS attempt ON attempt.id = generation.active_attempt_id
        WHERE generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
          AND generation.id = ${input.generationId} AND generation.status = 'running'
          AND attempt.id = ${input.attemptId} AND attempt.status = 'running'
          AND attempt.lease_token = ${input.leaseToken} AND attempt.lease_expires_at > now()
      `;
      if (active.length === 0) {
        throw new GenerationStateError(
          input.generationId,
          "The generation worker lease is no longer active.",
        );
      }
    }
  }

  async startGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
  ): Promise<GenerationAttemptData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.active_attempt_id !== attemptId || generation.status !== "queued") {
        throw new GenerationStateError(
          generationId,
          `Generation ${generationId} cannot start attempt ${attemptId} from ${generation.status}.`,
        );
      }

      const [attempt] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET status = 'running', started_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${generationId} AND id = ${attemptId} AND status = 'queued'
        RETURNING *
      `;
      if (!attempt) {
        throw new GenerationStateError(generationId, `Attempt ${attemptId} is not queued.`);
      }
      await sql`
        UPDATE viby.generations SET
          status = 'running', started_at = COALESCE(started_at, now()),
          completed_at = NULL, error = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attemptId},
          'attempt.started', ${sql.json({ number: attempt.number, reason: attempt.reason })}
        )
      `;
      return attempt;
    });
    return mapAttempt(row);
  }

  async claimGenerationAttempt<Framework extends FrameworkId>(
    input: ClaimGenerationAttemptRecord<Framework>,
  ): Promise<GenerationWorkerLease | null> {
    await this.assertReady();
    const models = input.models ?? [{ provider: input.modelProvider, id: input.modelId }];
    if (models.length === 0) return null;
    const modelProviders = models.map((model) => model.provider);
    const modelIds = models.map((model) => model.id);
    return this.#sql.begin(async (sql) => {
      const candidates = input.attemptId
        ? await sql<GenerationAttemptClaimRow[]>`
            SELECT attempt.*, attempt.tenant_id, attempt.user_id
            FROM viby.generation_attempts AS attempt
            JOIN viby.generations AS generation ON generation.id = attempt.generation_id
            JOIN viby.chats AS chat ON chat.id = generation.chat_id
            WHERE attempt.id = ${input.attemptId}
              AND generation.active_attempt_id = attempt.id
              AND generation.status IN ('queued', 'running')
              AND attempt.status IN ('queued', 'running')
              AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= now())
              AND chat.framework = ${input.framework}
              AND (generation.model_provider, generation.model_id) IN (
                SELECT * FROM unnest(${modelProviders}::text[], ${modelIds}::text[])
              )
            FOR UPDATE OF attempt, generation SKIP LOCKED
            LIMIT 1
          `
        : await sql<GenerationAttemptClaimRow[]>`
            SELECT attempt.*, attempt.tenant_id, attempt.user_id
            FROM viby.generation_attempts AS attempt
            JOIN viby.generations AS generation ON generation.id = attempt.generation_id
            JOIN viby.chats AS chat ON chat.id = generation.chat_id
            WHERE generation.active_attempt_id = attempt.id
              AND generation.status IN ('queued', 'running')
              AND attempt.status IN ('queued', 'running')
              AND (attempt.lease_expires_at IS NULL OR attempt.lease_expires_at <= now())
              AND chat.framework = ${input.framework}
              AND (generation.model_provider, generation.model_id) IN (
                SELECT * FROM unnest(${modelProviders}::text[], ${modelIds}::text[])
              )
            ORDER BY attempt.created_at, attempt.id
            FOR UPDATE OF attempt, generation SKIP LOCKED
            LIMIT 1
          `;
      const candidate = candidates[0];
      if (!candidate) return null;
      const wasQueued = candidate.status === "queued";
      const [attempt] = await sql<GenerationAttemptClaimRow[]>`
        UPDATE viby.generation_attempts SET
          status = 'running', started_at = COALESCE(started_at, now()),
          worker_id = ${input.workerId}, lease_token = ${input.leaseToken},
          heartbeat_at = now(),
          lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond')
        WHERE id = ${candidate.id}
        RETURNING *, tenant_id, user_id
      `;
      if (!attempt?.lease_expires_at) return null;
      await sql`
        UPDATE viby.generations SET
          status = 'running', started_at = COALESCE(started_at, now()),
          completed_at = NULL, error = NULL
        WHERE tenant_id = ${attempt.tenant_id} AND user_id = ${attempt.user_id}
          AND id = ${attempt.generation_id} AND active_attempt_id = ${attempt.id}
      `;
      if (wasQueued) {
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${attempt.tenant_id}, ${attempt.user_id}, ${attempt.generation_id}, ${attempt.id},
            'attempt.started', ${sql.json({ number: attempt.number, reason: attempt.reason })}
          )
        `;
      }
      return {
        workerId: input.workerId,
        leaseToken: input.leaseToken,
        scope: { tenantId: attempt.tenant_id, userId: attempt.user_id },
        generationId: attempt.generation_id,
        attemptId: attempt.id,
        expiresAt: attempt.lease_expires_at,
      };
    });
  }

  async heartbeatGenerationAttempt(
    lease: GenerationWorkerLease,
    leaseMs: number,
  ): Promise<Date | null> {
    await this.assertReady();
    const [row] = await this.#sql<{ lease_expires_at: Date }[]>`
      UPDATE viby.generation_attempts SET
        heartbeat_at = now(),
        lease_expires_at = now() + (${leaseMs} * interval '1 millisecond')
      WHERE tenant_id = ${lease.scope.tenantId} AND user_id = ${lease.scope.userId}
        AND generation_id = ${lease.generationId} AND id = ${lease.attemptId}
        AND worker_id = ${lease.workerId} AND lease_token = ${lease.leaseToken}
        AND status = 'running' AND lease_expires_at > now()
      RETURNING lease_expires_at
    `;
    return row?.lease_expires_at ?? null;
  }

  async createGenerationAttempt(
    scope: UserScope,
    input: CreateAttemptRecord,
  ): Promise<GenerationAttemptData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");

      const allowed =
        input.reason === "retry"
          ? generation.status === "failed" || generation.status === "cancelled"
          : generation.status === "failed" ||
            generation.status === "cancelled" ||
            generation.status === "queued" ||
            generation.status === "running";
      if (!allowed) {
        throw new GenerationStateError(
          generation.id,
          `Generation ${generation.id} cannot ${input.reason} from ${generation.status}.`,
        );
      }

      if (generation.status === "queued" || generation.status === "running") {
        const [interrupted] = await sql<GenerationAttemptRow[]>`
          UPDATE viby.generation_attempts SET status = 'interrupted', completed_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND generation_id = ${generation.id} AND id = ${generation.active_attempt_id}
            AND status IN ('queued', 'running')
            AND (lease_expires_at IS NULL OR lease_expires_at <= now())
          RETURNING *
        `;
        if (!interrupted) {
          throw new GenerationStateError(
            generation.id,
            `Generation ${generation.id} has an active worker lease.`,
          );
        }
        if (interrupted) {
          await sql`
            INSERT INTO viby.generation_events (
              tenant_id, user_id, generation_id, attempt_id, type, data
            ) VALUES (
              ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${interrupted.id},
              'attempt.interrupted', ${sql.json({ number: interrupted.number })}
            )
          `;
        }
      }

      const number = generation.attempt_count + 1;
      const [attempt] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status, model_provider, model_id
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${number},
          ${input.reason}, 'queued', ${generation.model_provider}, ${generation.model_id}
        )
        RETURNING *
      `;
      if (!attempt) throw new Error("Postgres did not return the created attempt.");

      await sql`
        UPDATE viby.generations SET
          status = 'queued', active_attempt_id = ${input.id}, attempt_count = ${number},
          input_tokens = NULL, output_tokens = NULL, total_tokens = NULL,
          finish_reason = NULL, error = NULL, completed_at = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generation.id}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${input.id},
          'attempt.queued', ${sql.json({ number, reason: input.reason })}
        )
      `;
      return attempt;
    });
    return mapAttempt(row);
  }

  async attachGenerationSkills(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    skills: readonly ResolvedSkill[],
  ): Promise<void> {
    await this.assertReady();
    await this.#sql.begin(async (sql) => {
      const [generation] = await sql<{ id: string }[]>`
        SELECT generation.id FROM viby.generations AS generation
        JOIN viby.generation_attempts AS attempt ON attempt.id = generation.active_attempt_id
        WHERE generation.tenant_id = ${scope.tenantId}
          AND generation.user_id = ${scope.userId} AND generation.id = ${generationId}
          AND generation.status = 'running' AND attempt.id = ${attemptId}
          AND attempt.status = 'running' AND attempt.lease_token = ${leaseToken}
          AND attempt.lease_expires_at > now()
        FOR UPDATE OF generation, attempt
      `;
      if (!generation) {
        throw new GenerationStateError(
          generationId,
          "The generation worker lease is no longer active.",
        );
      }

      for (const [position, skill] of skills.entries()) {
        const [snapshot] = await sql<{ id: string }[]>`
          INSERT INTO viby.skill_snapshots (
            id, tenant_id, user_id, source, locator, name, description, content_hash, files
          ) VALUES (
            ${createId()}, ${scope.tenantId}, ${scope.userId}, ${skill.source}, ${skill.locator},
            ${skill.name}, ${skill.description}, ${skill.contentHash},
            ${sql.json(JSON.parse(JSON.stringify(skill.files)))}
          )
          ON CONFLICT (tenant_id, user_id, content_hash)
          DO UPDATE SET locator = EXCLUDED.locator
          RETURNING id
        `;
        if (!snapshot) throw new Error("Postgres did not return the skill snapshot.");
        await sql`
          INSERT INTO viby.generation_skills (
            tenant_id, user_id, generation_id, skill_snapshot_id, category, position, activation
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${generationId}, ${snapshot.id}, ${skill.category},
            ${position}, ${skill.category === "core" ? "always" : "automatic"}
          )
          ON CONFLICT DO NOTHING
        `;
      }
      await sql`
        UPDATE viby.generations SET skills_resolved_at = COALESCE(skills_resolved_at, now())
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${generationId}
      `;
    });
  }

  async getGenerationSkills(
    scope: UserScope,
    generationId: string,
  ): Promise<ResolvedSkill[] | null> {
    await this.assertReady();
    const [generation] = await this.#sql<{ skills_resolved_at: Date | null }[]>`
      SELECT skills_resolved_at FROM viby.generations
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${generationId}
      LIMIT 1
    `;
    if (!generation) throw new NotFoundError("Generation");
    if (!generation.skills_resolved_at) return null;
    const rows = await this.#sql<SkillSnapshotRow[]>`
      SELECT snapshot.name, snapshot.description, link.category, snapshot.source,
        snapshot.locator, snapshot.content_hash, snapshot.files
      FROM viby.generation_skills AS link
      JOIN viby.skill_snapshots AS snapshot ON snapshot.id = link.skill_snapshot_id
      WHERE link.tenant_id = ${scope.tenantId} AND link.user_id = ${scope.userId}
        AND link.generation_id = ${generationId}
      ORDER BY link.position
    `;
    return rows.map((row) => ({
      name: row.name,
      description: row.description,
      category: row.category,
      source: row.source,
      locator: row.locator,
      contentHash: row.content_hash,
      files: row.files,
    }));
  }

  async appendGenerationEvent<Type extends GenerationEventType>(
    scope: UserScope,
    input: AppendGenerationEventRecord<Type>,
  ): Promise<void> {
    await this.assertReady();
    const rows = await this.#sql<{ cursor: string }[]>`
      INSERT INTO viby.generation_events (
        tenant_id, user_id, generation_id, attempt_id, type, data
      )
      SELECT ${scope.tenantId}, ${scope.userId}, generation.id, ${input.attemptId}, ${input.type},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.data)))}
      FROM viby.generations AS generation
      JOIN viby.generation_attempts AS attempt ON attempt.id = generation.active_attempt_id
      WHERE generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
        AND generation.id = ${input.generationId} AND generation.status = 'running'
        AND attempt.id = ${input.attemptId} AND attempt.status = 'running'
        AND attempt.lease_token = ${input.leaseToken} AND attempt.lease_expires_at > now()
      RETURNING cursor
    `;
    if (rows.length === 0) {
      throw new GenerationStateError(
        input.generationId,
        "The generation worker lease is no longer active.",
      );
    }
  }

  async createToolCall(scope: UserScope, input: CreateToolCallRecord): Promise<CreatedToolCall> {
    await this.assertReady();
    const providerCallId = normalizeToolCallText(input.providerCallId, "provider call id", 500);
    const name = normalizeToolCallText(input.name, "tool name", 200);
    const idempotencyKey =
      input.idempotencyKey === undefined
        ? null
        : normalizeToolCallText(input.idempotencyKey, "idempotency key", 500);
    if (input.effect === "external" && idempotencyKey === null) {
      throw new ConfigurationError(`External tool ${name} requires an idempotency key.`);
    }
    const argumentsValue = normalizeAndRedactToolPayload(input.arguments);

    return this.#sql.begin(async (sql) => {
      await assertActiveToolAttempt(sql, scope, input);
      const existing =
        input.effect === "external"
          ? await sql<ToolCallRow[]>`
            SELECT call.* FROM viby.tool_calls AS call
            WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
              AND call.name = ${name} AND call.idempotency_key = ${idempotencyKey}
            LIMIT 1
          `
          : await sql<ToolCallRow[]>`
            SELECT call.* FROM viby.tool_calls AS call
            WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
              AND call.generation_id = ${input.generationId}
              AND call.attempt_id = ${input.attemptId}
              AND call.provider_call_id = ${providerCallId}
            LIMIT 1
          `;
      if (existing[0]) return { toolCall: mapToolCall(existing[0]), created: false };

      const rows = await sql<ToolCallRow[]>`
        INSERT INTO viby.tool_calls (
          id, tenant_id, user_id, generation_id, attempt_id, provider_call_id,
          name, effect, arguments, status, idempotency_key
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.generationId},
          ${input.attemptId}, ${providerCallId}, ${name}, ${input.effect},
          ${sql.json(argumentsValue)}, 'pending', ${idempotencyKey}
        )
        ON CONFLICT DO NOTHING
        RETURNING *
      `;
      if (rows[0]) return { toolCall: mapToolCall(rows[0]), created: true };

      const [raced] =
        input.effect === "external"
          ? await sql<ToolCallRow[]>`
            SELECT call.* FROM viby.tool_calls AS call
            WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
              AND call.name = ${name} AND call.idempotency_key = ${idempotencyKey}
            LIMIT 1
          `
          : await sql<ToolCallRow[]>`
            SELECT call.* FROM viby.tool_calls AS call
            WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
              AND call.generation_id = ${input.generationId}
              AND call.attempt_id = ${input.attemptId}
              AND call.provider_call_id = ${providerCallId}
            LIMIT 1
          `;
      if (!raced) throw new Error("Postgres did not return the created tool call.");
      return { toolCall: mapToolCall(raced), created: false };
    });
  }

  async completeToolCall(scope: UserScope, input: CompleteToolCallRecord): Promise<ToolCallData> {
    return this.#settleToolCall(scope, input, "succeeded");
  }

  async failToolCall(scope: UserScope, input: FailToolCallRecord): Promise<ToolCallData> {
    return this.#settleToolCall(scope, input, "failed");
  }

  async #settleToolCall(
    scope: UserScope,
    input: CompleteToolCallRecord | FailToolCallRecord,
    status: "succeeded" | "failed",
  ): Promise<ToolCallData> {
    await this.assertReady();
    const result =
      status === "succeeded"
        ? normalizeAndRedactToolPayload((input as CompleteToolCallRecord).result)
        : null;
    const error =
      status === "failed"
        ? normalizeToolCallText((input as FailToolCallRecord).error, "tool error", 10_000)
        : null;
    const rows = await this.#sql<ToolCallRow[]>`
      UPDATE viby.tool_calls AS call SET
        status = ${status}, result = ${result === null ? null : this.#sql.json(result)},
        error = ${error}, completed_at = now()
      FROM viby.generations AS generation, viby.generation_attempts AS attempt
      WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
        AND call.id = ${input.id} AND call.generation_id = ${input.generationId}
        AND call.attempt_id = ${input.attemptId} AND call.status = 'pending'
        AND generation.id = call.generation_id
        AND generation.tenant_id = call.tenant_id AND generation.user_id = call.user_id
        AND generation.status = 'running' AND generation.active_attempt_id = attempt.id
        AND attempt.id = call.attempt_id AND attempt.status = 'running'
        AND attempt.lease_token = ${input.leaseToken} AND attempt.lease_expires_at > now()
      RETURNING call.*
    `;
    if (rows[0]) return mapToolCall(rows[0]);
    const [existing] = await this.#sql<ToolCallRow[]>`
      SELECT call.* FROM viby.tool_calls AS call
      WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
        AND call.id = ${input.id} AND call.generation_id = ${input.generationId}
        AND call.attempt_id = ${input.attemptId}
    `;
    if (!existing) throw new NotFoundError("Tool call");
    if (existing.status !== "pending") return mapToolCall(existing);
    throw new GenerationStateError(
      input.generationId,
      "The generation worker lease is no longer active.",
    );
  }

  async completeGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    input: CompleteGenerationRecord<Framework>,
  ): Promise<VersionData<Framework>> {
    await this.assertReady();
    const artifacts = await this.#storeGeneratedArtifacts(
      scope,
      input.generationId,
      input.artifacts ?? [],
    );
    let row: VersionRow;
    try {
      row = await this.#sql.begin(async (sql) => {
        const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
        if (!generation) throw new NotFoundError("Generation");
        if (generation.configuration?.operation === "inspect") {
          throw new GenerationStateError(
            input.generationId,
            "A read-only inspection cannot create a source version.",
          );
        }
        if (generation.status !== "running" || generation.active_attempt_id !== input.attemptId) {
          throw new GenerationStateError(
            input.generationId,
            `Generation ${input.generationId} cannot complete from ${generation.status}.`,
          );
        }

        const [attempt] = await sql<GenerationAttemptRow[]>`
        SELECT * FROM viby.generation_attempts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId} AND id = ${input.attemptId}
          AND lease_token = ${input.leaseToken} AND lease_expires_at > now()
        FOR UPDATE
      `;
        if (!attempt || attempt.status !== "running") {
          throw new GenerationStateError(
            input.generationId,
            `Attempt ${input.attemptId} is not running.`,
          );
        }
        await assertNoQueuedSteering(sql, scope, input.generationId);

        await sql`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${generation.chat_id}
        FOR UPDATE
      `;
        const [numberRow] = await sql<{ number: number }[]>`
        SELECT COALESCE(MAX(number), 0)::integer + 1 AS number
        FROM viby.versions
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${generation.chat_id}
      `;
        const versionId = createId();
        const [version] = await sql<VersionRow[]>`
        INSERT INTO viby.versions (
          id, tenant_id, user_id, chat_id, generation_id, parent_version_id,
          number, framework, title, summary
        ) VALUES (
          ${versionId}, ${scope.tenantId}, ${scope.userId}, ${generation.chat_id},
          ${input.generationId}, ${input.parentVersionId}, ${numberRow?.number ?? 1},
          ${input.framework}, ${input.title}, ${input.summary}
        )
        RETURNING *
      `;
        if (!version) throw new Error("Postgres did not return the created version.");

        await insertVersionEntries(
          sql,
          scope,
          versionId,
          input.files,
          input.projectArtifacts ?? [],
        );

        for (const [position, change] of (input.changes ?? []).entries()) {
          await sql`
          INSERT INTO viby.version_changes (
            tenant_id, user_id, version_id, position, change
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${versionId}, ${position},
            ${sql.json(JSON.parse(JSON.stringify(change)))}
          )
        `;
        }

        await insertGeneratedArtifacts(sql, scope, {
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: input.attemptId,
          versionId,
          artifacts,
        });

        await insertMessage(sql, scope, {
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: input.attemptId,
          role: "assistant",
          content: input.assistantMessage,
          finishReason: input.finishReason,
          parts: input.assistantParts,
        });
        await sql`
        UPDATE viby.generation_attempts SET
          status = 'succeeded', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          estimated_cost_micros = ${input.cost?.amountMicros ?? null},
          cost_currency = ${input.cost?.currency ?? null},
          finish_reason = ${input.finishReason}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.attemptId}
      `;
        await sql`
        UPDATE viby.generations SET
          status = 'succeeded', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          estimated_cost_micros = CASE
            WHEN ${input.cost?.amountMicros ?? null}::bigint IS NULL THEN estimated_cost_micros
            ELSE COALESCE(estimated_cost_micros, 0) + ${input.cost?.amountMicros ?? null}::bigint
          END,
          cost_currency = COALESCE(cost_currency, ${input.cost?.currency ?? null}),
          finish_reason = ${input.finishReason}, error = NULL, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
      `;
        await sql`
        UPDATE viby.chats SET title = ${input.title}, updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${generation.chat_id}
      `;
        await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'attempt.succeeded', ${sql.json({ number: attempt.number, versionId })}
        )
      `;
        await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'generation.succeeded', ${sql.json({ versionId })}
        )
      `;
        return version;
      });
    } catch (error) {
      await this.#cleanupGeneratedArtifacts(scope, artifacts);
      throw error;
    }
    return mapVersion<Framework>(row);
  }

  async completeGenerationResponse(
    scope: UserScope,
    input: CompleteGenerationResponseRecord,
  ): Promise<MessageData> {
    await this.assertReady();
    const artifacts = await this.#storeGeneratedArtifacts(
      scope,
      input.generationId,
      input.artifacts ?? [],
    );
    const messageId = createId();
    let chatId: string;
    try {
      chatId = await this.#sql.begin(async (sql) => {
        const [generation] = await sql<GenerationRow[]>`
          SELECT * FROM viby.generations
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND id = ${input.generationId}
          FOR UPDATE
        `;
        if (!generation) throw new NotFoundError("Generation");
        if (generation.configuration?.operation !== "inspect") {
          throw new GenerationStateError(
            input.generationId,
            "Only a read-only inspection can complete without a source version.",
          );
        }
        if (generation.status !== "running" || generation.active_attempt_id !== input.attemptId) {
          throw new GenerationStateError(
            input.generationId,
            `Generation ${input.generationId} cannot complete from ${generation.status}.`,
          );
        }
        const [attempt] = await sql<GenerationAttemptRow[]>`
          SELECT * FROM viby.generation_attempts
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND generation_id = ${input.generationId} AND id = ${input.attemptId}
            AND lease_token = ${input.leaseToken} AND lease_expires_at > now()
          FOR UPDATE
        `;
        if (!attempt || attempt.status !== "running") {
          throw new GenerationStateError(input.generationId, `Attempt ${input.attemptId} is not running.`);
        }
        await assertNoQueuedSteering(sql, scope, input.generationId);
        await insertGeneratedArtifacts(sql, scope, {
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: input.attemptId,
          versionId: null,
          artifacts,
        });
        await insertMessage(sql, scope, {
          id: messageId,
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: input.attemptId,
          role: "assistant",
          content: input.assistantMessage,
          finishReason: input.finishReason,
          parts: input.assistantParts,
        });
        await sql`
          UPDATE viby.generation_attempts SET
            status = 'succeeded', input_tokens = ${input.inputTokens},
            output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
            estimated_cost_micros = ${input.cost?.amountMicros ?? null},
            cost_currency = ${input.cost?.currency ?? null},
            finish_reason = ${input.finishReason}, completed_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.attemptId}
        `;
        await sql`
          UPDATE viby.generations SET
            status = 'succeeded', input_tokens = ${input.inputTokens},
            output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
            estimated_cost_micros = CASE
              WHEN ${input.cost?.amountMicros ?? null}::bigint IS NULL THEN estimated_cost_micros
              ELSE COALESCE(estimated_cost_micros, 0) + ${input.cost?.amountMicros ?? null}::bigint
            END,
            cost_currency = COALESCE(cost_currency, ${input.cost?.currency ?? null}),
            finish_reason = ${input.finishReason}, error = NULL, completed_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
        `;
        await sql`
          UPDATE viby.chats SET updated_at = now()
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND id = ${generation.chat_id}
        `;
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
            'attempt.succeeded', ${sql.json({
              number: attempt.number,
              versionId: null,
              responseMessageId: messageId,
            })}
          )
        `;
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
            'generation.succeeded', ${sql.json({ versionId: null, responseMessageId: messageId })}
          )
        `;
        return generation.chat_id;
      });
    } catch (error) {
      await this.#cleanupGeneratedArtifacts(scope, artifacts);
      throw error;
    }
    const message = await this.getMessage(scope, chatId, messageId);
    if (!message) throw new NotFoundError("Inspection response");
    return message;
  }

  async pauseGeneration(
    scope: UserScope,
    input: PauseGenerationRecord,
  ): Promise<GenerationTaskData> {
    await this.assertReady();
    const artifacts = await this.#storeGeneratedArtifacts(
      scope,
      input.generationId,
      input.artifacts ?? [],
    );
    let row: GenerationTaskRow;
    try {
      row = await this.#sql.begin(async (sql) => {
        const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
        if (!generation) throw new NotFoundError("Generation");
        if (generation.status !== "running" || generation.active_attempt_id !== input.attemptId) {
          throw new GenerationStateError(
            generation.id,
            `Generation ${generation.id} cannot wait for a task from ${generation.status}.`,
          );
        }
        const [attempt] = await sql<GenerationAttemptRow[]>`
        SELECT * FROM viby.generation_attempts
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.attemptId} AND generation_id = ${input.generationId}
          AND lease_token = ${input.leaseToken} AND lease_expires_at > now()
        FOR UPDATE
      `;
        if (!attempt || attempt.status !== "running") {
          throw new GenerationStateError(
            generation.id,
            `Attempt ${input.attemptId} is not running.`,
          );
        }
        await assertNoQueuedSteering(sql, scope, input.generationId);

        const [task] = await sql<GenerationTaskRow[]>`
        INSERT INTO viby.generation_tasks (
          id, tenant_id, user_id, generation_id, attempt_id, kind, title, message, payload
        ) VALUES (
          ${input.taskId}, ${scope.tenantId}, ${scope.userId}, ${input.generationId},
          ${input.attemptId}, ${input.task.kind}, ${input.task.title}, ${input.task.message},
          ${sql.json(JSON.parse(JSON.stringify(input.task)))}
        )
        RETURNING id, generation_id, attempt_id, status, payload, resolution, created_at, resolved_at
      `;
        if (!task) throw new Error("Postgres did not return the created task.");

        await insertGeneratedArtifacts(sql, scope, {
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: input.attemptId,
          versionId: null,
          artifacts,
        });

        await insertMessage(sql, scope, {
          chatId: generation.chat_id,
          generationId: input.generationId,
          attemptId: input.attemptId,
          role: "assistant",
          content: input.task.message,
          finishReason: input.finishReason,
          parts: input.assistantParts,
        });
        await sql`
        UPDATE viby.generation_attempts SET
          status = 'waiting', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          estimated_cost_micros = ${input.cost?.amountMicros ?? null},
          cost_currency = ${input.cost?.currency ?? null},
          finish_reason = ${input.finishReason}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.attemptId}
      `;
        await sql`
        UPDATE viby.generations SET
          status = 'waiting', input_tokens = ${input.inputTokens},
          output_tokens = ${input.outputTokens}, total_tokens = ${input.totalTokens},
          estimated_cost_micros = CASE
            WHEN ${input.cost?.amountMicros ?? null}::bigint IS NULL THEN estimated_cost_micros
            ELSE COALESCE(estimated_cost_micros, 0) + ${input.cost?.amountMicros ?? null}::bigint
          END,
          cost_currency = COALESCE(cost_currency, ${input.cost?.currency ?? null}),
          finish_reason = ${input.finishReason}, error = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.generationId}
      `;
        await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'attempt.waiting', ${sql.json({ taskId: input.taskId })}
        )
      `;
        await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
          'task.created', ${sql.json(
            JSON.parse(
              JSON.stringify({
                task: { id: input.taskId, ...input.task },
              }),
            ),
          )}
        )
      `;
        return task;
      });
    } catch (error) {
      await this.#cleanupGeneratedArtifacts(scope, artifacts);
      throw error;
    }
    return mapTask(row);
  }

  async resolveGenerationTask(
    scope: UserScope,
    input: ResolveGenerationTaskRecord,
  ): Promise<GenerationAttemptData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.status !== "waiting") {
        throw new GenerationStateError(
          generation.id,
          `Generation ${generation.id} cannot resolve a task from ${generation.status}.`,
        );
      }

      const [task] = await sql<GenerationTaskRow[]>`
        SELECT id, generation_id, attempt_id, status, payload, resolution, created_at, resolved_at
        FROM viby.generation_tasks
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId} AND id = ${input.taskId}
        FOR UPDATE
      `;
      if (!task) throw new NotFoundError("Generation task");
      if (task.status !== "pending") {
        throw new GenerationStateError(generation.id, `Task ${input.taskId} is already resolved.`);
      }

      await sql`
        UPDATE viby.generation_tasks SET
          status = 'resolved', resolution = ${sql.json(JSON.parse(JSON.stringify(input.resolution)))},
          resolved_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${input.taskId}
      `;
      const number = generation.attempt_count + 1;
      const [attempt] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status, model_provider, model_id
        ) VALUES (
          ${input.attemptId}, ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${number},
          'task_resolution', 'queued', ${generation.model_provider}, ${generation.model_id}
        )
        RETURNING *
      `;
      if (!attempt) throw new Error("Postgres did not return the created attempt.");

      await insertMessage(sql, scope, {
        chatId: generation.chat_id,
        generationId: input.generationId,
        attemptId: input.attemptId,
        role: "user",
        content: input.resolutionMessage,
        parts: [{ type: "text", data: { text: input.resolutionMessage } }],
      });

      await sql`
        UPDATE viby.generations SET
          status = 'queued', active_attempt_id = ${input.attemptId}, attempt_count = ${number},
          input_tokens = NULL, output_tokens = NULL, total_tokens = NULL,
          finish_reason = NULL, error = NULL, completed_at = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generation.id}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${task.attempt_id},
          'task.resolved', ${sql.json(
            JSON.parse(
              JSON.stringify({
                taskId: input.taskId,
                resolution: input.resolution,
              }),
            ),
          )}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generation.id}, ${input.attemptId},
          'attempt.queued', ${sql.json({ number, reason: "task_resolution" })}
        )
      `;
      return attempt;
    });
    return mapAttempt(row);
  }

  async failGenerationAttempt(
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    error: string,
  ): Promise<void> {
    await this.assertReady();
    const message = error.slice(0, 10_000);
    await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.active_attempt_id !== attemptId || generation.status !== "running") return;

      const [attempt] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET
          status = 'failed', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${generationId} AND id = ${attemptId} AND status = 'running'
          AND lease_token = ${leaseToken} AND lease_expires_at > now()
        RETURNING *
      `;
      if (!attempt) return;
      await sql`
        UPDATE viby.generations SET status = 'failed', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attemptId},
          'attempt.failed', ${sql.json({ number: attempt.number, error: message })}
        )
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attemptId},
          'generation.failed', ${sql.json({ error: message })}
        )
      `;
    });
  }

  async repairGenerationAttempt(
    scope: UserScope,
    input: RepairGenerationAttemptRecord,
  ): Promise<GenerationAttemptData | null> {
    await this.assertReady();
    const message = input.error.slice(0, 10_000);
    const row = await this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (generation.active_attempt_id !== input.attemptId || generation.status !== "running")
        return null;

      const [failed] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET
          status = 'failed', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId} AND id = ${input.attemptId}
          AND status = 'running' AND lease_token = ${input.leaseToken}
          AND lease_expires_at > now()
        RETURNING *
      `;
      if (!failed) return null;

      const number = generation.attempt_count + 1;
      const [repair] = await sql<GenerationAttemptRow[]>`
        INSERT INTO viby.generation_attempts (
          id, tenant_id, user_id, generation_id, number, reason, status,
          model_provider, model_id
        ) VALUES (
          ${input.repairAttemptId}, ${scope.tenantId}, ${scope.userId},
          ${input.generationId}, ${number}, 'retry', 'queued',
          ${generation.model_provider}, ${generation.model_id}
        )
        RETURNING *
      `;
      if (!repair) throw new Error("Postgres did not return the repair attempt.");

      await sql`
        UPDATE viby.generations SET
          status = 'queued', active_attempt_id = ${repair.id}, attempt_count = ${number},
          input_tokens = NULL, output_tokens = NULL, total_tokens = NULL,
          finish_reason = NULL, error = NULL, completed_at = NULL
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.generationId}
      `;
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES
          (
            ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${failed.id},
            'attempt.failed', ${sql.json({ number: failed.number, error: message })}
          ),
          (
            ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${repair.id},
            'attempt.queued', ${sql.json({ number, reason: "retry" })}
          )
      `;
      return repair;
    });
    return row ? mapAttempt(row) : null;
  }

  async cancelGeneration(scope: UserScope, generationId: string, reason: string): Promise<boolean> {
    await this.assertReady();
    return this.#sql.begin(async (sql) => {
      const [generation] = await sql<GenerationRow[]>`
        SELECT * FROM viby.generations
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
        FOR UPDATE
      `;
      if (!generation) throw new NotFoundError("Generation");
      if (
        generation.status === "succeeded" ||
        generation.status === "failed" ||
        generation.status === "cancelled"
      ) {
        return false;
      }

      const message = reason.slice(0, 2_000);
      const [attempt] = await sql<GenerationAttemptRow[]>`
        UPDATE viby.generation_attempts SET
          status = 'cancelled', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${generationId} AND id = ${generation.active_attempt_id}
          AND status IN ('queued', 'running', 'waiting')
        RETURNING *
      `;
      await sql`
        UPDATE viby.generations SET status = 'cancelled', error = ${message}, completed_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${generationId}
      `;
      if (attempt) {
        await sql`
          INSERT INTO viby.generation_events (
            tenant_id, user_id, generation_id, attempt_id, type, data
          ) VALUES (
            ${scope.tenantId}, ${scope.userId}, ${generationId}, ${attempt.id},
            'attempt.cancelled', ${sql.json({ number: attempt.number, reason: message })}
          )
        `;
      }
      await sql`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, attempt_id, type, data
        ) VALUES (
          ${scope.tenantId}, ${scope.userId}, ${generationId}, ${generation.active_attempt_id},
          'generation.cancelled', ${sql.json({ reason: message })}
        )
      `;
      return true;
    });
  }

  async getGeneration(scope: UserScope, id: string): Promise<GenerationData | null> {
    await this.assertReady();
    const [row] = await this.#sql<GenerationRow[]>`
      SELECT * FROM viby.generations
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapGeneration(row) : null;
  }

  async readGenerationSnapshot<Framework extends FrameworkId>(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationReadSnapshot<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<GenerationSnapshotRow[]>`
      WITH selected_generation AS (
        SELECT generation.*
        FROM viby.generations AS generation
        JOIN viby.chats AS chat
          ON chat.id = generation.chat_id
          AND chat.tenant_id = generation.tenant_id
          AND chat.user_id = generation.user_id
        WHERE generation.tenant_id = ${scope.tenantId}
          AND generation.user_id = ${scope.userId}
          AND generation.id = ${generationId}
          AND chat.deleted_at IS NULL
        LIMIT 1
      )
      SELECT
        to_jsonb(generation) AS generation,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(attempt) ORDER BY attempt.number)
          FROM viby.generation_attempts AS attempt
          WHERE attempt.tenant_id = ${scope.tenantId}
            AND attempt.user_id = ${scope.userId}
            AND attempt.generation_id = generation.id
        ), '[]'::jsonb) AS attempts,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(task) ORDER BY task.created_at, task.id)
          FROM viby.generation_tasks AS task
          WHERE task.tenant_id = ${scope.tenantId}
            AND task.user_id = ${scope.userId}
            AND task.generation_id = generation.id
        ), '[]'::jsonb) AS tasks,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(item) ORDER BY item.created_at, item.id)
          FROM viby.generation_steering AS item
          WHERE item.tenant_id = ${scope.tenantId}
            AND item.user_id = ${scope.userId}
            AND item.generation_id = generation.id
        ), '[]'::jsonb) AS steering,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(call) ORDER BY call.created_at, call.id)
          FROM viby.tool_calls AS call
          WHERE call.tenant_id = ${scope.tenantId}
            AND call.user_id = ${scope.userId}
            AND call.generation_id = generation.id
        ), '[]'::jsonb) AS tool_calls,
        COALESCE((
          SELECT jsonb_agg(to_jsonb(artifact)
            ORDER BY artifact.created_at, artifact.attempt_id, artifact.position, artifact.id)
          FROM viby.generated_artifacts AS artifact
          WHERE artifact.tenant_id = ${scope.tenantId}
            AND artifact.user_id = ${scope.userId}
            AND artifact.generation_id = generation.id
        ), '[]'::jsonb) AS artifacts,
        (
          SELECT to_jsonb(version)
          FROM viby.versions AS version
          WHERE version.tenant_id = ${scope.tenantId}
            AND version.user_id = ${scope.userId}
            AND version.generation_id = generation.id
          LIMIT 1
        ) AS version
      FROM selected_generation AS generation
    `;
    if (!row) return null;
    return {
      generation: mapGeneration(hydrateGenerationRow(row.generation)),
      attempts: row.attempts.map((attempt) => mapAttempt(hydrateAttemptRow(attempt))),
      tasks: row.tasks.map((task) => mapTask(hydrateTaskRow(task))),
      steering: row.steering.map((item) => mapGenerationSteering(hydrateSteeringRow(item))),
      toolCalls: row.tool_calls.map((call) => mapToolCall(hydrateToolCallRow(call))),
      artifacts: row.artifacts.map((artifact) => mapGeneratedArtifact(withCreatedAt(artifact))),
      version: row.version ? mapVersion<Framework>(withCreatedAt(row.version)) : null,
    };
  }

  async listGenerationAttempts(
    scope: UserScope,
    generationId: string,
  ): Promise<GenerationAttemptData[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationAttemptRow[]>`
      SELECT attempt.* FROM viby.generation_attempts AS attempt
      JOIN viby.generations AS generation ON generation.id = attempt.generation_id
      WHERE attempt.tenant_id = ${scope.tenantId} AND attempt.user_id = ${scope.userId}
        AND attempt.generation_id = ${generationId}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY attempt.number
    `;
    return rows.map(mapAttempt);
  }

  async listGenerationEvents(
    scope: UserScope,
    generationId: string,
    after: string,
    limit: number,
  ): Promise<GenerationEvent[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationEventRow[]>`
      SELECT event.cursor, event.generation_id, event.attempt_id, event.type, event.data,
        event.created_at
      FROM viby.generation_events AS event
      JOIN viby.generations AS generation ON generation.id = event.generation_id
      WHERE event.tenant_id = ${scope.tenantId} AND event.user_id = ${scope.userId}
        AND event.generation_id = ${generationId} AND event.cursor > ${after}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY event.cursor
      LIMIT ${limit}
    `;
    return rows.map(mapEvent);
  }

  async claimOutboundEventDelivery(
    scope: UserScope,
    input: ClaimOutboundEventDeliveryRecord,
  ): Promise<OutboundEventDeliveryClaim | null> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      await sql`
        INSERT INTO viby.outbound_event_deliveries (
          tenant_id, user_id, generation_id, event_cursor, sink_id, max_attempts
        )
        SELECT
          event.tenant_id, event.user_id, event.generation_id, event.cursor,
          ${input.sinkId}, ${input.maxAttempts}
        FROM viby.generation_events AS event
        WHERE event.tenant_id = ${scope.tenantId} AND event.user_id = ${scope.userId}
          AND event.generation_id = ${input.generationId}
          AND event.cursor = ${input.eventCursor}::bigint
        ON CONFLICT (generation_id, event_cursor, sink_id) DO NOTHING
      `;
      const [claimed] = await sql<OutboundEventDeliveryRow[]>`
        UPDATE viby.outbound_event_deliveries SET
          status = 'delivering', attempt_count = attempt_count + 1,
          lease_token = ${input.leaseToken},
          lease_expires_at = now() + (${input.leaseMs} * interval '1 millisecond'),
          updated_at = now()
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND generation_id = ${input.generationId}
          AND event_cursor = ${input.eventCursor}::bigint AND sink_id = ${input.sinkId}
          AND attempt_count < max_attempts
          AND (
            (status = 'pending' AND next_attempt_at <= now())
            OR (status = 'delivering' AND lease_expires_at <= now())
          )
        RETURNING *
      `;
      return claimed ?? null;
    });
    return row ? { delivery: mapOutboundEventDelivery(row), leaseToken: input.leaseToken } : null;
  }

  async getOutboundEventDelivery(
    scope: UserScope,
    generationId: string,
    eventCursor: string,
    sinkId: string,
  ): Promise<OutboundEventDeliveryData | null> {
    await this.assertReady();
    const [row] = await this.#sql<OutboundEventDeliveryRow[]>`
      SELECT * FROM viby.outbound_event_deliveries
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId} AND event_cursor = ${eventCursor}::bigint
        AND sink_id = ${sinkId}
    `;
    return row ? mapOutboundEventDelivery(row) : null;
  }

  async completeOutboundEventDelivery(
    scope: UserScope,
    claim: OutboundEventDeliveryClaim,
    deliveredAt: Date,
  ): Promise<OutboundEventDeliveryData> {
    await this.assertReady();
    const [row] = await this.#sql<OutboundEventDeliveryRow[]>`
      UPDATE viby.outbound_event_deliveries SET
        status = 'delivered', delivered_at = ${deliveredAt}, last_error = NULL,
        lease_token = NULL, lease_expires_at = NULL, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${claim.delivery.generationId}
        AND event_cursor = ${claim.delivery.eventCursor}::bigint
        AND sink_id = ${claim.delivery.sinkId} AND status = 'delivering'
        AND lease_token = ${claim.leaseToken}
      RETURNING *
    `;
    if (!row)
      throw new GenerationStateError(
        claim.delivery.generationId,
        "Outbound event delivery lease is no longer active.",
      );
    return mapOutboundEventDelivery(row);
  }

  async failOutboundEventDelivery(
    scope: UserScope,
    input: FailOutboundEventDeliveryRecord,
  ): Promise<OutboundEventDeliveryData> {
    await this.assertReady();
    const [row] = await this.#sql<OutboundEventDeliveryRow[]>`
      UPDATE viby.outbound_event_deliveries SET
        status = CASE WHEN attempt_count >= max_attempts THEN 'dead_lettered' ELSE 'pending' END,
        next_attempt_at = now() + (${input.retryDelayMs} * interval '1 millisecond'),
        last_error = ${input.error}, lease_token = NULL, lease_expires_at = NULL,
        dead_lettered_at = CASE WHEN attempt_count >= max_attempts THEN now() ELSE NULL END,
        updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${input.generationId}
        AND event_cursor = ${input.eventCursor}::bigint AND sink_id = ${input.sinkId}
        AND status = 'delivering' AND lease_token = ${input.leaseToken}
      RETURNING *
    `;
    if (!row)
      throw new GenerationStateError(
        input.generationId,
        "Outbound event delivery lease is no longer active.",
      );
    return mapOutboundEventDelivery(row);
  }

  async listOutboundEventDeliveries(
    scope: UserScope,
    generationId: string,
    sinkId: string,
    status?: OutboundEventDeliveryStatus,
  ): Promise<OutboundEventDeliveryData[]> {
    await this.assertReady();
    const rows = await this.#sql<OutboundEventDeliveryRow[]>`
      SELECT delivery.* FROM viby.outbound_event_deliveries AS delivery
      JOIN viby.generations AS generation ON generation.id = delivery.generation_id
      WHERE delivery.tenant_id = ${scope.tenantId} AND delivery.user_id = ${scope.userId}
        AND delivery.generation_id = ${generationId} AND delivery.sink_id = ${sinkId}
        AND generation.tenant_id = delivery.tenant_id AND generation.user_id = delivery.user_id
        AND (${status ?? null}::text IS NULL OR delivery.status = ${status ?? null})
      ORDER BY delivery.event_cursor
    `;
    return rows.map(mapOutboundEventDelivery);
  }

  async redriveOutboundEventDelivery(
    scope: UserScope,
    generationId: string,
    eventCursor: string,
    sinkId: string,
  ): Promise<OutboundEventDeliveryData> {
    await this.assertReady();
    const [row] = await this.#sql<OutboundEventDeliveryRow[]>`
      UPDATE viby.outbound_event_deliveries SET
        status = 'pending', attempt_count = 0, next_attempt_at = now(),
        last_error = NULL, dead_lettered_at = NULL, lease_token = NULL,
        lease_expires_at = NULL, updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId} AND event_cursor = ${eventCursor}::bigint
        AND sink_id = ${sinkId} AND status = 'dead_lettered'
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Dead-lettered outbound event delivery");
    return mapOutboundEventDelivery(row);
  }

  async listToolCalls(scope: UserScope, generationId: string): Promise<ToolCallData[]> {
    await this.assertReady();
    const rows = await this.#sql<ToolCallRow[]>`
      SELECT call.* FROM viby.tool_calls AS call
      JOIN viby.generations AS generation ON generation.id = call.generation_id
      WHERE call.tenant_id = ${scope.tenantId} AND call.user_id = ${scope.userId}
        AND call.generation_id = ${generationId}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY call.created_at, call.id
    `;
    return rows.map(mapToolCall);
  }

  async listGenerationTasks(scope: UserScope, generationId: string): Promise<GenerationTaskData[]> {
    await this.assertReady();
    const rows = await this.#sql<GenerationTaskRow[]>`
      SELECT task.id, task.generation_id, task.attempt_id, task.status, task.payload,
        task.resolution, task.created_at, task.resolved_at
      FROM viby.generation_tasks AS task
      JOIN viby.generations AS generation ON generation.id = task.generation_id
      WHERE task.tenant_id = ${scope.tenantId} AND task.user_id = ${scope.userId}
        AND task.generation_id = ${generationId}
        AND generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      ORDER BY task.created_at, task.id
    `;
    return rows.map(mapTask);
  }

  async getVersionByGeneration<Framework extends FrameworkId>(
    scope: UserScope,
    generationId: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId}
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async getVersion<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async getVersionForChat<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
    id: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT version.*
      FROM viby.versions AS version
      JOIN viby.chats AS chat
        ON chat.id = version.chat_id
        AND chat.tenant_id = version.tenant_id
        AND chat.user_id = version.user_id
      WHERE version.tenant_id = ${scope.tenantId}
        AND version.user_id = ${scope.userId}
        AND version.chat_id = ${chatId}
        AND version.id = ${id}
        AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async getLatestVersion<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<VersionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      ORDER BY number DESC
      LIMIT 1
    `;
    return row ? mapVersion<Framework>(row) : null;
  }

  async listVersions<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
  ): Promise<Array<VersionData<Framework>>> {
    await this.assertReady();
    const rows = await this.#sql<VersionRow[]>`
      SELECT * FROM viby.versions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      ORDER BY number DESC
    `;
    return rows.map(mapVersion<Framework>);
  }

  async listVersionPage<Framework extends FrameworkId>(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: VersionPageCursor | null,
  ): Promise<RepositoryPage<VersionData<Framework>>> {
    await this.assertReady();
    const rows = after
      ? await this.#sql<VersionRow[]>`
          SELECT * FROM viby.versions
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND chat_id = ${chatId} AND number < ${after.number}
          ORDER BY number DESC
          LIMIT ${limit + 1}
        `
      : await this.#sql<VersionRow[]>`
          SELECT * FROM viby.versions
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND chat_id = ${chatId}
          ORDER BY number DESC
          LIMIT ${limit + 1}
        `;
    return createPage(rows.map(mapVersion<Framework>), limit);
  }

  async createDesignEvaluation(
    scope: UserScope,
    input: CreateDesignEvaluationRecord,
  ): Promise<DesignEvaluationData> {
    await this.assertReady();
    const [row] = await this.#sql<DesignEvaluationRow[]>`
      INSERT INTO viby.design_evaluations (
        id, tenant_id, user_id, chat_id, version_id, generation_id,
        evaluator, status, score, summary, criteria, evidence, metadata
      )
      SELECT ${input.id}, ${scope.tenantId}, ${scope.userId}, version.chat_id,
        version.id, version.generation_id, ${input.evaluator}, ${input.status},
        ${input.score}, ${input.summary},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.criteria)))},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.evidence)))},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.metadata)))}
      FROM viby.versions AS version
      JOIN viby.chats AS chat ON chat.id = version.chat_id
      WHERE version.tenant_id = ${scope.tenantId} AND version.user_id = ${scope.userId}
        AND version.id = ${input.versionId} AND version.chat_id = ${input.chatId}
        AND chat.deleted_at IS NULL
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Version");
    return mapDesignEvaluation(row);
  }

  async getDesignEvaluation(
    scope: UserScope,
    versionId: string,
    id: string,
  ): Promise<DesignEvaluationData | null> {
    await this.assertReady();
    const [row] = await this.#sql<DesignEvaluationRow[]>`
      SELECT evaluation.*
      FROM viby.design_evaluations AS evaluation
      JOIN viby.chats AS chat ON chat.id = evaluation.chat_id
      WHERE evaluation.tenant_id = ${scope.tenantId}
        AND evaluation.user_id = ${scope.userId}
        AND evaluation.version_id = ${versionId} AND evaluation.id = ${id}
        AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    return row ? mapDesignEvaluation(row) : null;
  }

  async listDesignEvaluationPage(
    scope: UserScope,
    versionId: string,
    limit: number,
    after: DesignEvaluationPageCursor | null,
  ): Promise<RepositoryPage<DesignEvaluationData>> {
    await this.assertReady();
    const rows = after
      ? await this.#sql<DesignEvaluationRow[]>`
          SELECT evaluation.*
          FROM viby.design_evaluations AS evaluation
          JOIN viby.chats AS chat ON chat.id = evaluation.chat_id
          WHERE evaluation.tenant_id = ${scope.tenantId}
            AND evaluation.user_id = ${scope.userId}
            AND evaluation.version_id = ${versionId} AND chat.deleted_at IS NULL
            AND (
              date_trunc('milliseconds', evaluation.created_at) < ${after.createdAt}
              OR (
                date_trunc('milliseconds', evaluation.created_at) = ${after.createdAt}
                AND evaluation.id < ${after.id}
              )
            )
          ORDER BY date_trunc('milliseconds', evaluation.created_at) DESC, evaluation.id DESC
          LIMIT ${limit + 1}
        `
      : await this.#sql<DesignEvaluationRow[]>`
          SELECT evaluation.*
          FROM viby.design_evaluations AS evaluation
          JOIN viby.chats AS chat ON chat.id = evaluation.chat_id
          WHERE evaluation.tenant_id = ${scope.tenantId}
            AND evaluation.user_id = ${scope.userId}
            AND evaluation.version_id = ${versionId} AND chat.deleted_at IS NULL
          ORDER BY date_trunc('milliseconds', evaluation.created_at) DESC, evaluation.id DESC
          LIMIT ${limit + 1}
        `;
    return createPage(rows.map(mapDesignEvaluation), limit);
  }

  async listMessages(scope: UserScope, chatId: string): Promise<MessageData[]> {
    await this.assertReady();
    const rows = await this.#sql<MessageRow[]>`
      SELECT id, chat_id, generation_id, role, content, finish_reason, created_at
      FROM viby.messages
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      ORDER BY created_at, id
    `;
    return this.#messagesWithParts(scope, rows);
  }

  async getMessage(scope: UserScope, chatId: string, id: string): Promise<MessageData | null> {
    await this.assertReady();
    const rows = await this.#sql<MessageRow[]>`
      SELECT id, chat_id, generation_id, role, content, finish_reason, created_at
      FROM viby.messages
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND chat_id = ${chatId} AND id = ${id}
      LIMIT 1
    `;
    return (await this.#messagesWithParts(scope, rows))[0] ?? null;
  }

  async createMessageFeedback(
    scope: UserScope,
    input: CreateMessageFeedbackRecord,
  ): Promise<MessageFeedbackData> {
    await this.assertReady();
    const [context] = await this.#sql<MessageFeedbackContextRow[]>`
      SELECT message.generation_id, part.attempt_id, version.id AS version_id,
        attempt.model_provider, attempt.model_id
      FROM viby.messages AS message
      JOIN viby.chats AS chat ON chat.id = message.chat_id
      JOIN LATERAL (
        SELECT candidate.attempt_id
        FROM viby.message_parts AS candidate
        WHERE candidate.tenant_id = message.tenant_id
          AND candidate.user_id = message.user_id
          AND candidate.message_id = message.id
          AND candidate.attempt_id IS NOT NULL
        ORDER BY candidate.position
        LIMIT 1
      ) AS part ON true
      JOIN viby.generation_attempts AS attempt ON attempt.id = part.attempt_id
      LEFT JOIN viby.versions AS version ON version.generation_id = message.generation_id
      WHERE message.tenant_id = ${scope.tenantId} AND message.user_id = ${scope.userId}
        AND message.chat_id = ${input.chatId} AND message.id = ${input.messageId}
        AND message.role = 'assistant' AND message.generation_id IS NOT NULL
        AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    if (!context) throw new NotFoundError("Assistant message");

    const inserted = await this.#sql<MessageFeedbackRow[]>`
      INSERT INTO viby.message_feedback (
        id, tenant_id, user_id, chat_id, message_id, generation_id, attempt_id,
        version_id, model_provider, model_id, rating, reasons, comment, metadata,
        idempotency_key
      ) VALUES (
        ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.chatId}, ${input.messageId},
        ${context.generation_id}, ${context.attempt_id}, ${context.version_id},
        ${context.model_provider}, ${context.model_id}, ${input.rating},
        ${this.#sql.json([...input.reasons])}, ${input.comment},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.metadata)))}, ${input.idempotencyKey}
      )
      ON CONFLICT (tenant_id, user_id, message_id, idempotency_key) DO NOTHING
      RETURNING id, chat_id, message_id, generation_id, attempt_id, version_id,
        model_provider, model_id, rating, reasons, comment, metadata, idempotency_key, created_at
    `;
    if (inserted[0]) return mapMessageFeedback(inserted[0]);

    const [existing] = await this.#sql<MessageFeedbackRow[]>`
      SELECT id, chat_id, message_id, generation_id, attempt_id, version_id,
        model_provider, model_id, rating, reasons, comment, metadata, idempotency_key, created_at
      FROM viby.message_feedback
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND message_id = ${input.messageId} AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    if (!existing) throw new Error("Message feedback idempotency conflict could not be resolved.");
    if (
      existing.rating !== input.rating ||
      existing.comment !== input.comment ||
      JSON.stringify(existing.reasons) !== JSON.stringify(input.reasons) ||
      JSON.stringify(existing.metadata) !== JSON.stringify(input.metadata)
    ) {
      throw new ConfigurationError(
        "Message feedback idempotency key was already used with different input.",
      );
    }
    return mapMessageFeedback(existing);
  }

  async listMessageFeedback(
    scope: UserScope,
    chatId: string,
    messageId: string,
  ): Promise<MessageFeedbackData[]> {
    await this.assertReady();
    const rows = await this.#sql<MessageFeedbackRow[]>`
      SELECT feedback.id, feedback.chat_id, feedback.message_id, feedback.generation_id,
        feedback.attempt_id, feedback.version_id, feedback.model_provider, feedback.model_id,
        feedback.rating, feedback.reasons, feedback.comment, feedback.metadata,
        feedback.idempotency_key, feedback.created_at
      FROM viby.message_feedback AS feedback
      JOIN viby.chats AS chat ON chat.id = feedback.chat_id
      WHERE feedback.tenant_id = ${scope.tenantId} AND feedback.user_id = ${scope.userId}
        AND feedback.chat_id = ${chatId} AND feedback.message_id = ${messageId}
        AND chat.deleted_at IS NULL
      ORDER BY feedback.created_at, feedback.id
    `;
    return rows.map(mapMessageFeedback);
  }

  async getAttachment(
    scope: UserScope,
    chatId: string,
    id: string,
  ): Promise<AttachmentContent | null> {
    await this.assertReady();
    const [row] = await this.#sql<AttachmentRow[]>`
      SELECT id, chat_id, message_id, generation_id, filename, media_type,
        size, checksum, artifact_store, artifact_key, content, created_at
      FROM viby.attachments
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND chat_id = ${chatId} AND id = ${id}
      LIMIT 1
    `;
    return row ? this.#loadAttachmentContent(scope, row) : null;
  }

  async listGenerationAttachments(
    scope: UserScope,
    generationId: string,
  ): Promise<AttachmentContent[]> {
    await this.assertReady();
    const rows = await this.#sql<AttachmentRow[]>`
      SELECT id, chat_id, message_id, generation_id, filename, media_type,
        size, checksum, artifact_store, artifact_key, content, created_at
      FROM viby.attachments
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId}
      ORDER BY created_at, id
    `;
    return Promise.all(rows.map((row) => this.#loadAttachmentContent(scope, row)));
  }

  async listGeneratedArtifacts(
    scope: UserScope,
    generationId: string,
  ): Promise<GeneratedArtifactData[]> {
    await this.assertReady();
    const rows = await this.#sql<GeneratedArtifactRow[]>`
      SELECT id, chat_id, generation_id, attempt_id, version_id, position, kind, filename,
        media_type, size, checksum, artifact_store, artifact_key, created_at
      FROM viby.generated_artifacts
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId}
      ORDER BY created_at, attempt_id, position, id
    `;
    return rows.map(mapGeneratedArtifact);
  }

  async getGeneratedArtifact(
    scope: UserScope,
    generationId: string,
    id: string,
  ): Promise<GeneratedArtifactContent | null> {
    await this.assertReady();
    const [row] = await this.#sql<GeneratedArtifactRow[]>`
      SELECT id, chat_id, generation_id, attempt_id, version_id, position, kind, filename,
        media_type, size, checksum, artifact_store, artifact_key, created_at
      FROM viby.generated_artifacts
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${generationId} AND id = ${id}
      LIMIT 1
    `;
    if (!row) return null;
    if (!this.#artifactStore || this.#artifactStore.id !== row.artifact_store) {
      throw new ConfigurationError(
        `Artifact store ${row.artifact_store} is required to read generated artifact ${row.id}.`,
      );
    }
    const bytes = await this.#artifactStore.get(
      row.artifact_key,
      generatedArtifactContext(scope, row.id),
    );
    if (!bytes) throw new NotFoundError("Generated artifact content");
    if (bytes.byteLength !== row.size || sha256(bytes) !== row.checksum) {
      throw new Error(
        `Generated artifact ${row.id} failed its persisted size or checksum validation.`,
      );
    }
    return { ...mapGeneratedArtifact(row), bytes: Uint8Array.from(bytes) };
  }

  async createVisualArtifact(
    scope: UserScope,
    input: CreateVisualArtifactRecord,
  ): Promise<VisualArtifactData> {
    await this.assertReady();
    if (!this.#artifactStore) {
      throw new ConfigurationError(
        "artifactStore is required to persist visual evaluation captures.",
      );
    }
    const artifactKey = `visual/${input.versionId}/${input.id}-${input.checksum}`;
    await this.#artifactStore.put(
      {
        key: artifactKey,
        bytes: Uint8Array.from(input.bytes),
        mediaType: input.mediaType,
        checksum: input.checksum,
      },
      visualArtifactContext(scope, input.id),
    );
    try {
      const [row] = await this.#sql<VisualArtifactRow[]>`
        INSERT INTO viby.visual_artifacts (
          id, tenant_id, user_id, chat_id, version_id, page_id, path, url,
          filename, media_type, width, height, size, checksum, artifact_store, artifact_key
        )
        SELECT ${input.id}, ${scope.tenantId}, ${scope.userId}, version.chat_id, version.id,
          ${input.pageId}, ${input.path}, ${input.url}, ${input.filename}, ${input.mediaType},
          ${input.width}, ${input.height}, ${input.size}, ${input.checksum},
          ${this.#artifactStore.id}, ${artifactKey}
        FROM viby.versions AS version
        JOIN viby.chats AS chat ON chat.id = version.chat_id
        WHERE version.tenant_id = ${scope.tenantId} AND version.user_id = ${scope.userId}
          AND version.id = ${input.versionId} AND version.chat_id = ${input.chatId}
          AND chat.deleted_at IS NULL
        RETURNING id, chat_id, version_id, page_id, path, url, filename, media_type,
          width, height, size, checksum, artifact_store, artifact_key, created_at
      `;
      if (!row) throw new NotFoundError("Version");
      return mapVisualArtifact(row);
    } catch (error) {
      await this.#artifactStore
        .delete(artifactKey, visualArtifactContext(scope, input.id))
        .catch(() => undefined);
      throw error;
    }
  }

  async listVisualArtifacts(scope: UserScope, versionId: string): Promise<VisualArtifactData[]> {
    await this.assertReady();
    const rows = await this.#sql<VisualArtifactRow[]>`
      SELECT artifact.id, artifact.chat_id, artifact.version_id, artifact.page_id, artifact.path,
        artifact.url, artifact.filename, artifact.media_type, artifact.width, artifact.height,
        artifact.size, artifact.checksum, artifact.artifact_store, artifact.artifact_key,
        artifact.created_at
      FROM viby.visual_artifacts AS artifact
      JOIN viby.chats AS chat ON chat.id = artifact.chat_id
      WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
        AND artifact.version_id = ${versionId} AND chat.deleted_at IS NULL
      ORDER BY artifact.created_at, artifact.id
    `;
    return rows.map(mapVisualArtifact);
  }

  async getVisualArtifact(
    scope: UserScope,
    versionId: string,
    id: string,
  ): Promise<VisualArtifactContent | null> {
    await this.assertReady();
    const [row] = await this.#sql<VisualArtifactRow[]>`
      SELECT artifact.id, artifact.chat_id, artifact.version_id, artifact.page_id, artifact.path,
        artifact.url, artifact.filename, artifact.media_type, artifact.width, artifact.height,
        artifact.size, artifact.checksum, artifact.artifact_store, artifact.artifact_key,
        artifact.created_at
      FROM viby.visual_artifacts AS artifact
      JOIN viby.chats AS chat ON chat.id = artifact.chat_id
      WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
        AND artifact.version_id = ${versionId} AND artifact.id = ${id}
        AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    if (!row) return null;
    if (!this.#artifactStore || this.#artifactStore.id !== row.artifact_store) {
      throw new ConfigurationError(
        `Artifact store ${row.artifact_store} is required to read visual artifact ${row.id}.`,
      );
    }
    const bytes = await this.#artifactStore.get(
      row.artifact_key,
      visualArtifactContext(scope, row.id),
    );
    if (!bytes) throw new NotFoundError("Visual artifact content");
    if (bytes.byteLength !== row.size || sha256(bytes) !== row.checksum) {
      throw new Error(
        `Visual artifact ${row.id} failed its persisted size or checksum validation.`,
      );
    }
    return { ...mapVisualArtifact(row), bytes: Uint8Array.from(bytes) };
  }

  async listMessagePage(
    scope: UserScope,
    chatId: string,
    limit: number,
    after: MessagePageCursor | null,
  ): Promise<RepositoryPage<MessageData>> {
    await this.assertReady();
    const rows = after
      ? await this.#sql<MessageRow[]>`
          SELECT id, chat_id, generation_id, role, content, finish_reason, created_at
          FROM viby.messages
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND chat_id = ${chatId}
            AND (
              date_trunc('milliseconds', created_at) > ${after.createdAt}
              OR (
                date_trunc('milliseconds', created_at) = ${after.createdAt}
                AND id > ${after.id}
              )
            )
          ORDER BY date_trunc('milliseconds', created_at), id
          LIMIT ${limit + 1}
        `
      : await this.#sql<MessageRow[]>`
          SELECT id, chat_id, generation_id, role, content, finish_reason, created_at
          FROM viby.messages
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND chat_id = ${chatId}
          ORDER BY date_trunc('milliseconds', created_at), id
          LIMIT ${limit + 1}
        `;
    return createPage(await this.#messagesWithParts(scope, rows), limit);
  }

  async #messagesWithParts(scope: UserScope, rows: readonly MessageRow[]): Promise<MessageData[]> {
    if (rows.length === 0) return [];
    const messageIds = rows.map((row) => row.id);
    const partRows = await this.#sql<MessagePartRow[]>`
      SELECT id, message_id, generation_id, attempt_id, position, type, data, created_at
      FROM viby.message_parts
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND message_id = ANY(${this.#sql.array(messageIds)}::uuid[])
      ORDER BY message_id, position
    `;
    const attachmentRows = await this.#sql<AttachmentRow[]>`
      SELECT id, chat_id, message_id, generation_id, filename, media_type,
        size, checksum, artifact_store, artifact_key, created_at
      FROM viby.attachments
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND message_id = ANY(${this.#sql.array(messageIds)}::uuid[])
      ORDER BY message_id, created_at, id
    `;
    const parts = new Map<string, MessagePart[]>();
    for (const row of partRows) {
      const current = parts.get(row.message_id) ?? [];
      current.push(mapMessagePart(row));
      parts.set(row.message_id, current);
    }
    const attachments = new Map<string, AttachmentData[]>();
    for (const row of attachmentRows) {
      const current = attachments.get(row.message_id) ?? [];
      current.push(mapAttachment(row));
      attachments.set(row.message_id, current);
    }
    return rows.map((row) =>
      mapMessage(row, parts.get(row.id) ?? [], attachments.get(row.id) ?? []),
    );
  }

  async getVersionFiles(scope: UserScope, versionId: string): Promise<VersionFile[]> {
    await this.assertReady();
    const rows = await this.#sql<VersionFileRow[]>`
      SELECT path, kind, content, artifact_id, media_type, size, checksum, locked
      FROM viby.version_files
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND version_id = ${versionId} AND kind = 'text'
      ORDER BY path
    `;
    return rows.map(mapVersionEntry).map((entry) => {
      if (entry.type === "artifact")
        throw new Error("Text source query returned an artifact entry.");
      const { type: _type, ...file } = entry;
      return file;
    });
  }

  async getVersionEntries(scope: UserScope, versionId: string): Promise<VersionEntry[]> {
    await this.assertReady();
    const rows = await this.#sql<VersionFileRow[]>`
      SELECT entry.path, entry.kind, entry.content, entry.artifact_id, entry.media_type,
        entry.size, entry.checksum, entry.locked
      FROM viby.version_files AS entry
      JOIN viby.versions AS version ON version.id = entry.version_id
      JOIN viby.chats AS chat ON chat.id = version.chat_id
      WHERE entry.tenant_id = ${scope.tenantId} AND entry.user_id = ${scope.userId}
        AND entry.version_id = ${versionId} AND chat.deleted_at IS NULL
      ORDER BY entry.path
    `;
    return rows.map(mapVersionEntry);
  }

  async getProjectArtifact(
    scope: UserScope,
    versionId: string,
    artifactId: string,
  ): Promise<ProjectArtifactContent | null> {
    await this.assertReady();
    const [row] = await this.#sql<ProjectArtifactRow[]>`
      SELECT artifact.id, artifact.media_type, artifact.size, artifact.checksum,
        artifact.artifact_store, artifact.artifact_key, artifact.created_at
      FROM viby.project_artifacts AS artifact
      JOIN viby.version_files AS entry ON entry.artifact_id = artifact.id
      JOIN viby.versions AS version ON version.id = entry.version_id
      JOIN viby.chats AS chat ON chat.id = version.chat_id
      WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
        AND version.id = ${versionId} AND artifact.id = ${artifactId}
        AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    if (!row) return null;
    if (!this.#artifactStore || this.#artifactStore.id !== row.artifact_store) {
      throw new ConfigurationError(
        `Artifact store ${row.artifact_store} is required to read project artifact ${row.id}.`,
      );
    }
    const bytes = await this.#artifactStore.get(
      row.artifact_key,
      projectArtifactContext(scope, row.id),
    );
    if (!bytes) throw new NotFoundError("Project artifact content");
    if (bytes.byteLength !== row.size || sha256(bytes) !== row.checksum) {
      throw new Error(
        `Project artifact ${row.id} failed its persisted size or checksum validation.`,
      );
    }
    return { ...mapProjectArtifact(row), bytes: Uint8Array.from(bytes) };
  }

  async getVersionChanges(scope: UserScope, versionId: string): Promise<SourceChange[]> {
    await this.assertReady();
    const rows = await this.#sql<{ change: SourceChange }[]>`
      SELECT change FROM viby.version_changes
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND version_id = ${versionId}
      ORDER BY position
    `;
    return rows.map((row) => row.change);
  }

  async beginRepositoryPush(
    scope: UserScope,
    input: BeginRepositoryPushRecord,
  ): Promise<RepositoryPushData> {
    await this.assertReady();
    const [inserted] = await this.#sql<RepositoryPushRow[]>`
      INSERT INTO viby.repository_pushes (
        id, tenant_id, user_id, chat_id, version_id, integration_id, connection_id,
        provider, repository_owner, repository_name, branch, commit_message,
        expected_head, status, idempotency_key, created_at, updated_at
      )
      SELECT
        ${input.id}, ${scope.tenantId}, ${scope.userId}, version.chat_id, version.id,
        ${input.integrationId}, ${input.connectionId}, ${input.provider},
        ${input.target.owner}, ${input.target.name}, ${input.branch}, ${input.commitMessage},
        ${input.expectedHead}, 'pending', ${input.idempotencyKey}, ${input.now}, ${input.now}
      FROM viby.versions AS version
      JOIN viby.chats AS chat ON chat.id = version.chat_id
      WHERE version.tenant_id = ${scope.tenantId} AND version.user_id = ${scope.userId}
        AND version.id = ${input.versionId} AND version.chat_id = ${input.chatId}
        AND chat.deleted_at IS NULL
      ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING
      RETURNING *
    `;
    if (inserted) return mapRepositoryPush(inserted);
    const [existing] = await this.#sql<RepositoryPushRow[]>`
      SELECT * FROM viby.repository_pushes
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND idempotency_key = ${input.idempotencyKey}
      LIMIT 1
    `;
    if (existing) return mapRepositoryPush(existing);
    throw new NotFoundError("Repository push version");
  }

  async completeRepositoryPush(
    scope: UserScope,
    input: CompleteRepositoryPushRecord,
  ): Promise<RepositoryPushData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [push] = await sql<RepositoryPushRow[]>`
        SELECT * FROM viby.repository_pushes
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.id}
        FOR UPDATE
      `;
      if (!push) throw new NotFoundError("Repository push");
      const [link] = await sql<RepositoryLinkRow[]>`
        INSERT INTO viby.repository_links (
          id, tenant_id, user_id, chat_id, integration_id, connection_id, provider,
          provider_repository_id, owner, name, default_branch, visibility, url,
          created_at, updated_at
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${push.chat_id},
          ${push.integration_id}, ${push.connection_id}, ${push.provider},
          ${input.repository.id}, ${input.repository.owner}, ${input.repository.name},
          ${input.repository.defaultBranch}, ${input.repository.visibility}, ${input.repository.url},
          ${input.completedAt}, ${input.completedAt}
        )
        ON CONFLICT (
          tenant_id, user_id, chat_id, integration_id, connection_id, provider_repository_id
        ) DO UPDATE SET
          provider = EXCLUDED.provider,
          owner = EXCLUDED.owner,
          name = EXCLUDED.name,
          default_branch = EXCLUDED.default_branch,
          visibility = EXCLUDED.visibility,
          url = EXCLUDED.url,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      if (!link) throw new Error("Postgres did not return the linked repository.");
      const pushed = input.result.status === "pushed";
      const [completed] = await sql<RepositoryPushRow[]>`
        UPDATE viby.repository_pushes SET
          repository_link_id = ${link.id},
          status = ${input.result.status},
          commit = ${pushed ? sql.json(JSON.parse(JSON.stringify(input.result.commit))) : null},
          changed_files = ${pushed ? input.result.changedFiles : null},
          pull_request = ${
            pushed && input.result.pullRequest
              ? sql.json(JSON.parse(JSON.stringify(input.result.pullRequest)))
              : null
          },
          actual_head = ${pushed ? null : input.result.actualHead},
          error = NULL,
          updated_at = ${input.completedAt},
          completed_at = ${input.completedAt}
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.id}
        RETURNING *
      `;
      if (!completed) throw new NotFoundError("Repository push");
      return completed;
    });
    return mapRepositoryPush(row);
  }

  async failRepositoryPush(
    scope: UserScope,
    input: FailRepositoryPushRecord,
  ): Promise<RepositoryPushData> {
    await this.assertReady();
    const [failed] = await this.#sql<RepositoryPushRow[]>`
      UPDATE viby.repository_pushes SET
        status = 'failed', commit = NULL, changed_files = NULL, pull_request = NULL,
        actual_head = NULL, error = ${input.error}, updated_at = ${input.completedAt},
        completed_at = ${input.completedAt}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${input.id} AND status = 'pending'
      RETURNING *
    `;
    if (failed) return mapRepositoryPush(failed);
    const [existing] = await this.#sql<RepositoryPushRow[]>`
      SELECT * FROM viby.repository_pushes
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${input.id}
      LIMIT 1
    `;
    if (!existing) throw new NotFoundError("Repository push");
    return mapRepositoryPush(existing);
  }

  async listRepositoryLinks(scope: UserScope, chatId: string): Promise<RepositoryLinkData[]> {
    await this.assertReady();
    const rows = await this.#sql<RepositoryLinkRow[]>`
      SELECT link.* FROM viby.repository_links AS link
      JOIN viby.chats AS chat ON chat.id = link.chat_id
      WHERE link.tenant_id = ${scope.tenantId} AND link.user_id = ${scope.userId}
        AND link.chat_id = ${chatId} AND chat.deleted_at IS NULL
      ORDER BY link.updated_at DESC, link.id DESC
    `;
    return rows.map(mapRepositoryLink);
  }

  async listRepositoryPushes(
    scope: UserScope,
    input: { readonly chatId: string; readonly versionId?: string },
  ): Promise<RepositoryPushData[]> {
    await this.assertReady();
    const rows = input.versionId
      ? await this.#sql<RepositoryPushRow[]>`
          SELECT push.* FROM viby.repository_pushes AS push
          JOIN viby.chats AS chat ON chat.id = push.chat_id
          WHERE push.tenant_id = ${scope.tenantId} AND push.user_id = ${scope.userId}
            AND push.chat_id = ${input.chatId} AND push.version_id = ${input.versionId}
            AND chat.deleted_at IS NULL
          ORDER BY push.created_at DESC, push.id DESC
        `
      : await this.#sql<RepositoryPushRow[]>`
          SELECT push.* FROM viby.repository_pushes AS push
          JOIN viby.chats AS chat ON chat.id = push.chat_id
          WHERE push.tenant_id = ${scope.tenantId} AND push.user_id = ${scope.userId}
            AND push.chat_id = ${input.chatId} AND chat.deleted_at IS NULL
          ORDER BY push.created_at DESC, push.id DESC
        `;
    return rows.map(mapRepositoryPush);
  }

  async beginDeployment(
    scope: UserScope,
    input: BeginDeploymentRecord,
  ): Promise<DeploymentRecordData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [inserted] = await sql<DeploymentRow[]>`
        INSERT INTO viby.deployments (
          id, tenant_id, user_id, chat_id, version_id, integration_id, connection_id,
          provider, project_target, environment, status, idempotency_key, created_at, updated_at
        )
        SELECT
          ${input.id}, ${scope.tenantId}, ${scope.userId}, version.chat_id, version.id,
          ${input.integrationId}, ${input.connectionId}, ${input.provider},
          ${input.projectTarget}, ${input.environment}, 'pending', ${input.idempotencyKey},
          ${input.now}, ${input.now}
        FROM viby.versions AS version
        JOIN viby.chats AS chat ON chat.id = version.chat_id
        WHERE version.tenant_id = ${scope.tenantId} AND version.user_id = ${scope.userId}
          AND version.id = ${input.versionId} AND version.chat_id = ${input.chatId}
          AND chat.deleted_at IS NULL
        ON CONFLICT (tenant_id, user_id, idempotency_key) DO NOTHING
        RETURNING *
      `;
      if (inserted) {
        await sql`
          INSERT INTO viby.deployment_status_transitions (
            id, tenant_id, user_id, deployment_id, status, url, error, created_at
          ) VALUES (
            ${createId()}, ${scope.tenantId}, ${scope.userId}, ${inserted.id},
            'pending', NULL, NULL, ${input.now}
          )
        `;
        return inserted;
      }
      const [existing] = await sql<DeploymentRow[]>`
        SELECT * FROM viby.deployments
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND idempotency_key = ${input.idempotencyKey}
        LIMIT 1
      `;
      if (!existing) throw new NotFoundError("Deployment version");
      return existing;
    });
    return (await this.#deploymentsWithTransitions(scope, [row]))[0]!;
  }

  async completeDeployment(
    scope: UserScope,
    input: CompleteDeploymentRecord,
  ): Promise<DeploymentRecordData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [deployment] = await sql<DeploymentRow[]>`
        SELECT * FROM viby.deployments
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.id}
        FOR UPDATE
      `;
      if (!deployment) throw new NotFoundError("Deployment");
      const [project] = await sql<DeploymentProjectLinkRow[]>`
        INSERT INTO viby.deployment_project_links (
          id, tenant_id, user_id, chat_id, integration_id, connection_id, provider,
          provider_project_id, name, url, created_at, updated_at
        ) VALUES (
          ${createId()}, ${scope.tenantId}, ${scope.userId}, ${deployment.chat_id},
          ${deployment.integration_id}, ${deployment.connection_id}, ${deployment.provider},
          ${input.project.id}, ${input.project.name}, ${input.project.url},
          ${input.observedAt}, ${input.observedAt}
        )
        ON CONFLICT (
          tenant_id, user_id, chat_id, integration_id, connection_id, provider_project_id
        ) DO UPDATE SET
          provider = EXCLUDED.provider,
          name = EXCLUDED.name,
          url = EXCLUDED.url,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      if (!project) throw new Error("Postgres did not return the deployment project link.");
      const terminal = isTerminalDeploymentStatus(input.deployment.status);
      const changed =
        deployment.status !== input.deployment.status || deployment.url !== input.deployment.url;
      const [updated] = await sql<DeploymentRow[]>`
        UPDATE viby.deployments SET
          project_link_id = ${project.id},
          provider_deployment_id = ${input.deployment.id},
          provider_created_at = ${input.deployment.createdAt},
          environment = ${input.deployment.environment},
          url = ${input.deployment.url},
          status = ${input.deployment.status},
          error = NULL,
          updated_at = ${input.observedAt},
          completed_at = ${terminal ? input.observedAt : null}
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.id}
        RETURNING *
      `;
      if (!updated) throw new NotFoundError("Deployment");
      if (changed) {
        await insertDeploymentTransition(sql, scope, updated, null, input.observedAt);
      }
      return updated;
    });
    return (await this.#deploymentsWithTransitions(scope, [row]))[0]!;
  }

  async failDeployment(
    scope: UserScope,
    input: FailDeploymentRecord,
  ): Promise<DeploymentRecordData> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [deployment] = await sql<DeploymentRow[]>`
        SELECT * FROM viby.deployments
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.id}
        FOR UPDATE
      `;
      if (!deployment) throw new NotFoundError("Deployment");
      if (deployment.status !== "pending") return deployment;
      const [failed] = await sql<DeploymentRow[]>`
        UPDATE viby.deployments SET
          status = 'failed', error = ${input.error}, updated_at = ${input.observedAt},
          completed_at = ${input.observedAt}
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.id}
        RETURNING *
      `;
      if (!failed) throw new NotFoundError("Deployment");
      await insertDeploymentTransition(sql, scope, failed, input.error, input.observedAt);
      return failed;
    });
    return (await this.#deploymentsWithTransitions(scope, [row]))[0]!;
  }

  async observeDeployment(
    scope: UserScope,
    input: ObserveDeploymentRecord,
  ): Promise<DeploymentRecordData | null> {
    await this.assertReady();
    const row = await this.#sql.begin(async (sql) => {
      const [deployment] = await sql<DeploymentRow[]>`
        SELECT * FROM viby.deployments
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND integration_id = ${input.integrationId}
          AND connection_id = ${input.connectionId}
          AND provider = ${input.provider}
          AND provider_deployment_id = ${input.deployment.id}
        ORDER BY created_at DESC
        LIMIT 1
        FOR UPDATE
      `;
      if (!deployment) return null;
      const changed =
        deployment.status !== input.deployment.status || deployment.url !== input.deployment.url;
      const terminal = isTerminalDeploymentStatus(input.deployment.status);
      const [updated] = await sql<DeploymentRow[]>`
        UPDATE viby.deployments SET
          environment = ${input.deployment.environment},
          provider_created_at = ${input.deployment.createdAt},
          url = ${input.deployment.url},
          status = ${input.deployment.status},
          error = NULL,
          updated_at = ${input.observedAt},
          completed_at = ${terminal ? input.observedAt : null}
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${deployment.id}
        RETURNING *
      `;
      if (!updated) throw new NotFoundError("Deployment");
      if (changed) {
        await insertDeploymentTransition(sql, scope, updated, null, input.observedAt);
      }
      return updated;
    });
    if (!row) return null;
    return (await this.#deploymentsWithTransitions(scope, [row]))[0]!;
  }

  async listDeploymentProjects(
    scope: UserScope,
    chatId: string,
  ): Promise<DeploymentProjectLinkData[]> {
    await this.assertReady();
    const rows = await this.#sql<DeploymentProjectLinkRow[]>`
      SELECT project.* FROM viby.deployment_project_links AS project
      JOIN viby.chats AS chat ON chat.id = project.chat_id
      WHERE project.tenant_id = ${scope.tenantId} AND project.user_id = ${scope.userId}
        AND project.chat_id = ${chatId} AND chat.deleted_at IS NULL
      ORDER BY project.updated_at DESC, project.id DESC
    `;
    return rows.map(mapDeploymentProjectLink);
  }

  async listDeployments(
    scope: UserScope,
    input: { readonly chatId: string; readonly versionId?: string },
  ): Promise<DeploymentRecordData[]> {
    await this.assertReady();
    const rows = input.versionId
      ? await this.#sql<DeploymentRow[]>`
          SELECT deployment.* FROM viby.deployments AS deployment
          JOIN viby.chats AS chat ON chat.id = deployment.chat_id
          WHERE deployment.tenant_id = ${scope.tenantId}
            AND deployment.user_id = ${scope.userId}
            AND deployment.chat_id = ${input.chatId}
            AND deployment.version_id = ${input.versionId}
            AND chat.deleted_at IS NULL
          ORDER BY deployment.created_at DESC, deployment.id DESC
        `
      : await this.#sql<DeploymentRow[]>`
          SELECT deployment.* FROM viby.deployments AS deployment
          JOIN viby.chats AS chat ON chat.id = deployment.chat_id
          WHERE deployment.tenant_id = ${scope.tenantId}
            AND deployment.user_id = ${scope.userId}
            AND deployment.chat_id = ${input.chatId}
            AND chat.deleted_at IS NULL
          ORDER BY deployment.created_at DESC, deployment.id DESC
        `;
    return this.#deploymentsWithTransitions(scope, rows);
  }

  async createDeploymentArtifact(
    scope: UserScope,
    input: CreateDeploymentArtifactRecord,
  ): Promise<DeploymentArtifactData> {
    await this.assertReady();
    if (!this.#artifactStore) {
      throw new ConfigurationError(
        "artifactStore is required to persist prepared deployment output.",
      );
    }
    if (input.bytes.byteLength !== input.size || sha256(input.bytes) !== input.checksum) {
      throw new ConfigurationError("Deployment artifact size or checksum is invalid.");
    }
    const [existing] = await this.#sql<DeploymentArtifactRow[]>`
      SELECT artifact.* FROM viby.deployment_artifacts AS artifact
      JOIN viby.chats AS chat ON chat.id = artifact.chat_id
      WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
        AND artifact.deployment_id = ${input.deploymentId} AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    if (existing) return mapDeploymentArtifact(existing);

    const artifactKey = `deployments/${input.deploymentId}/${input.id}-${input.checksum}.zip`;
    await this.#artifactStore.put(
      {
        key: artifactKey,
        bytes: Uint8Array.from(input.bytes),
        mediaType: "application/zip",
        checksum: input.checksum,
      },
      deploymentArtifactContext(scope, input.id),
    );
    try {
      const result = await this.#sql.begin(async (sql) => {
        const [inserted] = await sql<DeploymentArtifactRow[]>`
          INSERT INTO viby.deployment_artifacts (
            id, tenant_id, user_id, chat_id, version_id, deployment_id, framework,
            sandbox_provider, output_directory, commands, file_count, size, checksum,
            artifact_store, artifact_key, created_at
          )
          SELECT
            ${input.id}, ${scope.tenantId}, ${scope.userId}, deployment.chat_id,
            deployment.version_id, deployment.id, ${input.framework}, ${input.sandboxProvider},
            ${input.outputDirectory},
            ${sql.json(JSON.parse(JSON.stringify(input.commands)))}, ${input.fileCount},
            ${input.size}, ${input.checksum}, ${this.#artifactStore!.id}, ${artifactKey}, now()
          FROM viby.deployments AS deployment
          JOIN viby.chats AS chat ON chat.id = deployment.chat_id
          WHERE deployment.tenant_id = ${scope.tenantId}
            AND deployment.user_id = ${scope.userId}
            AND deployment.id = ${input.deploymentId}
            AND deployment.chat_id = ${input.chatId}
            AND deployment.version_id = ${input.versionId}
            AND chat.deleted_at IS NULL
          ON CONFLICT (tenant_id, user_id, deployment_id) DO NOTHING
          RETURNING *
        `;
        const row =
          inserted ??
          (
            await sql<DeploymentArtifactRow[]>`
          SELECT * FROM viby.deployment_artifacts
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND deployment_id = ${input.deploymentId}
          LIMIT 1
        `
          )[0];
        if (!row) throw new NotFoundError("Deployment");
        await sql`
          UPDATE viby.deployments SET
            preparation_artifact_id = ${row.id},
            updated_at = GREATEST(updated_at, ${row.created_at})
          WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
            AND id = ${input.deploymentId}
        `;
        return { row, created: inserted !== undefined };
      });
      if (!result.created && result.row.artifact_key !== artifactKey) {
        await this.#artifactStore
          .delete(artifactKey, deploymentArtifactContext(scope, input.id))
          .catch(() => undefined);
      }
      return mapDeploymentArtifact(result.row);
    } catch (error) {
      await this.#artifactStore
        .delete(artifactKey, deploymentArtifactContext(scope, input.id))
        .catch(() => undefined);
      throw error;
    }
  }

  async getDeploymentArtifact(
    scope: UserScope,
    deploymentId: string,
    artifactId: string,
  ): Promise<DeploymentArtifactContent | null> {
    await this.assertReady();
    const [row] = await this.#sql<DeploymentArtifactRow[]>`
      SELECT artifact.* FROM viby.deployment_artifacts AS artifact
      JOIN viby.deployments AS deployment ON deployment.id = artifact.deployment_id
      JOIN viby.chats AS chat ON chat.id = artifact.chat_id
      WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
        AND artifact.deployment_id = ${deploymentId} AND artifact.id = ${artifactId}
        AND deployment.tenant_id = ${scope.tenantId} AND deployment.user_id = ${scope.userId}
        AND chat.deleted_at IS NULL
      LIMIT 1
    `;
    if (!row) return null;
    if (!this.#artifactStore || this.#artifactStore.id !== row.artifact_store) {
      throw new ConfigurationError(
        `Artifact store ${row.artifact_store} is required to read deployment artifact ${row.id}.`,
      );
    }
    const bytes = await this.#artifactStore.get(
      row.artifact_key,
      deploymentArtifactContext(scope, row.id),
    );
    if (!bytes) throw new NotFoundError("Deployment artifact content");
    if (bytes.byteLength !== row.size || sha256(bytes) !== row.checksum) {
      throw new Error(
        `Deployment artifact ${row.id} failed its persisted size or checksum validation.`,
      );
    }
    return { ...mapDeploymentArtifact(row), bytes: Uint8Array.from(bytes) };
  }

  async #deploymentsWithTransitions(
    scope: UserScope,
    rows: readonly DeploymentRow[],
  ): Promise<DeploymentRecordData[]> {
    if (rows.length === 0) return [];
    const transitions = await this.#sql<DeploymentStatusTransitionRow[]>`
      SELECT id, deployment_id, status, url, error, created_at
      FROM viby.deployment_status_transitions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND deployment_id = ANY(${this.#sql.array(rows.map((row) => row.id))}::uuid[])
      ORDER BY created_at, id
    `;
    const grouped = new Map<string, DeploymentStatusTransitionData[]>();
    for (const transition of transitions) {
      const values = grouped.get(transition.deployment_id) ?? [];
      values.push(mapDeploymentTransition(transition));
      grouped.set(transition.deployment_id, values);
    }
    return rows.map((row) => mapDeployment(row, grouped.get(row.id) ?? []));
  }

  async createSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSandboxLeaseRecord<Framework>,
  ): Promise<SandboxLeaseData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<SandboxLeaseRow[]>`
      INSERT INTO viby.sandbox_leases (
        id, tenant_id, user_id, chat_id, version_id, framework,
        provider, sandbox_id, ports, expires_at
      )
      SELECT
        ${input.id}, ${scope.tenantId}, ${scope.userId}, chat.id, version.id,
        ${input.context.framework}, ${input.provider}, ${input.sandboxId},
        ${this.#sql.array([...input.ports])}::integer[], ${input.expiresAt}
      FROM viby.chats AS chat
      JOIN viby.versions AS version ON version.chat_id = chat.id
      WHERE chat.id = ${input.context.chatId}
        AND version.id = ${input.context.versionId}
        AND chat.tenant_id = ${scope.tenantId} AND chat.user_id = ${scope.userId}
        AND version.tenant_id = ${scope.tenantId} AND version.user_id = ${scope.userId}
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Sandbox version");
    return mapSandboxLease<Framework>(row);
  }

  async getSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<SandboxLeaseData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<SandboxLeaseRow[]>`
      SELECT * FROM viby.sandbox_leases
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapSandboxLease<Framework>(row) : null;
  }

  async closeSandboxLease(
    scope: UserScope,
    id: string,
    status: Exclude<SandboxLeaseStatus, "active">,
  ): Promise<void> {
    await this.assertReady();
    await this.#sql`
      UPDATE viby.sandbox_leases SET
        status = ${status}, stopped_at = now(), updated_at = now()
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${id} AND status = 'active'
    `;
  }

  async createPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreatePreviewSessionRecord<Framework>,
  ): Promise<PreviewSessionData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<PreviewSessionRow[]>`
      INSERT INTO viby.preview_sessions (
        id, tenant_id, user_id, chat_id, version_id, sandbox_lease_id,
        sandbox_provider, framework, port, path, expires_at, created_at, updated_at
      )
      SELECT
        ${input.id}, ${scope.tenantId}, ${scope.userId}, chat.id, version.id, lease.id,
        ${input.sandboxProvider}, ${input.framework}, ${input.port}, ${input.path},
        ${input.expiresAt}, ${input.now}, ${input.now}
      FROM viby.chats AS chat
      JOIN viby.versions AS version ON version.chat_id = chat.id
      JOIN viby.sandbox_leases AS lease
        ON lease.chat_id = chat.id AND lease.version_id = version.id
      WHERE chat.id = ${input.chatId} AND version.id = ${input.versionId}
        AND lease.id = ${input.sandboxLeaseId} AND lease.status = 'active'
        AND lease.provider = ${input.sandboxProvider}
        AND chat.tenant_id = ${scope.tenantId} AND chat.user_id = ${scope.userId}
        AND version.tenant_id = ${scope.tenantId} AND version.user_id = ${scope.userId}
        AND lease.tenant_id = ${scope.tenantId} AND lease.user_id = ${scope.userId}
      ON CONFLICT (tenant_id, user_id, sandbox_lease_id) DO NOTHING
      RETURNING *
    `;
    if (row) return mapPreviewSession<Framework>(row);
    const [existing] = await this.#sql<PreviewSessionRow[]>`
      SELECT * FROM viby.preview_sessions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND sandbox_lease_id = ${input.sandboxLeaseId}
      LIMIT 1
    `;
    if (!existing) throw new NotFoundError("Preview sandbox version");
    return mapPreviewSession<Framework>(existing);
  }

  async getPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<PreviewSessionData<Framework> | null> {
    await this.assertReady();
    const [row] = await this.#sql<PreviewSessionRow[]>`
      SELECT * FROM viby.preview_sessions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapPreviewSession<Framework>(row) : null;
  }

  async listPreviewSessions<Framework extends FrameworkId>(
    scope: UserScope,
    options: PreviewSessionListOptions = {},
  ): Promise<PreviewSessionData<Framework>[]> {
    await this.assertReady();
    const chatId = options.chatId ?? null;
    const versionId = options.versionId ?? null;
    const status = options.status ?? null;
    const rows = await this.#sql<PreviewSessionRow[]>`
      SELECT * FROM viby.preview_sessions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND (${chatId}::uuid IS NULL OR chat_id = ${chatId})
        AND (${versionId}::uuid IS NULL OR version_id = ${versionId})
        AND (${status}::text IS NULL OR status = ${status})
      ORDER BY created_at DESC, id DESC
    `;
    return rows.map(mapPreviewSession<Framework>);
  }

  async listExpiredPreviewSessions<Framework extends FrameworkId>(
    scope: UserScope,
    now: Date,
    limit: number,
  ): Promise<PreviewSessionData<Framework>[]> {
    await this.assertReady();
    const rows = await this.#sql<PreviewSessionRow[]>`
      SELECT * FROM viby.preview_sessions
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND status IN ('starting', 'ready') AND expires_at <= ${now}
      ORDER BY expires_at, id
      LIMIT ${limit}
    `;
    return rows.map(mapPreviewSession<Framework>);
  }

  async retargetPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    versionId: string,
    now: Date,
  ): Promise<PreviewSessionData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<PreviewSessionRow[]>`
      UPDATE viby.preview_sessions AS preview SET
        version_id = version.id, updated_at = ${now}
      FROM viby.versions AS version
      WHERE preview.tenant_id = ${scope.tenantId}
        AND preview.user_id = ${scope.userId}
        AND preview.id = ${id}
        AND preview.status IN ('starting', 'ready')
        AND version.tenant_id = ${scope.tenantId}
        AND version.user_id = ${scope.userId}
        AND version.id = ${versionId}
        AND version.chat_id = preview.chat_id
        AND version.framework = preview.framework
      RETURNING preview.*
    `;
    if (!row) throw new NotFoundError("Active preview version");
    return mapPreviewSession<Framework>(row);
  }

  async markPreviewReady<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    url: string,
    now: Date,
  ): Promise<PreviewSessionData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<PreviewSessionRow[]>`
      UPDATE viby.preview_sessions SET
        status = 'ready', url = ${url}, error = NULL,
        ready_at = COALESCE(ready_at, ${now}), updated_at = ${now}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${id} AND status IN ('starting', 'ready')
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Active preview session");
    return mapPreviewSession<Framework>(row);
  }

  async failPreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    error: string,
    now: Date,
  ): Promise<PreviewSessionData<Framework>> {
    await this.assertReady();
    const [row] = await this.#sql<PreviewSessionRow[]>`
      UPDATE viby.preview_sessions SET
        status = 'failed', error = ${error}, stopped_at = ${now}, updated_at = ${now}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${id} AND status IN ('starting', 'ready')
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Active preview session");
    return mapPreviewSession<Framework>(row);
  }

  async closePreviewSession<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
    status: "stopped" | "expired",
    now: Date,
  ): Promise<PreviewSessionData<Framework>> {
    await this.assertReady();
    const [updated] = await this.#sql<PreviewSessionRow[]>`
      UPDATE viby.preview_sessions SET
        status = ${status}, stopped_at = ${now}, updated_at = ${now}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${id} AND status IN ('starting', 'ready')
      RETURNING *
    `;
    if (updated) return mapPreviewSession<Framework>(updated);
    const existing = await this.getPreviewSession<Framework>(scope, id);
    if (!existing) throw new NotFoundError("Preview session");
    return existing;
  }

  async createToolSourceRegistration(
    scope: UserScope,
    input: CreateToolSourceRegistrationRecord,
  ): Promise<ToolSourceRegistrationData> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceRegistrationRow[]>`
      INSERT INTO viby.tool_sources (
        id, tenant_id, user_id, type, name, description, configuration,
        status, created_at, updated_at
      ) VALUES (
        ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.type},
        ${input.name}, ${input.description},
        ${this.#sql.json(JSON.parse(JSON.stringify(input.configuration)))},
        'active', ${input.now}, ${input.now}
      )
      RETURNING id, type, name, description, configuration, status, created_at, updated_at
    `;
    if (!row) throw new Error("Tool source registration was not returned after creation.");
    return mapToolSourceRegistration(row);
  }

  async getToolSourceRegistration(
    scope: UserScope,
    id: string,
  ): Promise<ToolSourceRegistrationData | null> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceRegistrationRow[]>`
      SELECT id, type, name, description, configuration, status, created_at, updated_at
      FROM viby.tool_sources
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapToolSourceRegistration(row) : null;
  }

  async listToolSourceRegistrations(
    scope: UserScope,
    options: ToolSourceRegistrationListOptions = {},
  ): Promise<readonly ToolSourceRegistrationData[]> {
    await this.assertReady();
    const status = options.status ?? null;
    const type = options.type ?? null;
    const rows = await this.#sql<ToolSourceRegistrationRow[]>`
      SELECT id, type, name, description, configuration, status, created_at, updated_at
      FROM viby.tool_sources
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND (${status}::text IS NULL OR status = ${status})
        AND (${type}::text IS NULL OR type = ${type})
      ORDER BY updated_at DESC, id DESC
      LIMIT ${options.limit ?? 100}
    `;
    return rows.map(mapToolSourceRegistration);
  }

  async updateToolSourceRegistration(
    scope: UserScope,
    id: string,
    input: UpdateToolSourceRegistrationRecord,
  ): Promise<ToolSourceRegistrationData> {
    await this.assertReady();
    const hasName = input.name !== undefined;
    const hasDescription = input.description !== undefined;
    const hasConfiguration = input.configuration !== undefined;
    const hasStatus = input.status !== undefined;
    const [row] = await this.#sql<ToolSourceRegistrationRow[]>`
      UPDATE viby.tool_sources SET
        name = CASE WHEN ${hasName} THEN ${input.name ?? ""} ELSE name END,
        description = CASE WHEN ${hasDescription} THEN ${input.description ?? null} ELSE description END,
        configuration = CASE WHEN ${hasConfiguration}
          THEN ${this.#sql.json(JSON.parse(JSON.stringify(input.configuration ?? {})))}
          ELSE configuration END,
        status = CASE WHEN ${hasStatus} THEN ${input.status ?? "active"} ELSE status END,
        updated_at = ${input.now}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND id = ${id} AND status <> 'archived'
      RETURNING id, type, name, description, configuration, status, created_at, updated_at
    `;
    if (!row) throw new NotFoundError("Active tool source");
    return mapToolSourceRegistration(row);
  }

  async archiveToolSourceRegistration(
    scope: UserScope,
    id: string,
    now: Date,
  ): Promise<ToolSourceRegistrationData> {
    await this.assertReady();
    return this.#sql.begin(async (sql) => {
      const [row] = await sql<ToolSourceRegistrationRow[]>`
        UPDATE viby.tool_sources SET status = 'archived', updated_at = ${now}
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
        RETURNING id, type, name, description, configuration, status, created_at, updated_at
      `;
      if (!row) throw new NotFoundError("Tool source");
      await sql`
        DELETE FROM viby.chat_tool_sources
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND tool_source_id = ${id}
      `;
      return mapToolSourceRegistration(row);
    });
  }

  async replaceChatToolSources(
    scope: UserScope,
    chatId: string,
    sourceIds: readonly string[],
    now: Date,
  ): Promise<readonly ToolSourceRegistrationData[]> {
    await this.assertReady();
    return this.#sql.begin(async (sql) => {
      const [chat] = await sql<{ id: string }[]>`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${chatId} AND deleted_at IS NULL
        LIMIT 1
      `;
      if (!chat) throw new NotFoundError("Chat");
      const rows =
        sourceIds.length === 0
          ? []
          : await sql<ToolSourceRegistrationRow[]>`
        SELECT id, type, name, description, configuration, status, created_at, updated_at
        FROM viby.tool_sources
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ANY(${sql.array([...sourceIds])}::uuid[]) AND status = 'active'
        ORDER BY array_position(${sql.array([...sourceIds])}::uuid[], id)
      `;
      if (rows.length !== sourceIds.length) {
        throw new NotFoundError("Active tool source selection");
      }
      await sql`
        DELETE FROM viby.chat_tool_sources
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND chat_id = ${chatId}
      `;
      if (sourceIds.length > 0) {
        await sql`
          INSERT INTO viby.chat_tool_sources (
            tenant_id, user_id, chat_id, tool_source_id, created_at
          )
          SELECT ${scope.tenantId}, ${scope.userId}, ${chatId}, source_id, ${now}
          FROM unnest(${sql.array([...sourceIds])}::uuid[]) AS source_id
        `;
      }
      return rows.map(mapToolSourceRegistration);
    });
  }

  async listChatToolSources(
    scope: UserScope,
    chatId: string,
  ): Promise<readonly ToolSourceRegistrationData[]> {
    await this.assertReady();
    const rows = await this.#sql<ToolSourceRegistrationRow[]>`
      SELECT source.id, source.type, source.name, source.description, source.configuration,
        source.status, source.created_at, source.updated_at
      FROM viby.chat_tool_sources AS selected
      JOIN viby.tool_sources AS source
        ON source.tenant_id = selected.tenant_id AND source.user_id = selected.user_id
        AND source.id = selected.tool_source_id
      JOIN viby.chats AS chat
        ON chat.tenant_id = selected.tenant_id AND chat.user_id = selected.user_id
        AND chat.id = selected.chat_id
      WHERE selected.tenant_id = ${scope.tenantId} AND selected.user_id = ${scope.userId}
        AND selected.chat_id = ${chatId} AND chat.deleted_at IS NULL
      ORDER BY selected.created_at, selected.tool_source_id
    `;
    return rows.map(mapToolSourceRegistration);
  }

  async createToolSourceAuthorizationSession(
    scope: UserScope,
    input: CreateToolSourceAuthorizationSessionRecord,
  ): Promise<ToolSourceAuthorizationSessionData> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceAuthorizationSessionRow[]>`
      INSERT INTO viby.tool_source_authorization_sessions (
        id, tenant_id, user_id, tool_source_id, provider, state_hash, callback_url,
        return_to, scopes, session_secret_ref, expires_at, created_at
      ) VALUES (
        ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.toolSourceId},
        ${input.provider}, ${input.stateHash}, ${input.callbackUrl}, ${input.returnTo},
        ${this.#sql.array([...input.scopes])}, ${input.sessionSecretRef},
        ${input.expiresAt}, ${input.createdAt}
      )
      RETURNING *
    `;
    if (!row) throw new Error("Tool source authorization session was not returned after creation.");
    return mapToolSourceAuthorizationSession(row);
  }

  async getToolSourceAuthorizationSession(
    stateHash: string,
    now: Date,
  ): Promise<{ scope: UserScope; session: ToolSourceAuthorizationSessionData } | null> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceAuthorizationSessionRow[]>`
      SELECT * FROM viby.tool_source_authorization_sessions
      WHERE state_hash = ${stateHash} AND consumed_at IS NULL AND expires_at > ${now}
      LIMIT 1
    `;
    return row
      ? {
          scope: { tenantId: row.tenant_id, userId: row.user_id },
          session: mapToolSourceAuthorizationSession(row),
        }
      : null;
  }

  async consumeToolSourceAuthorizationSession(
    stateHash: string,
    consumedAt: Date,
  ): Promise<{ scope: UserScope; session: ToolSourceAuthorizationSessionData } | null> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceAuthorizationSessionRow[]>`
      UPDATE viby.tool_source_authorization_sessions
      SET consumed_at = ${consumedAt}
      WHERE state_hash = ${stateHash} AND consumed_at IS NULL AND expires_at > ${consumedAt}
      RETURNING *
    `;
    return row
      ? {
          scope: { tenantId: row.tenant_id, userId: row.user_id },
          session: mapToolSourceAuthorizationSession(row),
        }
      : null;
  }

  async getToolSourceConnection(
    scope: UserScope,
    toolSourceId: string,
  ): Promise<StoredToolSourceConnection | null> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceConnectionRow[]>`
      SELECT * FROM viby.tool_source_connections
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND tool_source_id = ${toolSourceId}
      LIMIT 1
    `;
    return row ? mapToolSourceConnection(row) : null;
  }

  async upsertToolSourceConnection(
    scope: UserScope,
    input: UpsertToolSourceConnectionRecord,
  ): Promise<{ connection: StoredToolSourceConnection; replacedSecretRef: string | null }> {
    await this.assertReady();
    return this.#sql.begin(async (sql) => {
      const [current] = await sql<{ secret_ref: string | null }[]>`
        SELECT secret_ref FROM viby.tool_source_connections
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND tool_source_id = ${input.toolSourceId}
        FOR UPDATE
      `;
      const metadata = input.account.metadata
        ? sql.json(JSON.parse(JSON.stringify(input.account.metadata)))
        : null;
      const [row] = await sql<ToolSourceConnectionRow[]>`
        INSERT INTO viby.tool_source_connections (
          id, tenant_id, user_id, tool_source_id, provider,
          external_account_id, external_account_name, external_account_url,
          external_account_metadata, secret_ref, status, scopes, expires_at,
          created_at, updated_at
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.toolSourceId},
          ${input.provider}, ${input.account.id}, ${input.account.name},
          ${input.account.url ?? null}, ${metadata}, ${input.secretRef}, 'active',
          ${sql.array([...input.scopes])}, ${input.expiresAt}, ${input.now}, ${input.now}
        )
        ON CONFLICT (tenant_id, user_id, tool_source_id) DO UPDATE SET
          provider = EXCLUDED.provider,
          external_account_id = EXCLUDED.external_account_id,
          external_account_name = EXCLUDED.external_account_name,
          external_account_url = EXCLUDED.external_account_url,
          external_account_metadata = EXCLUDED.external_account_metadata,
          secret_ref = EXCLUDED.secret_ref,
          status = 'active',
          scopes = EXCLUDED.scopes,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      if (!row) throw new Error("Tool source connection was not returned after upsert.");
      return {
        connection: mapToolSourceConnection(row),
        replacedSecretRef: current?.secret_ref ?? null,
      };
    });
  }

  async updateToolSourceConnection(
    scope: UserScope,
    id: string,
    input: UpdateToolSourceConnectionRecord,
  ): Promise<StoredToolSourceConnection> {
    await this.assertReady();
    const [row] = await this.#sql<ToolSourceConnectionRow[]>`
      UPDATE viby.tool_source_connections SET
        status = ${input.status}, secret_ref = ${input.secretRef},
        scopes = ${this.#sql.array([...input.scopes])}, expires_at = ${input.expiresAt},
        updated_at = ${input.now}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Tool source connection");
    return mapToolSourceConnection(row);
  }

  async #storeAttachments(
    scope: UserScope,
    input: Pick<CreateGenerationRecord, "id" | "attachments">,
  ): Promise<StoredAttachmentInput[]> {
    if (!input.attachments || input.attachments.length === 0) return [];
    if (!this.#artifactStore) {
      throw new ConfigurationError(
        "artifactStore is required when a generation includes binary attachments.",
      );
    }
    const stored: StoredAttachmentInput[] = [];
    try {
      for (const attachment of input.attachments) {
        const artifactKey = `attachments/${input.id}/${attachment.id}-${attachment.checksum}`;
        await this.#artifactStore.put(
          {
            key: artifactKey,
            bytes: Uint8Array.from(attachment.bytes),
            mediaType: attachment.mediaType,
            checksum: attachment.checksum,
          },
          attachmentContext(scope, attachment.id),
        );
        stored.push({
          id: attachment.id,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
          size: attachment.size,
          checksum: attachment.checksum,
          artifactStore: this.#artifactStore.id,
          artifactKey,
        });
      }
      return stored;
    } catch (error) {
      await Promise.allSettled(
        stored.map((attachment) =>
          this.#artifactStore!.delete(
            attachment.artifactKey,
            attachmentContext(scope, attachment.id),
          ),
        ),
      );
      throw error;
    }
  }

  async #storeGeneratedArtifacts(
    scope: UserScope,
    generationId: string,
    artifacts: readonly CreateGeneratedArtifactRecord[],
  ): Promise<StoredGeneratedArtifactInput[]> {
    if (artifacts.length === 0) return [];
    if (!this.#artifactStore) {
      throw new ConfigurationError(
        "artifactStore is required when a generation produces binary artifacts.",
      );
    }
    const stored: StoredGeneratedArtifactInput[] = [];
    try {
      for (const artifact of artifacts) {
        const artifactKey = `generated/${generationId}/${artifact.id}-${artifact.checksum}`;
        await this.#artifactStore.put(
          {
            key: artifactKey,
            bytes: Uint8Array.from(artifact.bytes),
            mediaType: artifact.mediaType,
            checksum: artifact.checksum,
          },
          generatedArtifactContext(scope, artifact.id),
        );
        stored.push({
          id: artifact.id,
          position: artifact.position,
          kind: artifact.kind,
          filename: artifact.filename,
          mediaType: artifact.mediaType,
          size: artifact.size,
          checksum: artifact.checksum,
          artifactStore: this.#artifactStore.id,
          artifactKey,
        });
      }
      return stored;
    } catch (error) {
      await this.#cleanupGeneratedArtifacts(scope, stored);
      throw error;
    }
  }

  async #storeProjectArtifacts(
    scope: UserScope,
    artifacts: readonly CreateProjectArtifactRecord[],
  ): Promise<StoredProjectArtifactInput[]> {
    if (artifacts.length === 0) return [];
    if (!this.#artifactStore) {
      throw new ConfigurationError(
        "artifactStore is required when a project contains binary artifacts.",
      );
    }
    const stored: StoredProjectArtifactInput[] = [];
    try {
      for (const artifact of artifacts) {
        const artifactKey = `project/${artifact.artifactId}-${artifact.checksum}`;
        await this.#artifactStore.put(
          {
            key: artifactKey,
            bytes: Uint8Array.from(artifact.bytes),
            mediaType: artifact.mediaType,
            checksum: artifact.checksum,
          },
          projectArtifactContext(scope, artifact.artifactId),
        );
        stored.push({
          type: "artifact",
          path: artifact.path,
          artifactId: artifact.artifactId,
          mediaType: artifact.mediaType,
          size: artifact.size,
          checksum: artifact.checksum,
          locked: artifact.locked,
          artifactStore: this.#artifactStore.id,
          artifactKey,
        });
      }
      return stored;
    } catch (error) {
      await this.#cleanupProjectArtifacts(scope, stored);
      throw error;
    }
  }

  async #cleanupProjectArtifacts(
    scope: UserScope,
    artifacts: readonly StoredProjectArtifactInput[],
  ): Promise<void> {
    if (!this.#artifactStore) return;
    await Promise.allSettled(
      artifacts.map((artifact) =>
        this.#artifactStore!.delete(
          artifact.artifactKey,
          projectArtifactContext(scope, artifact.artifactId),
        ),
      ),
    );
  }

  async #cleanupGeneratedArtifacts(
    scope: UserScope,
    artifacts: readonly StoredGeneratedArtifactInput[],
  ): Promise<void> {
    if (!this.#artifactStore) return;
    await Promise.allSettled(
      artifacts.map((artifact) =>
        this.#artifactStore!.delete(
          artifact.artifactKey,
          generatedArtifactContext(scope, artifact.id),
        ),
      ),
    );
  }

  async #loadAttachmentContent(scope: UserScope, row: AttachmentRow): Promise<AttachmentContent> {
    if (row.artifact_store === "postgres-legacy") {
      if (!row.content) throw new Error(`Legacy attachment ${row.id} has no content.`);
      return { ...mapAttachment(row), bytes: Uint8Array.from(row.content) };
    }
    if (!this.#artifactStore || this.#artifactStore.id !== row.artifact_store) {
      throw new ConfigurationError(
        `Artifact store ${row.artifact_store} is required to read attachment ${row.id}.`,
      );
    }
    const bytes = await this.#artifactStore.get(row.artifact_key, attachmentContext(scope, row.id));
    if (!bytes) throw new NotFoundError("Attachment content");
    if (bytes.byteLength !== row.size || sha256(bytes) !== row.checksum) {
      throw new Error(`Attachment ${row.id} failed its persisted size or checksum validation.`);
    }
    return { ...mapAttachment(row), bytes: Uint8Array.from(bytes) };
  }

  async #deleteStoredArtifact(scope: UserScope, row: StoredArtifactLocation): Promise<void> {
    if (
      row.artifact_store === "postgres-legacy" ||
      !this.#artifactStore ||
      this.#artifactStore.id !== row.artifact_store
    )
      return;
    await this.#artifactStore.delete(
      row.artifact_key,
      row.kind === "attachment"
        ? attachmentContext(scope, row.id)
        : row.kind === "generated"
          ? generatedArtifactContext(scope, row.id)
          : row.kind === "project"
            ? projectArtifactContext(scope, row.id)
            : row.kind === "visual"
              ? visualArtifactContext(scope, row.id)
              : deploymentArtifactContext(scope, row.id),
    );
  }
}

function attachmentContext(scope: UserScope, ownerId: string): ArtifactStoreContext {
  return { ...scope, kind: "attachment", ownerId };
}

function generatedArtifactContext(scope: UserScope, ownerId: string): ArtifactStoreContext {
  return { ...scope, kind: "generated", ownerId };
}

function projectArtifactContext(scope: UserScope, ownerId: string): ArtifactStoreContext {
  return { ...scope, kind: "project", ownerId };
}

function visualArtifactContext(scope: UserScope, ownerId: string): ArtifactStoreContext {
  return { ...scope, kind: "screenshot", ownerId };
}

function deploymentArtifactContext(scope: UserScope, ownerId: string): ArtifactStoreContext {
  return { ...scope, kind: "deployment", ownerId };
}

function mapChat<Framework extends FrameworkId>(row: ChatRow): ChatData<Framework> {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    title: row.title,
    metadata: row.metadata,
    framework: row.framework as Framework,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function createPage<Item>(items: Item[], limit: number): RepositoryPage<Item> {
  return { items: items.slice(0, limit), hasMore: items.length > limit };
}

function withCreatedAt<Row extends { created_at: Date }>(row: Row): Row {
  return { ...row, created_at: repositoryDate(row.created_at) };
}

function repositoryDate(value: unknown): Date {
  const date = value instanceof Date ? value : new Date(String(value));
  if (!Number.isFinite(date.getTime())) throw new Error("Postgres returned an invalid date.");
  return date;
}

function repositoryNullableDate(value: unknown): Date | null {
  return value === null ? null : repositoryDate(value);
}

function defaultGenerationConfiguration(): GenerationConfigurationData {
  return { model: "default", instructions: null, skills: {}, metadata: {} };
}

function hydrateGenerationRow(row: GenerationRow): GenerationRow {
  return {
    ...row,
    created_at: repositoryDate(row.created_at),
    started_at: repositoryNullableDate(row.started_at),
    completed_at: repositoryNullableDate(row.completed_at),
  };
}

function hydrateAttemptRow(row: GenerationAttemptRow): GenerationAttemptRow {
  return {
    ...row,
    created_at: repositoryDate(row.created_at),
    started_at: repositoryNullableDate(row.started_at),
    completed_at: repositoryNullableDate(row.completed_at),
    heartbeat_at: repositoryNullableDate(row.heartbeat_at),
    lease_expires_at: repositoryNullableDate(row.lease_expires_at),
  };
}

function hydrateTaskRow(row: GenerationTaskRow): GenerationTaskRow {
  return {
    ...row,
    created_at: repositoryDate(row.created_at),
    resolved_at: repositoryNullableDate(row.resolved_at),
  };
}

function hydrateSteeringRow(row: GenerationSteeringRow): GenerationSteeringRow {
  return {
    ...row,
    created_at: repositoryDate(row.created_at),
    applied_at: repositoryNullableDate(row.applied_at),
  };
}

function hydrateToolCallRow(row: ToolCallRow): ToolCallRow {
  return {
    ...row,
    created_at: repositoryDate(row.created_at),
    completed_at: repositoryNullableDate(row.completed_at),
  };
}

function mapGeneration(row: GenerationRow): GenerationData {
  return {
    id: row.id,
    chatId: row.chat_id,
    baseVersionId: row.base_version_id,
    activeAttemptId: row.active_attempt_id,
    attemptCount: row.attempt_count,
    prompt: row.prompt,
    status: row.status,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    configuration: row.configuration ?? defaultGenerationConfiguration(),
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cost: mapCost(row.estimated_cost_micros, row.cost_currency),
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  };
}

function mapAttempt(row: GenerationAttemptRow): GenerationAttemptData {
  return {
    id: row.id,
    generationId: row.generation_id,
    number: row.number,
    reason: row.reason,
    status: row.status,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    totalTokens: row.total_tokens,
    cost: mapCost(row.estimated_cost_micros, row.cost_currency),
    finishReason: row.finish_reason,
    error: row.error,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    workerId: row.worker_id,
    heartbeatAt: row.heartbeat_at,
    leaseExpiresAt: row.lease_expires_at,
  };
}

function mapCost(
  amount: string | number | null,
  currency: string | null,
): GenerationCostData | null {
  if (amount === null || currency === null) return null;
  const amountMicros = Number(amount);
  if (!Number.isSafeInteger(amountMicros) || amountMicros < 0) {
    throw new Error("Stored generation cost is outside the JavaScript safe integer range.");
  }
  return { amountMicros, currency };
}

function mapEvent(row: GenerationEventRow): GenerationEvent {
  return {
    cursor: String(row.cursor),
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    type: row.type,
    data: row.data,
    createdAt: row.created_at,
  } as GenerationEvent;
}

function mapOutboundEventDelivery(row: OutboundEventDeliveryRow): OutboundEventDeliveryData {
  const eventCursor = String(row.event_cursor);
  return {
    generationId: row.generation_id,
    eventCursor,
    eventId: `${row.generation_id}:${eventCursor}`,
    sinkId: row.sink_id,
    status: row.status,
    attemptCount: row.attempt_count,
    maxAttempts: row.max_attempts,
    nextAttemptAt: row.next_attempt_at,
    leaseExpiresAt: row.lease_expires_at,
    lastError: row.last_error,
    deliveredAt: row.delivered_at,
    deadLetteredAt: row.dead_lettered_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapTask(row: GenerationTaskRow): GenerationTaskData {
  return {
    ...row.payload,
    id: row.id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    status: row.status,
    resolution: row.resolution,
    createdAt: row.created_at,
    resolvedAt: row.resolved_at,
  } as GenerationTaskData;
}

function mapGenerationSteering(row: GenerationSteeringRow): GenerationSteeringData {
  return {
    id: row.id,
    generationId: row.generation_id,
    messageId: row.message_id,
    submittedAttemptId: row.submitted_attempt_id,
    appliedAttemptId: row.applied_attempt_id,
    prompt: row.prompt,
    status: row.status,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    appliedAt: row.applied_at,
  };
}

function mapVersion<Framework extends FrameworkId>(row: VersionRow): VersionData<Framework> {
  return {
    id: row.id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    parentVersionId: row.parent_version_id,
    number: row.number,
    origin: row.origin,
    framework: row.framework as Framework,
    title: row.title,
    summary: row.summary,
    createdAt: row.created_at,
  };
}

function mapRepositoryLink(row: RepositoryLinkRow): RepositoryLinkData {
  return {
    id: row.id,
    chatId: row.chat_id,
    integrationId: row.integration_id,
    connectionId: row.connection_id,
    provider: row.provider,
    repositoryId: row.provider_repository_id,
    owner: row.owner,
    name: row.name,
    defaultBranch: row.default_branch,
    visibility: row.visibility,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRepositoryPush(row: RepositoryPushRow): RepositoryPushData {
  return {
    id: row.id,
    chatId: row.chat_id,
    versionId: row.version_id,
    repositoryLinkId: row.repository_link_id,
    integrationId: row.integration_id,
    connectionId: row.connection_id,
    provider: row.provider,
    target: { owner: row.repository_owner, name: row.repository_name },
    branch: row.branch,
    commitMessage: row.commit_message,
    expectedHead: row.expected_head,
    status: row.status,
    commit: row.commit,
    changedFiles: row.changed_files,
    pullRequest: row.pull_request,
    actualHead: row.actual_head,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapDeploymentProjectLink(row: DeploymentProjectLinkRow): DeploymentProjectLinkData {
  return {
    id: row.id,
    chatId: row.chat_id,
    integrationId: row.integration_id,
    connectionId: row.connection_id,
    provider: row.provider,
    providerProjectId: row.provider_project_id,
    name: row.name,
    url: row.url,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDeploymentTransition(
  row: DeploymentStatusTransitionRow,
): DeploymentStatusTransitionData {
  return {
    id: row.id,
    deploymentId: row.deployment_id,
    status: row.status,
    url: row.url,
    error: row.error,
    createdAt: row.created_at,
  };
}

function mapDeployment(
  row: DeploymentRow,
  transitions: readonly DeploymentStatusTransitionData[],
): DeploymentRecordData {
  return {
    id: row.id,
    chatId: row.chat_id,
    versionId: row.version_id,
    projectLinkId: row.project_link_id,
    preparationArtifactId: row.preparation_artifact_id,
    integrationId: row.integration_id,
    connectionId: row.connection_id,
    provider: row.provider,
    projectTarget: row.project_target,
    environment: row.environment,
    providerDeploymentId: row.provider_deployment_id,
    providerCreatedAt: row.provider_created_at,
    url: row.url,
    status: row.status,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    transitions,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  };
}

function mapDeploymentArtifact(row: DeploymentArtifactRow): DeploymentArtifactData {
  return {
    id: row.id,
    chatId: row.chat_id,
    versionId: row.version_id,
    deploymentId: row.deployment_id,
    framework: row.framework,
    sandboxProvider: row.sandbox_provider,
    outputDirectory: row.output_directory,
    commands: row.commands.map((command) => ({
      ...command,
      args: [...command.args],
      environment: [...command.environment],
    })),
    fileCount: row.file_count,
    mediaType: row.media_type,
    size: row.size,
    checksum: row.checksum,
    artifact: { store: row.artifact_store, key: row.artifact_key },
    createdAt: row.created_at,
  };
}

function isTerminalDeploymentStatus(status: DeploymentStatus): boolean {
  return status === "ready" || status === "failed" || status === "cancelled";
}

function mapDesignEvaluation(row: DesignEvaluationRow): DesignEvaluationData {
  return {
    id: row.id,
    chatId: row.chat_id,
    versionId: row.version_id,
    generationId: row.generation_id,
    evaluator: row.evaluator,
    status: row.status,
    score: Number(row.score),
    summary: row.summary,
    criteria: row.criteria,
    evidence: row.evidence,
    metadata: row.metadata,
    createdAt: row.created_at,
  };
}

function mapMessage(
  row: MessageRow,
  parts: readonly MessagePart[],
  attachments: readonly AttachmentData[],
): MessageData {
  return {
    id: row.id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    role: row.role,
    content: row.content,
    finishReason: row.finish_reason,
    parts,
    attachments,
    createdAt: row.created_at,
  };
}

function mapAttachment(row: AttachmentRow): AttachmentData {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    generationId: row.generation_id,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    checksum: row.checksum,
    artifact: { store: row.artifact_store, key: row.artifact_key },
    createdAt: row.created_at,
  };
}

function mapGeneratedArtifact(row: GeneratedArtifactRow): GeneratedArtifactData {
  return {
    id: row.id,
    chatId: row.chat_id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    versionId: row.version_id,
    position: row.position,
    kind: row.kind,
    filename: row.filename,
    mediaType: row.media_type,
    size: row.size,
    checksum: row.checksum,
    artifact: { store: row.artifact_store, key: row.artifact_key },
    createdAt: row.created_at,
  };
}

function mapProjectArtifact(row: ProjectArtifactRow): Omit<ProjectArtifactContent, "bytes"> {
  return {
    id: row.id,
    mediaType: row.media_type,
    size: row.size,
    checksum: row.checksum,
    artifact: { store: row.artifact_store, key: row.artifact_key },
    createdAt: row.created_at,
  };
}

function mapVersionEntry(row: VersionFileRow): VersionEntry {
  if (row.kind === "artifact") {
    if (!row.artifact_id) throw new Error(`Artifact-backed entry ${row.path} has no artifact id.`);
    return {
      type: "artifact",
      path: row.path,
      artifactId: row.artifact_id,
      mediaType: row.media_type,
      size: row.size,
      checksum: row.checksum,
      locked: row.locked,
    };
  }
  if (row.content === null) throw new Error(`Text entry ${row.path} has no content.`);
  return {
    type: "text",
    path: row.path,
    content: row.content,
    mediaType: row.media_type,
    size: row.size,
    checksum: row.checksum,
    locked: row.locked,
  };
}

function mapVisualArtifact(row: VisualArtifactRow): VisualArtifactData {
  return {
    id: row.id,
    chatId: row.chat_id,
    versionId: row.version_id,
    pageId: row.page_id,
    path: row.path,
    url: row.url,
    filename: row.filename,
    mediaType: row.media_type,
    width: row.width,
    height: row.height,
    size: row.size,
    checksum: row.checksum,
    artifact: { store: row.artifact_store, key: row.artifact_key },
    createdAt: row.created_at,
  };
}

function mapMessagePart(row: MessagePartRow): MessagePart {
  return {
    id: row.id,
    messageId: row.message_id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    position: row.position,
    type: row.type,
    data: row.data,
    createdAt: row.created_at,
  } as MessagePart;
}

function mapMessageFeedback(row: MessageFeedbackRow): MessageFeedbackData {
  return {
    id: row.id,
    chatId: row.chat_id,
    messageId: row.message_id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    versionId: row.version_id,
    modelProvider: row.model_provider,
    modelId: row.model_id,
    rating: row.rating,
    reasons: row.reasons,
    comment: row.comment,
    metadata: row.metadata,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

async function insertGeneratedArtifacts(
  sql: postgres.TransactionSql,
  scope: UserScope,
  input: {
    readonly chatId: string;
    readonly generationId: string;
    readonly attemptId: string;
    readonly versionId: string | null;
    readonly artifacts: readonly StoredGeneratedArtifactInput[];
  },
): Promise<void> {
  for (const artifact of input.artifacts) {
    const [row] = await sql<GeneratedArtifactRow[]>`
      INSERT INTO viby.generated_artifacts (
        id, tenant_id, user_id, chat_id, generation_id, attempt_id, version_id, position,
        kind, filename, media_type, size, checksum, artifact_store, artifact_key
      ) VALUES (
        ${artifact.id}, ${scope.tenantId}, ${scope.userId}, ${input.chatId},
        ${input.generationId}, ${input.attemptId}, ${input.versionId}, ${artifact.position}, ${artifact.kind},
        ${artifact.filename}, ${artifact.mediaType}, ${artifact.size}, ${artifact.checksum},
        ${artifact.artifactStore}, ${artifact.artifactKey}
      )
      RETURNING id, chat_id, generation_id, attempt_id, version_id, position, kind, filename,
        media_type, size, checksum, artifact_store, artifact_key, created_at
    `;
    if (!row) throw new Error("Postgres did not return the generated artifact.");
    await sql`
      INSERT INTO viby.generation_events (
        tenant_id, user_id, generation_id, attempt_id, type, data
      ) VALUES (
        ${scope.tenantId}, ${scope.userId}, ${input.generationId}, ${input.attemptId},
        'artifact.created', ${sql.json({
          artifactId: row.id,
          position: row.position,
          kind: row.kind,
          filename: row.filename,
          mediaType: row.media_type,
          size: row.size,
          checksum: row.checksum,
        })}
      )
    `;
  }
}

async function insertDeploymentTransition(
  sql: postgres.TransactionSql,
  scope: UserScope,
  deployment: DeploymentRow,
  error: string | null,
  createdAt: Date,
): Promise<void> {
  await sql`
    INSERT INTO viby.deployment_status_transitions (
      id, tenant_id, user_id, deployment_id, status, url, error, created_at
    ) VALUES (
      ${createId()}, ${scope.tenantId}, ${scope.userId}, ${deployment.id},
      ${deployment.status}, ${deployment.url}, ${error}, ${createdAt}
    )
  `;
}

async function insertProjectArtifacts(
  sql: postgres.TransactionSql,
  scope: UserScope,
  artifacts: readonly StoredProjectArtifactInput[],
): Promise<void> {
  for (const artifact of artifacts) {
    await sql`
      INSERT INTO viby.project_artifacts (
        id, tenant_id, user_id, media_type, size, checksum, artifact_store, artifact_key
      ) VALUES (
        ${artifact.artifactId}, ${scope.tenantId}, ${scope.userId}, ${artifact.mediaType},
        ${artifact.size}, ${artifact.checksum}, ${artifact.artifactStore}, ${artifact.artifactKey}
      )
    `;
  }
}

async function insertVersionEntries(
  sql: postgres.TransactionSql,
  scope: UserScope,
  versionId: string,
  files: readonly VersionFile[],
  artifacts: readonly VersionArtifact[],
): Promise<void> {
  for (const file of files) {
    await sql`
      INSERT INTO viby.version_files (
        id, tenant_id, user_id, version_id, path, kind, content, artifact_id,
        media_type, size, checksum, locked
      ) VALUES (
        ${createId()}, ${scope.tenantId}, ${scope.userId}, ${versionId}, ${file.path},
        'text', ${file.content}, NULL, ${file.mediaType}, ${file.size}, ${file.checksum}, ${file.locked}
      )
    `;
  }
  for (const entry of artifacts) {
    const [inserted] = await sql<{ id: string }[]>`
      INSERT INTO viby.version_files (
        id, tenant_id, user_id, version_id, path, kind, content, artifact_id,
        media_type, size, checksum, locked
      )
      SELECT ${createId()}, ${scope.tenantId}, ${scope.userId}, ${versionId}, ${entry.path},
        'artifact', NULL, artifact.id, artifact.media_type, artifact.size,
        artifact.checksum, ${entry.locked}
      FROM viby.project_artifacts AS artifact
      WHERE artifact.tenant_id = ${scope.tenantId} AND artifact.user_id = ${scope.userId}
        AND artifact.id = ${entry.artifactId}
      RETURNING id
    `;
    if (!inserted) throw new NotFoundError("Project artifact");
  }
}

async function copyVersionEntryRows(
  sql: postgres.TransactionSql,
  scope: UserScope,
  versionId: string,
  entries: readonly VersionFileRow[],
): Promise<void> {
  for (const entry of entries) {
    await sql`
      INSERT INTO viby.version_files (
        id, tenant_id, user_id, version_id, path, kind, content, artifact_id,
        media_type, size, checksum, locked
      ) VALUES (
        ${createId()}, ${scope.tenantId}, ${scope.userId}, ${versionId}, ${entry.path},
        ${entry.kind}, ${entry.content}, ${entry.artifact_id}, ${entry.media_type},
        ${entry.size}, ${entry.checksum}, ${entry.locked}
      )
    `;
  }
}

async function insertMessage(
  sql: postgres.TransactionSql,
  scope: UserScope,
  input: {
    readonly id?: string;
    readonly chatId: string;
    readonly generationId: string;
    readonly attemptId: string;
    readonly role: "user" | "assistant";
    readonly content: string;
    readonly finishReason?: string | null;
    readonly parts: readonly MessagePartInput[];
    readonly attachments?: readonly StoredAttachmentInput[];
  },
): Promise<void> {
  const messageId = input.id ?? createId();
  await sql`
    INSERT INTO viby.messages (
      id, tenant_id, user_id, chat_id, generation_id, role, content, finish_reason
    ) VALUES (
      ${messageId}, ${scope.tenantId}, ${scope.userId}, ${input.chatId},
      ${input.generationId}, ${input.role}, ${input.content}, ${input.finishReason ?? null}
    )
  `;
  for (const [position, part] of input.parts.entries()) {
    await sql`
      INSERT INTO viby.message_parts (
        id, tenant_id, user_id, message_id, generation_id, attempt_id,
        position, type, data
      ) VALUES (
        ${part.id ?? createId()}, ${scope.tenantId}, ${scope.userId}, ${messageId},
        ${input.generationId}, ${input.attemptId}, ${position}, ${part.type},
        ${sql.json(JSON.parse(JSON.stringify(part.data)))}
      )
    `;
  }
  for (const attachment of input.attachments ?? []) {
    await sql`
      INSERT INTO viby.attachments (
        id, tenant_id, user_id, chat_id, message_id, generation_id,
        filename, media_type, size, checksum, artifact_store, artifact_key, content
      ) VALUES (
        ${attachment.id}, ${scope.tenantId}, ${scope.userId}, ${input.chatId},
        ${messageId}, ${input.generationId}, ${attachment.filename},
        ${attachment.mediaType}, ${attachment.size}, ${attachment.checksum},
        ${attachment.artifactStore}, ${attachment.artifactKey}, NULL
      )
    `;
  }
  const toolCallIds = input.parts.flatMap((part) =>
    part.type === "tool-call" ? [part.data.toolCallId] : [],
  );
  if (toolCallIds.length > 0) {
    await sql`
      UPDATE viby.tool_calls SET message_id = ${messageId}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND generation_id = ${input.generationId} AND attempt_id = ${input.attemptId}
        AND id = ANY(${sql.array(toolCallIds)}::uuid[])
    `;
  }
}

async function assertActiveToolAttempt(
  sql: postgres.TransactionSql,
  scope: UserScope,
  input: Pick<CreateToolCallRecord, "generationId" | "attemptId" | "leaseToken">,
): Promise<void> {
  const rows = await sql<{ id: string }[]>`
    SELECT attempt.id
    FROM viby.generations AS generation
    JOIN viby.generation_attempts AS attempt ON attempt.id = generation.active_attempt_id
    WHERE generation.tenant_id = ${scope.tenantId} AND generation.user_id = ${scope.userId}
      AND generation.id = ${input.generationId} AND generation.status = 'running'
      AND attempt.id = ${input.attemptId} AND attempt.status = 'running'
      AND attempt.lease_token = ${input.leaseToken} AND attempt.lease_expires_at > now()
  `;
  if (rows.length === 0) {
    throw new GenerationStateError(
      input.generationId,
      "The generation worker lease is no longer active.",
    );
  }
}

async function assertNoQueuedSteering(
  sql: postgres.TransactionSql,
  scope: UserScope,
  generationId: string,
): Promise<void> {
  const [pending] = await sql<{ id: string }[]>`
    SELECT id FROM viby.generation_steering
    WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
      AND generation_id = ${generationId} AND status = 'queued'
    LIMIT 1
  `;
  if (pending) throw new GenerationSteeringPendingError(generationId);
}

function mapToolCall(row: ToolCallRow): ToolCallData {
  return {
    id: row.id,
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    messageId: row.message_id,
    providerCallId: row.provider_call_id,
    name: row.name,
    effect: row.effect,
    arguments: row.arguments,
    result: row.result,
    status: row.status,
    error: row.error,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function normalizeToolCallText(value: string, label: string, maxLength: number): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConfigurationError(`The ${label} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

function normalizeGenerationCheckpointState(value: JsonValue): JsonValue {
  const normalized = normalizeAndRedactToolPayload(value);
  if (JSON.stringify(normalized).length > 256_000) {
    throw new ConfigurationError("Generation engine checkpoint state cannot exceed 256 KB.");
  }
  return normalized;
}

function normalizeGenerationCheckpointCursor(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_000) {
    throw new ConfigurationError(
      "Generation engine checkpoint cursors must contain between 1 and 2000 characters.",
    );
  }
  return value;
}

function mapGenerationEngineCheckpoint(
  row: GenerationEngineCheckpointRow,
): GenerationEngineCheckpointData {
  return {
    generationId: row.generation_id,
    attemptId: row.attempt_id,
    revision: row.revision,
    cursor: row.cursor,
    state: row.state,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSandboxLease<Framework extends FrameworkId>(
  row: SandboxLeaseRow,
): SandboxLeaseData<Framework> {
  return {
    id: row.id,
    sandboxId: row.sandbox_id,
    provider: row.provider,
    context: {
      tenantId: row.tenant_id,
      userId: row.user_id,
      chatId: row.chat_id,
      versionId: row.version_id,
      framework: row.framework as Framework,
    },
    ports: row.ports,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at,
  };
}

function mapPreviewSession<Framework extends FrameworkId>(
  row: PreviewSessionRow,
): PreviewSessionData<Framework> {
  return {
    id: row.id,
    chatId: row.chat_id,
    versionId: row.version_id,
    sandboxLeaseId: row.sandbox_lease_id,
    sandboxProvider: row.sandbox_provider,
    framework: row.framework as Framework,
    port: row.port,
    path: row.path,
    url: row.url,
    status: row.status,
    error: row.error,
    expiresAt: row.expires_at,
    readyAt: row.ready_at,
    stoppedAt: row.stopped_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToolSourceRegistration(row: ToolSourceRegistrationRow): ToolSourceRegistrationData {
  return {
    id: row.id,
    type: row.type,
    name: row.name,
    description: row.description,
    configuration: Object.freeze({ ...row.configuration }),
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapToolSourceAuthorizationSession(
  row: ToolSourceAuthorizationSessionRow,
): ToolSourceAuthorizationSessionData {
  return {
    id: row.id,
    toolSourceId: row.tool_source_id,
    provider: row.provider,
    stateHash: row.state_hash,
    callbackUrl: row.callback_url,
    returnTo: row.return_to,
    scopes: Object.freeze([...row.scopes]),
    sessionSecretRef: row.session_secret_ref,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapToolSourceConnection(row: ToolSourceConnectionRow): StoredToolSourceConnection {
  return {
    id: row.id,
    toolSourceId: row.tool_source_id,
    provider: row.provider,
    account: {
      id: row.external_account_id,
      name: row.external_account_name,
      ...(row.external_account_url ? { url: row.external_account_url } : {}),
      ...(row.external_account_metadata ? { metadata: row.external_account_metadata } : {}),
    },
    secretRef: row.secret_ref,
    status: row.status,
    scopes: Object.freeze([...row.scopes]),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
