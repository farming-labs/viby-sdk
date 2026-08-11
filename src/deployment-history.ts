import type {
  DeploymentData,
  DeploymentEnvironment,
  DeploymentProjectData,
  DeploymentStatus,
} from "./integrations.js";
import type { UserScope } from "./types.js";
import type {
  CreateDeploymentArtifactRecord,
  DeploymentArtifactContent,
  DeploymentArtifactData,
} from "./deployment-preparation.js";

export type DeploymentHistoryStatus = "pending" | DeploymentStatus;

export interface DeploymentProjectLinkData {
  readonly id: string;
  readonly chatId: string;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly providerProjectId: string;
  readonly name: string;
  readonly url: string | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface DeploymentStatusTransitionData {
  readonly id: string;
  readonly deploymentId: string;
  readonly status: DeploymentHistoryStatus;
  readonly url: string | null;
  readonly error: string | null;
  readonly createdAt: Date;
}

export interface DeploymentRecordData {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly projectLinkId: string | null;
  readonly preparationArtifactId: string | null;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly projectTarget: string;
  readonly environment: DeploymentEnvironment;
  readonly providerDeploymentId: string | null;
  readonly providerCreatedAt: Date | null;
  readonly url: string | null;
  readonly status: DeploymentHistoryStatus;
  readonly error: string | null;
  readonly idempotencyKey: string;
  readonly transitions: readonly DeploymentStatusTransitionData[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly completedAt: Date | null;
}

export interface BeginDeploymentRecord {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly projectTarget: string;
  readonly environment: DeploymentEnvironment;
  readonly idempotencyKey: string;
  readonly now: Date;
}

export interface CompleteDeploymentRecord {
  readonly id: string;
  readonly project: DeploymentProjectData;
  readonly deployment: DeploymentData;
  readonly observedAt: Date;
}

export interface FailDeploymentRecord {
  readonly id: string;
  readonly error: string;
  readonly observedAt: Date;
}

export interface ObserveDeploymentRecord {
  readonly integrationId: string;
  readonly connectionId: string;
  readonly provider: string;
  readonly deployment: DeploymentData;
  readonly observedAt: Date;
}

export interface DeploymentHistoryStore {
  beginDeployment(scope: UserScope, input: BeginDeploymentRecord): Promise<DeploymentRecordData>;
  completeDeployment(
    scope: UserScope,
    input: CompleteDeploymentRecord,
  ): Promise<DeploymentRecordData>;
  failDeployment(scope: UserScope, input: FailDeploymentRecord): Promise<DeploymentRecordData>;
  observeDeployment(
    scope: UserScope,
    input: ObserveDeploymentRecord,
  ): Promise<DeploymentRecordData | null>;
  listDeploymentProjects(
    scope: UserScope,
    chatId: string,
  ): Promise<DeploymentProjectLinkData[]>;
  listDeployments(
    scope: UserScope,
    input: { readonly chatId: string; readonly versionId?: string },
  ): Promise<DeploymentRecordData[]>;
  createDeploymentArtifact(
    scope: UserScope,
    input: CreateDeploymentArtifactRecord,
  ): Promise<DeploymentArtifactData>;
  getDeploymentArtifact(
    scope: UserScope,
    deploymentId: string,
    artifactId: string,
  ): Promise<DeploymentArtifactContent | null>;
}
