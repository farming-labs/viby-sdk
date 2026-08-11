import { ConfigurationError } from "./errors.js";
import type { JsonValue, UserScope } from "./types.js";

export type IntegrationCategory = "repository" | "deployment";

export interface IntegrationIdentity {
  /** Stable provider identifier such as `github`, `bitbucket`, `vercel`, or `cloudflare`. */
  readonly provider: string;
  /** Human-readable provider name used by provider-selection interfaces. */
  readonly displayName: string;
}

export interface IntegrationPage<Item> {
  readonly items: readonly Item[];
  readonly nextCursor: string | null;
}

export interface IntegrationOperationContext extends UserScope {
  readonly connectionId: string;
  readonly externalAccount: IntegrationExternalAccount;
  /** Opaque provider credential. It is supplied only to the adapter handling the operation. */
  readonly credential: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface IntegrationAuthorizationContext extends UserScope {
  readonly signal?: AbortSignal;
}

export interface IntegrationExternalAccount {
  readonly id: string;
  readonly name: string;
  readonly url?: string;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface IntegrationCredential {
  /** Provider-owned opaque bytes persisted only through Viby's secret-store boundary. */
  readonly secret: Uint8Array;
  readonly expiresAt: Date | null;
  readonly scopes: readonly string[];
}

export interface IntegrationAuthorizationStartInput {
  readonly callbackUrl: string;
  /** Single-use state generated and verified by Viby. */
  readonly state: string;
  readonly scopes?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface IntegrationAuthorizationRequest {
  readonly url: string;
  readonly expiresAt: Date | null;
  /** Opaque PKCE or provider state persisted with the authorization session. */
  readonly session?: Uint8Array;
}

export interface IntegrationAuthorizationCompleteInput {
  readonly callbackUrl: string;
  readonly session?: Uint8Array;
  readonly signal?: AbortSignal;
}

export interface IntegrationAuthorizationResult {
  readonly account: IntegrationExternalAccount;
  readonly credential: IntegrationCredential;
}

export interface IntegrationConnectionAdapter {
  startAuthorization(
    input: IntegrationAuthorizationStartInput,
    context: IntegrationAuthorizationContext,
  ): Promise<IntegrationAuthorizationRequest>;
  completeAuthorization(
    input: IntegrationAuthorizationCompleteInput,
    context: IntegrationAuthorizationContext,
  ): Promise<IntegrationAuthorizationResult>;
  refreshCredential?(
    credential: IntegrationCredential,
    context: IntegrationAuthorizationContext,
  ): Promise<IntegrationCredential>;
  revokeCredential?(
    credential: IntegrationCredential,
    context: IntegrationAuthorizationContext,
  ): Promise<void>;
}

export type RepositoryOwnerKind = "user" | "organization" | "workspace";

export interface RepositoryOwnerData {
  readonly id: string;
  readonly name: string;
  readonly kind: RepositoryOwnerKind;
  readonly avatarUrl: string | null;
}

export type RepositoryVisibility = "private" | "internal" | "public";

export interface RepositoryReference {
  readonly owner: string;
  readonly name: string;
}

export interface RepositoryData extends RepositoryReference {
  readonly id: string;
  readonly defaultBranch: string;
  readonly visibility: RepositoryVisibility;
  readonly url: string;
}

export interface RepositoryBranchData {
  readonly name: string;
  readonly head: string;
  readonly protected: boolean;
}

export interface RepositoryCommitData {
  readonly id: string;
  readonly message: string;
  readonly branch: string;
  readonly url: string | null;
}

export type RepositoryPullRequestStatus = "draft" | "open" | "closed" | "merged";

export interface RepositoryPullRequestData {
  readonly id: string;
  readonly number: number;
  readonly title: string;
  readonly head: string;
  readonly base: string;
  readonly status: RepositoryPullRequestStatus;
  readonly url: string;
}

export interface IntegrationSourceFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly mediaType?: string;
  readonly executable?: boolean;
}

export type RepositorySourceReference =
  | { readonly branch: string }
  | { readonly tag: string }
  | { readonly commit: string };

export interface ReadRepositorySourceInput {
  readonly repository: RepositoryReference;
  readonly ref: RepositorySourceReference;
}

export interface RepositorySourceData {
  readonly repository: RepositoryData;
  readonly ref: RepositorySourceReference;
  readonly commit: string;
  readonly files: readonly IntegrationSourceFile[];
}

export interface ListRepositoryOwnersInput {
  readonly cursor?: string;
  readonly limit?: number;
}

export interface ListRepositoriesInput extends ListRepositoryOwnersInput {
  readonly owner?: string;
  readonly search?: string;
}

export interface CreateRepositoryInput {
  readonly owner: string;
  readonly name: string;
  readonly description?: string;
  readonly visibility?: RepositoryVisibility;
}

export interface ListRepositoryBranchesInput extends ListRepositoryOwnersInput {
  readonly repository: RepositoryReference;
}

export interface CreateRepositoryBranchInput {
  readonly repository: RepositoryReference;
  readonly name: string;
  readonly from: string;
}

export interface GetRepositoryBranchInput {
  readonly repository: RepositoryReference;
  readonly name: string;
}

export interface PushRepositoryVersionInput<ProviderOptions = never> {
  readonly repository: RepositoryReference;
  readonly branch: string;
  readonly baseBranch?: string;
  readonly createBranch?: boolean;
  readonly expectedHead?: string;
  readonly message: string;
  /** Complete immutable source snapshot. Missing remote paths are removed from the new tree. */
  readonly files: readonly IntegrationSourceFile[];
  readonly providerOptions?: ProviderOptions;
}

export type PushRepositoryVersionResult =
  | {
      readonly status: "pushed";
      readonly commit: RepositoryCommitData;
      readonly changedFiles: number;
    }
  | {
      readonly status: "conflict";
      readonly expectedHead: string | null;
      readonly actualHead: string;
    };

export interface CreateRepositoryPullRequestInput<ProviderOptions = never> {
  readonly repository: RepositoryReference;
  readonly head: string;
  readonly base: string;
  readonly title: string;
  readonly body?: string;
  readonly draft?: boolean;
  readonly providerOptions?: ProviderOptions;
}

export interface MergeRepositoryPullRequestInput<ProviderOptions = never> {
  readonly repository: RepositoryReference;
  readonly number: number;
  readonly method?: "merge" | "squash" | "rebase";
  readonly expectedHead?: string;
  readonly idempotencyKey: string;
  readonly providerOptions?: ProviderOptions;
}

export interface RepositoryIntegration<
  PushOptions = never,
  PullRequestOptions = never,
  MergeOptions = never,
> extends IntegrationIdentity {
  readonly connection: IntegrationConnectionAdapter;
  listOwners(
    input: ListRepositoryOwnersInput,
    context: IntegrationOperationContext,
  ): Promise<IntegrationPage<RepositoryOwnerData>>;
  listRepositories(
    input: ListRepositoriesInput,
    context: IntegrationOperationContext,
  ): Promise<IntegrationPage<RepositoryData>>;
  getRepository(
    input: RepositoryReference,
    context: IntegrationOperationContext,
  ): Promise<RepositoryData | null>;
  createRepository(
    input: CreateRepositoryInput,
    context: IntegrationOperationContext,
  ): Promise<RepositoryData>;
  listBranches(
    input: ListRepositoryBranchesInput,
    context: IntegrationOperationContext,
  ): Promise<IntegrationPage<RepositoryBranchData>>;
  getBranch(
    input: GetRepositoryBranchInput,
    context: IntegrationOperationContext,
  ): Promise<RepositoryBranchData | null>;
  createBranch(
    input: CreateRepositoryBranchInput,
    context: IntegrationOperationContext,
  ): Promise<RepositoryBranchData>;
  readSource(
    input: ReadRepositorySourceInput,
    context: IntegrationOperationContext,
  ): Promise<RepositorySourceData>;
  pushVersion(
    input: PushRepositoryVersionInput<PushOptions>,
    context: IntegrationOperationContext,
  ): Promise<PushRepositoryVersionResult>;
  createPullRequest(
    input: CreateRepositoryPullRequestInput<PullRequestOptions>,
    context: IntegrationOperationContext,
  ): Promise<RepositoryPullRequestData>;
  mergePullRequest?(
    input: MergeRepositoryPullRequestInput<MergeOptions>,
    context: IntegrationOperationContext,
  ): Promise<RepositoryPullRequestData>;
}

export type DeploymentEnvironment = "preview" | "production" | (string & {});
export type DeploymentStatus =
  | "queued"
  | "building"
  | "ready"
  | "failed"
  | "cancelled";

export interface DeploymentProjectData {
  readonly id: string;
  readonly name: string;
  readonly url: string | null;
}

export interface DeploymentData {
  readonly id: string;
  readonly projectId: string;
  readonly environment: DeploymentEnvironment;
  readonly status: DeploymentStatus;
  readonly url: string | null;
  readonly createdAt: Date;
}

export interface ListDeploymentProjectsInput {
  readonly search?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface CreateDeploymentProjectInput<ProviderOptions = never> {
  readonly name: string;
  readonly providerOptions?: ProviderOptions;
}

export interface DeployVersionInput<ProviderOptions = never> {
  readonly project: string;
  readonly environment: DeploymentEnvironment;
  readonly files: readonly IntegrationSourceFile[];
  readonly idempotencyKey: string;
  readonly providerOptions?: ProviderOptions;
}

export interface GetDeploymentInput {
  readonly id: string;
}

export interface CancelDeploymentInput {
  readonly id: string;
  readonly idempotencyKey: string;
}

export interface DeploymentIntegration<
  ProjectOptions = never,
  DeployOptions = never,
> extends IntegrationIdentity {
  readonly connection: IntegrationConnectionAdapter;
  listProjects(
    input: ListDeploymentProjectsInput,
    context: IntegrationOperationContext,
  ): Promise<IntegrationPage<DeploymentProjectData>>;
  getProject(
    input: { readonly id?: string; readonly name?: string },
    context: IntegrationOperationContext,
  ): Promise<DeploymentProjectData | null>;
  createProject(
    input: CreateDeploymentProjectInput<ProjectOptions>,
    context: IntegrationOperationContext,
  ): Promise<DeploymentProjectData>;
  deployVersion(
    input: DeployVersionInput<DeployOptions>,
    context: IntegrationOperationContext,
  ): Promise<DeploymentData>;
  getDeployment(
    input: GetDeploymentInput,
    context: IntegrationOperationContext,
  ): Promise<DeploymentData | null>;
  cancelDeployment?(
    input: CancelDeploymentInput,
    context: IntegrationOperationContext,
  ): Promise<DeploymentData>;
}

export type RepositoryIntegrationMap = Readonly<Record<string, RepositoryIntegration<any, any, any>>>;
export type DeploymentIntegrationMap = Readonly<Record<string, DeploymentIntegration<any, any>>>;

export interface VibyIntegrations {
  readonly repository?: RepositoryIntegrationMap;
  readonly deployment?: DeploymentIntegrationMap;
}

export interface ConfiguredIntegration {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly provider: string;
  readonly displayName: string;
}

/** Validates and lists configured integration aliases without opening provider connections. */
export function configuredIntegrations(
  integrations: VibyIntegrations | undefined,
): readonly ConfiguredIntegration[] {
  if (integrations === undefined) return [];
  if (!integrations || typeof integrations !== "object" || Array.isArray(integrations)) {
    throw new ConfigurationError("integrations must be an object grouped by capability category.");
  }
  const unexpected = Object.keys(integrations).filter(
    (category) => category !== "repository" && category !== "deployment",
  );
  if (unexpected.length > 0) {
    throw new ConfigurationError(`Unknown integration category: ${unexpected[0]}`);
  }
  return Object.freeze([
    ...configuredCategory("repository", integrations.repository),
    ...configuredCategory("deployment", integrations.deployment),
  ]);
}

function configuredCategory(
  category: IntegrationCategory,
  integrations: Readonly<Record<string, IntegrationIdentity>> | undefined,
): readonly ConfiguredIntegration[] {
  if (integrations === undefined) return [];
  if (!integrations || typeof integrations !== "object" || Array.isArray(integrations)) {
    throw new ConfigurationError(`integrations.${category} must be an object keyed by integration id.`);
  }
  return Object.entries(integrations).map(([id, integration]) => {
    const normalizedId = integrationIdentifier(id, `${category} integration id`);
    if (!integration || typeof integration !== "object") {
      throw new ConfigurationError(`Integration ${category}.${normalizedId} must be an adapter object.`);
    }
    assertIntegrationContract(category, normalizedId, integration);
    return Object.freeze({
      id: normalizedId,
      category,
      provider: integrationIdentifier(integration.provider, `${category}.${normalizedId} provider`),
      displayName: integrationDisplayName(integration.displayName, category, normalizedId),
    });
  });
}

function assertIntegrationContract(
  category: IntegrationCategory,
  id: string,
  integration: IntegrationIdentity,
): void {
  const adapter = integration as unknown as Record<string, unknown>;
  const connection = adapter.connection as Record<string, unknown> | undefined;
  if (!connection || typeof connection !== "object") {
    throw new ConfigurationError(`Integration ${category}.${id} must provide a connection adapter.`);
  }
  assertIntegrationMethods(category, id, connection, [
    "startAuthorization",
    "completeAuthorization",
  ], "connection");
  if (category === "repository") {
    assertIntegrationMethods(category, id, adapter, [
      "listOwners",
      "listRepositories",
      "getRepository",
      "createRepository",
      "listBranches",
      "getBranch",
      "createBranch",
      "readSource",
      "pushVersion",
      "createPullRequest",
    ]);
    assertOptionalIntegrationMethod(category, id, adapter, "mergePullRequest");
    return;
  }
  assertIntegrationMethods(category, id, adapter, [
    "listProjects",
    "getProject",
    "createProject",
    "deployVersion",
    "getDeployment",
  ]);
  assertOptionalIntegrationMethod(category, id, adapter, "cancelDeployment");
}

function assertIntegrationMethods(
  category: IntegrationCategory,
  id: string,
  value: Readonly<Record<string, unknown>>,
  methods: readonly string[],
  prefix?: string,
): void {
  for (const method of methods) {
    if (typeof value[method] !== "function") {
      const path = prefix ? `${prefix}.${method}` : method;
      throw new ConfigurationError(`Integration ${category}.${id} must provide ${path}().`);
    }
  }
}

function assertOptionalIntegrationMethod(
  category: IntegrationCategory,
  id: string,
  value: Readonly<Record<string, unknown>>,
  method: string,
): void {
  if (value[method] !== undefined && typeof value[method] !== "function") {
    throw new ConfigurationError(`Integration ${category}.${id} ${method} must be a function.`);
  }
}

function integrationIdentifier(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(normalized)) {
    throw new ConfigurationError(
      `${label} must contain 1-64 letters, numbers, dots, dashes, or underscores.`,
    );
  }
  return normalized;
}

function integrationDisplayName(
  value: string,
  category: IntegrationCategory,
  id: string,
): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.length > 100) {
    throw new ConfigurationError(
      `${category}.${id} displayName must contain between 1 and 100 characters.`,
    );
  }
  return normalized;
}
