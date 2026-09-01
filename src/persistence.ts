/**
 * Provider-neutral durable state boundary used by Viby.
 *
 * An adapter owns transactional behavior, tenant isolation, durable cursors,
 * and binary artifact references. PostgreSQL remains the built-in default.
 */
export type {
  Repository as PersistenceAdapter,
  AppendGenerationEventRecord,
  ChatReadSnapshot,
  ChatReadSnapshotOptions,
  ChatPageCursor,
  ClaimGenerationAttemptRecord,
  ClearGenerationEngineCheckpointRecord,
  ClaimOutboundEventDeliveryRecord,
  CompleteGenerationRecord,
  CompleteToolCallRecord,
  CreateAttachmentRecord,
  CreateProjectArtifactRecord,
  CreateProviderRequestAttributionRecord,
  CreateAttemptRecord,
  CreatedGeneration,
  CreatedToolCall,
  CreateDesignEvaluationRecord,
  CreateGeneratedArtifactRecord,
  CreateVisualArtifactRecord,
  CreateGenerationRecord,
  CreateGenerationSteeringRecord,
  ConsumeGenerationSteeringRecord,
  SaveGenerationEngineCheckpointRecord,
  CreateSourceVersionRecord,
  CreateToolCallRecord,
  DeleteChatRecord,
  DesignEvaluationPageCursor,
  FailOutboundEventDeliveryRecord,
  FailToolCallRecord,
  ForkVersionRecord,
  GenerationWorkerLease,
  ImportedChat,
  ImportChatRecord,
  MessagePageCursor,
  OutboundEventDeliveryClaim,
  PauseGenerationRecord,
  RepositoryPage as PersistencePage,
  ResolveGenerationTaskRecord,
  RestoreVersionRecord,
  UpdateChatRecord,
  VersionPageCursor,
} from "./repository.js";
export type {
  BeginRepositoryPushRecord,
  CompleteRepositoryPushRecord,
  FailRepositoryPushRecord,
  RepositoryLinkData,
  RepositoryPushData,
  RepositoryPushStatus,
} from "./repository-history.js";
export type {
  BeginDeploymentRecord,
  CompleteDeploymentRecord,
  DeploymentHistoryStatus,
  DeploymentHistoryStore,
  DeploymentProjectLinkData,
  DeploymentRecordData,
  DeploymentStatusTransitionData,
  FailDeploymentRecord,
  ObserveDeploymentRecord,
} from "./deployment-history.js";
export type {
  CreateDeploymentArtifactRecord,
  DeploymentArtifactCommand,
  DeploymentArtifactContent,
  DeploymentArtifactData,
} from "./deployment-preparation.js";
export type {
  CreatePreviewSessionRecord,
  PreviewSessionData,
  PreviewSessionListOptions,
  PreviewSessionStore,
  PreviewStatus,
} from "./preview.js";
export type {
  CreateToolSourceRegistrationRecord,
  ToolSourceRegistrationData,
  ToolSourceRegistrationListOptions,
  ToolSourceRegistrationStatus,
  ToolSourceRegistryStore,
  UpdateToolSourceRegistrationRecord,
} from "./tool-source-registry.js";
export type {
  CreateToolSourceAuthorizationSessionRecord,
  StoredToolSourceConnection,
  ToolSourceAuthorizationSessionData,
  ToolSourceAuthorizationStore,
  UpdateToolSourceConnectionRecord,
  UpsertToolSourceConnectionRecord,
} from "./tool-source-authorization.js";
