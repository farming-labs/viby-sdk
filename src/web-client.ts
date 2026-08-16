import { ConfigurationError } from "./errors.js";
import type {
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  FrameworkId,
  GeneratedArtifactData,
  GenerationAttemptData,
  GenerationData,
  GenerationEvent,
  GenerationEventPage,
  GenerationTaskData,
  GenerationTaskResolution,
  ImportFilePolicy,
  JsonValue,
  MessageData,
  PageOptions,
  SkillGroups,
  SourceChange,
  SourceEntryInput,
  ToolCallData,
  VersionData,
  VersionEntry,
} from "./types.js";
import type {
  ToolSourceRegistrationData,
  ToolSourceRegistrationListOptions,
} from "./tool-source-registry.js";
import type {
  ConnectToolSourceInput,
  ConnectToolSourceResult,
  DisconnectToolSourceResult,
  ToolSourceConnectionData,
} from "./tool-source-authorization.js";
import type { PreviewEvent } from "./preview.js";
import type { PreviewSessionData, PreviewSessionListOptions } from "./preview.js";
import type {
  EnvironmentVariableData,
  ListEnvironmentVariablesInput,
  SetEnvironmentVariableInput,
} from "./environment.js";
import type {
  ConfiguredIntegrationStatus,
  ConnectIntegrationInput,
  ConnectIntegrationResult,
  DisconnectIntegrationResult,
} from "./integration-client.js";
import type {
  CreateDeploymentProjectInput,
  CreateRepositoryBranchInput,
  CreateRepositoryInput,
  DeploymentData,
  DeploymentEnvironment,
  DeploymentProjectData,
  IntegrationPage,
  ListDeploymentProjectsInput,
  ListRepositoriesInput,
  ListRepositoryBranchesInput,
  ListRepositoryOwnersInput,
  RepositoryBranchData,
  RepositoryData,
  RepositoryOwnerData,
} from "./integrations.js";
import type { IntegrationConnectionData } from "./integration-store.js";
import type { PushVersionRepositoryResult } from "./repository-integrations.js";
import type { RepositoryLinkData, RepositoryPushData } from "./repository-history.js";
import type {
  DeploymentProjectLinkData,
  DeploymentRecordData,
} from "./deployment-history.js";

const DEFAULT_BASE_URL = "/api/viby";
const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_RETRY_MS = 1_000;

export type VibyApiJson<Value> =
  Value extends Date ? string
    : Value extends Uint8Array ? never
      : Value extends readonly (infer Item)[] ? readonly VibyApiJson<Item>[]
        : Value extends object ? { readonly [Key in keyof Value]: VibyApiJson<Value[Key]> }
          : Value;

export type VibyApiChat<Framework extends FrameworkId = FrameworkId> = VibyApiJson<
  Omit<ChatData<Framework>, "tenantId" | "userId">
>;
export type VibyApiVersion<Framework extends FrameworkId = FrameworkId> = VibyApiJson<
  VersionData<Framework>
>;
export type VibyApiMessage = VibyApiJson<MessageData>;
export type VibyApiGeneration = VibyApiJson<GenerationData>;
export type VibyApiGenerationAttempt = VibyApiJson<GenerationAttemptData>;
export type VibyApiGenerationTask = VibyApiJson<GenerationTaskData>;
export type VibyApiGenerationEvent = VibyApiJson<GenerationEvent>;
export type VibyApiGeneratedArtifact = VibyApiJson<GeneratedArtifactData>;
export type VibyApiToolCall = VibyApiJson<ToolCallData>;
export type VibyApiToolSource = VibyApiJson<ToolSourceRegistrationData>;
export type VibyApiToolSourceConnection = VibyApiJson<ToolSourceConnectionData>;
export type VibyApiPreviewEvent = VibyApiJson<PreviewEvent>;
export type VibyApiPreview<Framework extends FrameworkId = FrameworkId> = VibyApiJson<
  PreviewSessionData<Framework>
>;
export type VibyApiEnvironmentVariable = VibyApiJson<EnvironmentVariableData>;
export type VibyApiIntegrationConnection = VibyApiJson<IntegrationConnectionData>;
export type VibyWebPreviewStreamEvent<Result extends JsonValue = JsonValue> =
  | VibyApiPreviewEvent
  | { readonly type: "preview.result"; readonly result: Result }
  | { readonly type: "preview.error"; readonly error: string };

export interface VibyWebClientOptions {
  /** Absolute or browser-relative API URL. Defaults to /api/viby. */
  readonly baseUrl?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  readonly credentials?: RequestCredentials;
}

export interface VibyWebRequestOptions {
  readonly signal?: AbortSignal;
}

export interface VibyWebPageOptions extends PageOptions, VibyWebRequestOptions {}

export interface VibyWebListChatsOptions extends VibyWebPageOptions {
  readonly metadata?: ChatMetadata;
}

export interface VibyWebAttachmentInput {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface VibyWebGenerationInput {
  readonly prompt: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly skills?: SkillGroups;
  readonly metadata?: ChatMetadata;
  readonly attachments?: readonly VibyWebAttachmentInput[];
}

export interface VibyWebCreateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
  readonly prompt?: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly skills?: SkillGroups;
  readonly attachments?: readonly VibyWebAttachmentInput[];
}

export interface VibyWebUpdateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
}

export type VibyWebImportProjectSource =
  | {
      readonly type: "files";
      readonly files: readonly SourceEntryInput[];
    }
  | {
      readonly type: "zip";
      readonly bytes: Uint8Array;
    }
  | {
      readonly type: "repository";
      readonly integrationId: string;
      readonly connectionId?: string;
      readonly repository: {
        readonly owner: string;
        readonly name: string;
      };
      readonly ref:
        | { readonly branch: string }
        | { readonly tag: string }
        | { readonly commit: string };
    };

export interface VibyWebImportProjectInput {
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: ChatMetadata;
  readonly filePolicy?: ImportFilePolicy;
  readonly source: VibyWebImportProjectSource;
}

export interface VibyWebApplySourceChangesInput {
  readonly changes: readonly SourceChange[];
  readonly title?: string;
  readonly summary?: string;
}

export interface VibyWebDeleteChatInput {
  readonly retentionMs?: number | null;
}

export type VibyWebForkVersionInput = {
  readonly title?: string;
  readonly summary?: string;
  readonly metadata?: ChatMetadata;
};

export type VibyWebRestoreVersionInput = {
  readonly title?: string;
  readonly summary?: string;
};

export interface VibyWebPushVersionInput {
  readonly integrationId: string;
  readonly connectionId?: string;
  readonly repository: {
    readonly owner: string;
    readonly name: string;
    readonly createIfMissing?: boolean;
    readonly description?: string;
    readonly visibility?: "private" | "internal" | "public";
  };
  readonly branch: string | {
    readonly name: string;
    readonly from?: string;
    readonly createIfMissing?: boolean;
  };
  readonly commit: {
    readonly message: string;
    readonly expectedHead?: string;
  };
  readonly pullRequest?: {
    readonly base: string;
    readonly title: string;
    readonly body?: string;
    readonly draft?: boolean;
    readonly providerOptions?: Readonly<Record<string, JsonValue>>;
  };
  readonly providerOptions?: Readonly<Record<string, JsonValue>>;
  readonly idempotencyKey?: string;
}

export interface VibyWebDeployVersionInput {
  readonly integrationId: string;
  readonly connectionId?: string;
  readonly project: string | { readonly id: string } | {
    readonly name: string;
    readonly createIfMissing?: boolean;
    readonly providerOptions?: Readonly<Record<string, JsonValue>>;
  };
  readonly environment: DeploymentEnvironment;
  readonly providerOptions?: Readonly<Record<string, JsonValue>>;
  readonly idempotencyKey?: string;
}

export interface VibyWebCreateToolSourceInput {
  readonly type: string;
  readonly name: string;
  readonly description?: string | null;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface VibyWebUpdateToolSourceInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly enabled?: boolean;
}

export type VibyWebConnectToolSourceInput = Omit<ConnectToolSourceInput, "signal">;

export interface VibyWebGenerationReference {
  readonly id: string;
  readonly chatId: string;
}

export interface VibyWebChatPage<Framework extends FrameworkId = FrameworkId> {
  readonly chats: readonly VibyApiChat<Framework>[];
  readonly nextCursor: string | null;
}

export interface VibyWebCreateChatResult<Framework extends FrameworkId = FrameworkId> {
  readonly chat: VibyApiChat<Framework>;
  readonly generation?: VibyWebGenerationReference;
}

export interface VibyWebChatDetail<Framework extends FrameworkId = FrameworkId> {
  readonly chat: VibyApiChat<Framework>;
  readonly messages: readonly VibyApiMessage[];
  readonly messagesNextCursor: string | null;
  readonly versions: readonly VibyApiVersion<Framework>[];
  readonly versionsNextCursor: string | null;
}

export interface VibyWebChatDetailOptions extends VibyWebRequestOptions {
  readonly messagesLimit?: number;
  readonly messagesAfter?: string;
  readonly versionsLimit?: number;
  readonly versionsAfter?: string;
}

export interface VibyWebMessagePage {
  readonly messages: readonly VibyApiMessage[];
  readonly nextCursor: string | null;
}

export interface VibyWebVersionPage<Framework extends FrameworkId = FrameworkId> {
  readonly versions: readonly VibyApiVersion<Framework>[];
  readonly nextCursor: string | null;
}

export interface VibyWebVersionDetail<Framework extends FrameworkId = FrameworkId> {
  readonly version: VibyApiVersion<Framework>;
  readonly entries: readonly VibyApiJson<VersionEntry>[];
}

export interface VibyWebImportProjectResult<Framework extends FrameworkId = FrameworkId> {
  readonly chat: VibyApiChat<Framework>;
  readonly version: VibyApiVersion<Framework>;
}

export interface VibyWebForkVersionResult<Framework extends FrameworkId = FrameworkId>
extends VibyWebVersionDetail<Framework> {
  readonly chat: VibyApiChat<Framework>;
}

export interface VibyWebGenerationDetail<Framework extends FrameworkId = FrameworkId> {
  readonly generation: VibyApiGeneration;
  readonly attempts: readonly VibyApiGenerationAttempt[];
  readonly tasks: readonly VibyApiGenerationTask[];
  readonly toolCalls: readonly VibyApiToolCall[];
  readonly artifacts: readonly VibyApiGeneratedArtifact[];
  readonly version: VibyApiVersion<Framework> | null;
}

export interface VibyWebStreamOptions extends VibyWebRequestOptions {
  /** Last durably handled event cursor. Sent as Last-Event-ID on every connection. */
  readonly after?: string;
  /** Consecutive premature disconnects to retry. Defaults to 5. */
  readonly maxReconnects?: number;
  /** Fallback delay when the server has not sent an SSE retry field. */
  readonly retryMs?: number;
}

export interface VibyWebChatsClient<Framework extends FrameworkId = FrameworkId> {
  list(options?: VibyWebListChatsOptions): Promise<VibyWebChatPage<Framework>>;
  create(
    input: VibyWebCreateChatInput & { readonly prompt: string },
    options?: VibyWebRequestOptions,
  ): Promise<VibyWebCreateChatResult<Framework> & { readonly generation: VibyWebGenerationReference }>;
  create(
    input?: VibyWebCreateChatInput,
    options?: VibyWebRequestOptions,
  ): Promise<VibyWebCreateChatResult<Framework>>;
  import(
    input: VibyWebImportProjectInput,
    options?: VibyWebRequestOptions,
  ): Promise<VibyWebImportProjectResult<Framework>>;
  get(chatId: string, options?: VibyWebChatDetailOptions): Promise<VibyWebChatDetail<Framework>>;
  update(
    chatId: string,
    input: VibyWebUpdateChatInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly chat: VibyApiChat<Framework> }>;
  delete(
    chatId: string,
    input?: VibyWebDeleteChatInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly deletion: VibyApiJson<ChatDeletionData> }>;
  restore(
    chatId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly chat: VibyApiChat<Framework> }>;
  repositoryLinks(
    chatId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly links: readonly VibyApiJson<RepositoryLinkData>[] }>;
  repositoryPushes(
    chatId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly pushes: readonly VibyApiJson<RepositoryPushData>[] }>;
  deploymentProjects(
    chatId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly projects: readonly VibyApiJson<DeploymentProjectLinkData>[] }>;
  deployments(
    chatId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly deployments: readonly VibyApiJson<DeploymentRecordData>[] }>;
  readonly environment: {
    list(
      chatId: string,
      input?: ListEnvironmentVariablesInput & VibyWebRequestOptions,
    ): Promise<{ readonly variables: readonly VibyApiEnvironmentVariable[] }>;
    set(
      chatId: string,
      input: SetEnvironmentVariableInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly variable: VibyApiEnvironmentVariable }>;
    delete(
      chatId: string,
      environment: string,
      name: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly deleted: boolean }>;
  };
  readonly messages: {
    list(chatId: string, options?: VibyWebPageOptions): Promise<VibyWebMessagePage>;
    get(
      chatId: string,
      messageId: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly message: VibyApiMessage }>;
    create(
      chatId: string,
      input: VibyWebGenerationInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly generation: VibyWebGenerationReference }>;
  };
  readonly versions: {
    list(chatId: string, options?: VibyWebPageOptions): Promise<VibyWebVersionPage<Framework>>;
    get(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<VibyWebVersionDetail<Framework>>;
    changes(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly changes: readonly SourceChange[] }>;
    apply(
      chatId: string,
      versionId: string,
      input: VibyWebApplySourceChangesInput,
      options?: VibyWebRequestOptions,
    ): Promise<VibyWebVersionDetail<Framework>>;
    restore(
      chatId: string,
      versionId: string,
      input?: VibyWebRestoreVersionInput,
      options?: VibyWebRequestOptions,
    ): Promise<VibyWebVersionDetail<Framework>>;
    fork(
      chatId: string,
      versionId: string,
      input?: VibyWebForkVersionInput,
      options?: VibyWebRequestOptions,
    ): Promise<VibyWebForkVersionResult<Framework>>;
    repositoryPushes(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly pushes: readonly VibyApiJson<RepositoryPushData>[] }>;
    push(
      chatId: string,
      versionId: string,
      input: VibyWebPushVersionInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly result: VibyApiJson<PushVersionRepositoryResult> }>;
    deployments(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly deployments: readonly VibyApiJson<DeploymentRecordData>[] }>;
    deploy(
      chatId: string,
      versionId: string,
      input: VibyWebDeployVersionInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly deployment: VibyApiJson<DeploymentData> }>;
    iterate(
      chatId: string,
      versionId: string,
      input: VibyWebGenerationInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly generation: VibyWebGenerationReference }>;
    download(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<Response>;
    preview<Result extends JsonValue = JsonValue>(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<Result>;
    previewStream<Result extends JsonValue = JsonValue>(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): AsyncGenerator<VibyWebPreviewStreamEvent<Result>>;
  };
  readonly toolSources: {
    list(
      chatId: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly toolSources: readonly VibyApiToolSource[] }>;
    set(
      chatId: string,
      sourceIds: readonly string[],
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly toolSources: readonly VibyApiToolSource[] }>;
  };
}

export interface VibyWebGenerationsClient<Framework extends FrameworkId = FrameworkId> {
  get(generationId: string, options?: VibyWebRequestOptions): Promise<VibyWebGenerationDetail<Framework>>;
  events(
    generationId: string,
    options?: VibyWebPageOptions,
  ): Promise<VibyApiJson<GenerationEventPage>>;
  stream(
    generationId: string,
    options?: VibyWebStreamOptions,
  ): AsyncGenerator<VibyApiGenerationEvent>;
  cancel(
    generationId: string,
    reason?: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
  retry(
    generationId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
  resume(
    generationId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
  resolveTask(
    generationId: string,
    taskId: string,
    resolution: GenerationTaskResolution,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
}

export interface VibyWebToolSourcesClient {
  list(
    options?: ToolSourceRegistrationListOptions & VibyWebRequestOptions,
  ): Promise<{ readonly toolSources: readonly VibyApiToolSource[] }>;
  create(
    input: VibyWebCreateToolSourceInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly toolSource: VibyApiToolSource }>;
  get(
    sourceId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly toolSource: VibyApiToolSource }>;
  update(
    sourceId: string,
    input: VibyWebUpdateToolSourceInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly toolSource: VibyApiToolSource }>;
  archive(
    sourceId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly toolSource: VibyApiToolSource }>;
  connection(
    sourceId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly connection: VibyApiToolSourceConnection | null }>;
  connect(
    sourceId: string,
    input: VibyWebConnectToolSourceInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly result: VibyApiJson<ConnectToolSourceResult> }>;
  disconnect(
    sourceId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly result: VibyApiJson<DisconnectToolSourceResult> }>;
}

export interface VibyWebClient<Framework extends FrameworkId = FrameworkId> {
  readonly chats: VibyWebChatsClient<Framework>;
  readonly generations: VibyWebGenerationsClient<Framework>;
  readonly previews: VibyWebPreviewsClient<Framework>;
  readonly integrations: VibyWebIntegrationsClient;
  readonly toolSources: VibyWebToolSourcesClient;
}

export interface VibyWebPreviewsClient<Framework extends FrameworkId = FrameworkId> {
  list(
    input?: PreviewSessionListOptions & VibyWebRequestOptions,
  ): Promise<{ readonly previews: readonly VibyApiPreview<Framework>[] }>;
  get(
    previewId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly preview: VibyApiPreview<Framework> }>;
  stop(
    previewId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly preview: VibyApiPreview<Framework> }>;
  reconnect(
    previewId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly preview: VibyApiPreview<Framework> }>;
  cleanup(
    limit?: number,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly cleaned: number }>;
}

export interface VibyWebIntegrationCategoryClient {
  list(options?: VibyWebRequestOptions): Promise<{
    readonly integrations: readonly VibyApiJson<ConfiguredIntegrationStatus>[];
  }>;
  connections(integrationId: string, options?: VibyWebRequestOptions): Promise<{
    readonly connections: readonly VibyApiIntegrationConnection[];
  }>;
  connect(
    integrationId: string,
    input: Omit<ConnectIntegrationInput, "signal">,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly result: VibyApiJson<ConnectIntegrationResult> }>;
  disconnect(
    integrationId: string,
    connectionId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly result: VibyApiJson<DisconnectIntegrationResult> }>;
}

export interface VibyWebRepositoryIntegrationsClient extends VibyWebIntegrationCategoryClient {
  owners(
    integrationId: string,
    input?: ListRepositoryOwnersInput & { readonly connectionId?: string } & VibyWebRequestOptions,
  ): Promise<VibyApiJson<IntegrationPage<RepositoryOwnerData>>>;
  repositories(
    integrationId: string,
    input?: ListRepositoriesInput & { readonly connectionId?: string } & VibyWebRequestOptions,
  ): Promise<VibyApiJson<IntegrationPage<RepositoryData>>>;
  createRepository(
    integrationId: string,
    input: CreateRepositoryInput,
    options?: VibyWebRequestOptions & { readonly connectionId?: string },
  ): Promise<{ readonly repository: VibyApiJson<RepositoryData> }>;
  branches(
    integrationId: string,
    input: ListRepositoryBranchesInput & { readonly connectionId?: string } & VibyWebRequestOptions,
  ): Promise<VibyApiJson<IntegrationPage<RepositoryBranchData>>>;
  createBranch(
    integrationId: string,
    input: CreateRepositoryBranchInput,
    options?: VibyWebRequestOptions & { readonly connectionId?: string },
  ): Promise<{ readonly branch: VibyApiJson<RepositoryBranchData> }>;
}

export interface VibyWebDeploymentIntegrationsClient extends VibyWebIntegrationCategoryClient {
  projects(
    integrationId: string,
    input?: ListDeploymentProjectsInput & { readonly connectionId?: string } & VibyWebRequestOptions,
  ): Promise<VibyApiJson<IntegrationPage<DeploymentProjectData>>>;
  createProject(
    integrationId: string,
    input: CreateDeploymentProjectInput<Record<string, JsonValue>>,
    options?: VibyWebRequestOptions & { readonly connectionId?: string },
  ): Promise<{ readonly project: VibyApiJson<DeploymentProjectData> }>;
  getDeployment(
    integrationId: string,
    deploymentId: string,
    options?: VibyWebRequestOptions & { readonly connectionId?: string },
  ): Promise<{ readonly deployment: VibyApiJson<DeploymentData | null> }>;
  cancelDeployment(
    integrationId: string,
    deploymentId: string,
    idempotencyKey: string,
    options?: VibyWebRequestOptions & { readonly connectionId?: string },
  ): Promise<{ readonly deployment: VibyApiJson<DeploymentData> }>;
}

export interface VibyWebIntegrationsClient {
  readonly repository: VibyWebRepositoryIntegrationsClient;
  readonly deployment: VibyWebDeploymentIntegrationsClient;
}

export class VibyApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "VibyApiClientError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class VibyStreamDisconnectedError extends Error {
  readonly cursor: string | undefined;
  readonly reconnects: number;

  constructor(cursor: string | undefined, reconnects: number, options?: ErrorOptions) {
    super(`Generation event stream disconnected after ${reconnects} reconnect attempts.`, options);
    this.name = "VibyStreamDisconnectedError";
    this.cursor = cursor;
    this.reconnects = reconnects;
  }
}

export class VibyStreamProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VibyStreamProtocolError";
  }
}

/** A browser-, Worker-, Bun-, and Node-compatible client for createVibyApi(). */
export function createVibyWebClient<Framework extends FrameworkId = FrameworkId>(
  options: VibyWebClientOptions = {},
): VibyWebClient<Framework> {
  const transport = new WebClientTransport(options);
  const createChat = (input: VibyWebCreateChatInput = {}, request: VibyWebRequestOptions = {}) => (
    transport.json<VibyWebCreateChatResult<Framework>>(
      "POST",
      "/chats",
      generationBody(input),
      undefined,
      request,
    )
  );
  const chats: VibyWebChatsClient<Framework> = {
    list: (input = {}) => transport.json<VibyWebChatPage<Framework>>(
      "GET",
      "/chats",
      undefined,
      input,
      input,
    ),
    create: createChat as VibyWebChatsClient<Framework>["create"],
    import: (input, request = {}) => transport.json(
      "POST",
      "/chats/imports",
      importProjectBody(input),
      undefined,
      request,
    ),
    get: (chatId, input = {}) => transport.json(
      "GET",
      `/chats/${segment(chatId)}`,
      undefined,
      input,
      input,
    ),
    update: (chatId, input, request = {}) => transport.json(
      "PATCH",
      `/chats/${segment(chatId)}`,
      input,
      undefined,
      request,
    ),
    delete: (chatId, input = {}, request = {}) => transport.json(
      "DELETE",
      `/chats/${segment(chatId)}`,
      input,
      undefined,
      request,
    ),
    restore: (chatId, request = {}) => transport.json(
      "POST",
      `/chats/${segment(chatId)}/restore`,
      {},
      undefined,
      request,
    ),
    repositoryLinks: (chatId, request = {}) => transport.json(
      "GET",
      `/chats/${segment(chatId)}/repository-links`,
      undefined,
      undefined,
      request,
    ),
    repositoryPushes: (chatId, request = {}) => transport.json(
      "GET",
      `/chats/${segment(chatId)}/repository-pushes`,
      undefined,
      undefined,
      request,
    ),
    deploymentProjects: (chatId, request = {}) => transport.json(
      "GET",
      `/chats/${segment(chatId)}/deployment-projects`,
      undefined,
      undefined,
      request,
    ),
    deployments: (chatId, request = {}) => transport.json(
      "GET",
      `/chats/${segment(chatId)}/deployments`,
      undefined,
      undefined,
      request,
    ),
    environment: Object.freeze({
      list: (chatId: string, input = {}) => transport.json(
        "GET",
        `/chats/${segment(chatId)}/environment`,
        undefined,
        input,
        input,
      ),
      set: (chatId: string, input: SetEnvironmentVariableInput, request = {}) => transport.json(
        "PUT",
        `/chats/${segment(chatId)}/environment/${segment(input.environment)}/${segment(input.name)}`,
        { value: input.value, ...(input.secret === undefined ? {} : { secret: input.secret }) },
        undefined,
        request,
      ),
      delete: (chatId: string, environment: string, name: string, request = {}) => transport.json(
        "DELETE",
        `/chats/${segment(chatId)}/environment/${segment(environment)}/${segment(name)}`,
        undefined,
        undefined,
        request,
      ),
    }),
    messages: Object.freeze({
      list: (chatId: string, input: VibyWebPageOptions = {}) => transport.json<VibyWebMessagePage>(
        "GET",
        `/chats/${segment(chatId)}/messages`,
        undefined,
        input,
        input,
      ),
      get: (chatId: string, messageId: string, request: VibyWebRequestOptions = {}) => (
        transport.json<{ readonly message: VibyApiMessage }>(
          "GET",
          `/chats/${segment(chatId)}/messages/${segment(messageId)}`,
          undefined,
          undefined,
          request,
        )
      ),
      create: (chatId: string, input: VibyWebGenerationInput, request: VibyWebRequestOptions = {}) => (
        transport.json<{ readonly generation: VibyWebGenerationReference }>(
          "POST",
          `/chats/${segment(chatId)}/messages`,
          generationBody(input),
          undefined,
          request,
        )
      ),
    }),
    versions: {
      list: (chatId: string, input: VibyWebPageOptions = {}) => transport.json<VibyWebVersionPage<Framework>>(
        "GET",
        `/chats/${segment(chatId)}/versions`,
        undefined,
        input,
        input,
      ),
      get: (chatId: string, versionId: string, request: VibyWebRequestOptions = {}) => (
        transport.json<VibyWebVersionDetail<Framework>>(
          "GET",
          `/chats/${segment(chatId)}/versions/${segment(versionId)}`,
          undefined,
          undefined,
          request,
        )
      ),
      changes: (chatId: string, versionId: string, request: VibyWebRequestOptions = {}) => (
        transport.json<{ readonly changes: readonly SourceChange[] }>(
          "GET",
          `/chats/${segment(chatId)}/versions/${segment(versionId)}/changes`,
          undefined,
          undefined,
          request,
        )
      ),
      apply: (
        chatId: string,
        versionId: string,
        input: VibyWebApplySourceChangesInput,
        request: VibyWebRequestOptions = {},
      ) => transport.json<VibyWebVersionDetail<Framework>>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/changes`,
        input,
        undefined,
        request,
      ),
      restore: (
        chatId: string,
        versionId: string,
        input: VibyWebRestoreVersionInput = {},
        request: VibyWebRequestOptions = {},
      ) => transport.json<VibyWebVersionDetail<Framework>>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/restore`,
        input,
        undefined,
        request,
      ),
      fork: (
        chatId: string,
        versionId: string,
        input: VibyWebForkVersionInput = {},
        request: VibyWebRequestOptions = {},
      ) => transport.json<VibyWebForkVersionResult<Framework>>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/fork`,
        input,
        undefined,
        request,
      ),
      repositoryPushes: (chatId: string, versionId: string, request = {}) => transport.json<{
        readonly pushes: readonly VibyApiJson<RepositoryPushData>[];
      }>(
        "GET",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/repository-pushes`,
        undefined,
        undefined,
        request,
      ),
      push: (
        chatId: string,
        versionId: string,
        input: VibyWebPushVersionInput,
        request: VibyWebRequestOptions = {},
      ) => transport.json<{ readonly result: VibyApiJson<PushVersionRepositoryResult> }>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/repository-pushes`,
        input,
        undefined,
        request,
      ),
      deployments: (chatId: string, versionId: string, request = {}) => transport.json<{
        readonly deployments: readonly VibyApiJson<DeploymentRecordData>[];
      }>(
        "GET",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/deployments`,
        undefined,
        undefined,
        request,
      ),
      deploy: (
        chatId: string,
        versionId: string,
        input: VibyWebDeployVersionInput,
        request: VibyWebRequestOptions = {},
      ) => transport.json<{ readonly deployment: VibyApiJson<DeploymentData> }>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/deployments`,
        input,
        undefined,
        request,
      ),
      iterate: (
        chatId: string,
        versionId: string,
        input: VibyWebGenerationInput,
        request: VibyWebRequestOptions = {},
      ) => transport.json<{ readonly generation: VibyWebGenerationReference }>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/messages`,
        generationBody(input),
        undefined,
        request,
      ),
      download: (chatId: string, versionId: string, request: VibyWebRequestOptions = {}) => (
        transport.response(
          "GET",
          `/chats/${segment(chatId)}/versions/${segment(versionId)}/download`,
          undefined,
          undefined,
          request,
        )
      ),
      preview: <Result extends JsonValue = JsonValue>(
        chatId: string,
        versionId: string,
        request: VibyWebRequestOptions = {},
      ) => transport.json<Result>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/preview`,
        undefined,
        undefined,
        request,
      ),
      previewStream: <Result extends JsonValue = JsonValue>(
        chatId: string,
        versionId: string,
        request: VibyWebRequestOptions = {},
      ) => previewStream<Result>(transport, chatId, versionId, request),
    },
    toolSources: Object.freeze({
      list: (chatId: string, request: VibyWebRequestOptions = {}) => transport.json<{
        readonly toolSources: readonly VibyApiToolSource[];
      }>(
        "GET",
        `/chats/${segment(chatId)}/tool-sources`,
        undefined,
        undefined,
        request,
      ),
      set: (chatId: string, sourceIds: readonly string[], request: VibyWebRequestOptions = {}) => (
        transport.json<{ readonly toolSources: readonly VibyApiToolSource[] }>(
          "PUT",
          `/chats/${segment(chatId)}/tool-sources`,
          { sourceIds },
          undefined,
          request,
        )
      ),
    }),
  };
  const generations: VibyWebGenerationsClient<Framework> = {
    get: (generationId, request = {}) => transport.json(
      "GET",
      `/generations/${segment(generationId)}`,
      undefined,
      undefined,
      request,
    ),
    events: (generationId, input = {}) => transport.json(
      "GET",
      `/generations/${segment(generationId)}/events/page`,
      undefined,
      input,
      input,
    ),
    stream: (generationId, input = {}) => generationStream(transport, generationId, input),
    cancel: (generationId, reason, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/cancel`,
      reason === undefined ? {} : { reason },
      undefined,
      request,
    ),
    retry: (generationId, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/retry`,
      {},
      undefined,
      request,
    ),
    resume: (generationId, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/resume`,
      {},
      undefined,
      request,
    ),
    resolveTask: (generationId, taskId, resolution, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/tasks/${segment(taskId)}`,
      { resolution },
      undefined,
      request,
    ),
  };
  const previews: VibyWebPreviewsClient<Framework> = {
    list: (input = {}) => transport.json(
      "GET",
      "/previews",
      undefined,
      input,
      input,
    ),
    get: (previewId, request = {}) => transport.json(
      "GET",
      `/previews/${segment(previewId)}`,
      undefined,
      undefined,
      request,
    ),
    stop: (previewId, request = {}) => transport.json(
      "DELETE",
      `/previews/${segment(previewId)}`,
      undefined,
      undefined,
      request,
    ),
    reconnect: (previewId, request = {}) => transport.json(
      "POST",
      `/previews/${segment(previewId)}/reconnect`,
      {},
      undefined,
      request,
    ),
    cleanup: (limit, request = {}) => transport.json(
      "POST",
      "/previews/cleanup",
      limit === undefined ? {} : { limit },
      undefined,
      request,
    ),
  };
  const integrationCategory = (
    category: "repository" | "deployment",
  ): VibyWebIntegrationCategoryClient => ({
    list: (request = {}) => transport.json(
      "GET",
      `/integrations/${category}`,
      undefined,
      undefined,
      request,
    ),
    connections: (integrationId, request = {}) => transport.json(
      "GET",
      `/integrations/${category}/${segment(integrationId)}/connections`,
      undefined,
      undefined,
      request,
    ),
    connect: (integrationId, input, request = {}) => transport.json(
      "POST",
      `/integrations/${category}/${segment(integrationId)}/connect`,
      input,
      undefined,
      request,
    ),
    disconnect: (integrationId, connectionId, request = {}) => transport.json(
      "DELETE",
      `/integrations/${category}/${segment(integrationId)}/connections/${segment(connectionId)}`,
      undefined,
      undefined,
      request,
    ),
  });
  const repositoryIntegrations: VibyWebRepositoryIntegrationsClient = {
    ...integrationCategory("repository"),
    owners: (integrationId, input = {}) => transport.json(
      "GET",
      `/integrations/repository/${segment(integrationId)}/owners`,
      undefined,
      input,
      input,
    ),
    repositories: (integrationId, input = {}) => transport.json(
      "GET",
      `/integrations/repository/${segment(integrationId)}/repositories`,
      undefined,
      input,
      input,
    ),
    createRepository: (integrationId, input, request = {}) => transport.json(
      "POST",
      `/integrations/repository/${segment(integrationId)}/repositories`,
      input,
      request,
      request,
    ),
    branches: (integrationId, input) => transport.json(
      "GET",
      `/integrations/repository/${segment(integrationId)}/branches`,
      undefined,
      {
        owner: input.repository.owner,
        name: input.repository.name,
        ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
        ...(input.limit === undefined ? {} : { limit: input.limit }),
        ...(input.connectionId === undefined ? {} : { connectionId: input.connectionId }),
      },
      input,
    ),
    createBranch: (integrationId, input, request = {}) => transport.json(
      "POST",
      `/integrations/repository/${segment(integrationId)}/branches`,
      {
        owner: input.repository.owner,
        repository: input.repository.name,
        name: input.name,
        from: input.from,
      },
      request,
      request,
    ),
  };
  const deploymentIntegrations: VibyWebDeploymentIntegrationsClient = {
    ...integrationCategory("deployment"),
    projects: (integrationId, input = {}) => transport.json(
      "GET",
      `/integrations/deployment/${segment(integrationId)}/projects`,
      undefined,
      input,
      input,
    ),
    createProject: (integrationId, input, request = {}) => transport.json(
      "POST",
      `/integrations/deployment/${segment(integrationId)}/projects`,
      input,
      request,
      request,
    ),
    getDeployment: (integrationId, deploymentId, request = {}) => transport.json(
      "GET",
      `/integrations/deployment/${segment(integrationId)}/deployments/${segment(deploymentId)}`,
      undefined,
      request,
      request,
    ),
    cancelDeployment: (
      integrationId,
      deploymentId,
      idempotencyKey,
      request = {},
    ) => transport.json(
      "DELETE",
      `/integrations/deployment/${segment(integrationId)}/deployments/${segment(deploymentId)}`,
      { idempotencyKey },
      request,
      request,
    ),
  };
  const integrations: VibyWebIntegrationsClient = Object.freeze({
    repository: Object.freeze(repositoryIntegrations),
    deployment: Object.freeze(deploymentIntegrations),
  });
  const toolSources: VibyWebToolSourcesClient = {
    list: (input = {}) => transport.json(
      "GET",
      "/tool-sources",
      undefined,
      input,
      input,
    ),
    create: (input, request = {}) => transport.json(
      "POST",
      "/tool-sources",
      input,
      undefined,
      request,
    ),
    get: (sourceId, request = {}) => transport.json(
      "GET",
      `/tool-sources/${segment(sourceId)}`,
      undefined,
      undefined,
      request,
    ),
    update: (sourceId, input, request = {}) => transport.json(
      "PATCH",
      `/tool-sources/${segment(sourceId)}`,
      input,
      undefined,
      request,
    ),
    archive: (sourceId, request = {}) => transport.json(
      "DELETE",
      `/tool-sources/${segment(sourceId)}`,
      undefined,
      undefined,
      request,
    ),
    connection: (sourceId, request = {}) => transport.json(
      "GET",
      `/tool-sources/${segment(sourceId)}/connection`,
      undefined,
      undefined,
      request,
    ),
    connect: (sourceId, input, request = {}) => transport.json(
      "POST",
      `/tool-sources/${segment(sourceId)}/connect`,
      input,
      undefined,
      request,
    ),
    disconnect: (sourceId, request = {}) => transport.json(
      "POST",
      `/tool-sources/${segment(sourceId)}/disconnect`,
      undefined,
      undefined,
      request,
    ),
  };
  return Object.freeze({
    chats: Object.freeze(chats),
    generations: Object.freeze(generations),
    previews: Object.freeze(previews),
    integrations,
    toolSources: Object.freeze(toolSources),
  });
}

class WebClientTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: VibyWebClientOptions["headers"];
  readonly #credentials: RequestCredentials | undefined;

  constructor(options: VibyWebClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    const fetchImplementation = options.fetch ?? globalThis.fetch;
    if (typeof fetchImplementation !== "function") {
      throw new ConfigurationError("createVibyWebClient requires a Web-compatible fetch implementation.");
    }
    this.#fetch = options.fetch ?? fetchImplementation.bind(globalThis);
    this.#headers = options.headers;
    this.#credentials = options.credentials;
  }

  async json<Result>(
    method: string,
    path: string,
    body: unknown,
    query: object | undefined,
    options: VibyWebRequestOptions,
  ): Promise<Result> {
    const response = await this.response(method, path, body, query, options);
    try {
      return await response.json() as Result;
    } catch (error) {
      throw new VibyApiClientError(
        response.status,
        "invalid_response",
        "Viby API returned an invalid JSON response.",
        null,
      );
    }
  }

  async response(
    method: string,
    path: string,
    body: unknown,
    query: object | undefined,
    options: VibyWebRequestOptions,
    headers?: HeadersInit,
  ): Promise<Response> {
    const resolvedHeaders = new Headers(
      typeof this.#headers === "function" ? await this.#headers() : this.#headers,
    );
    for (const [name, value] of new Headers(headers)) resolvedHeaders.set(name, value);
    const init: RequestInit = {
      method,
      headers: resolvedHeaders,
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    if (body !== undefined) {
      resolvedHeaders.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    const response = await this.#fetch(this.url(path, query), init);
    if (!response.ok) throw await apiError(response);
    return response;
  }

  url(path: string, query: object | undefined): string {
    const search = queryString(query);
    return `${this.#baseUrl}${path}${search}`;
  }
}

async function* generationStream(
  transport: WebClientTransport,
  generationId: string,
  options: VibyWebStreamOptions,
): AsyncGenerator<VibyApiGenerationEvent> {
  const maxReconnects = integerOption(options.maxReconnects, "maxReconnects", DEFAULT_MAX_RECONNECTS, 0, 100);
  let retryMs = integerOption(options.retryMs, "retryMs", DEFAULT_RETRY_MS, 0, 60_000);
  let reconnects = 0;
  let cursor = options.after;
  let lastError: unknown;
  while (true) {
    options.signal?.throwIfAborted();
    let received = false;
    try {
      const response = await transport.response(
        "GET",
        `/generations/${segment(generationId)}/events`,
        undefined,
        undefined,
        options,
        {
          Accept: "text/event-stream",
          ...(cursor === undefined ? {} : { "Last-Event-ID": cursor }),
        },
      );
      if (!response.body) throw new VibyStreamProtocolError("Generation event response has no body.");
      for await (const frame of sseFrames(response.body, options.signal)) {
        if (frame.retry !== undefined) retryMs = frame.retry;
        if (frame.data === undefined) continue;
        const event = parseGenerationEvent(frame.data);
        if (frame.id !== undefined && frame.id !== event.cursor) {
          throw new VibyStreamProtocolError("Generation event cursor does not match its SSE id.");
        }
        if (cursor !== undefined && compareCursors(event.cursor, cursor) <= 0) continue;
        cursor = event.cursor;
        received = true;
        reconnects = 0;
        yield event;
        if (isTerminalEvent(event.type)) return;
      }
      lastError = undefined;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof VibyStreamProtocolError) throw error;
      if (error instanceof VibyApiClientError && !isRetryableStatus(error.status)) throw error;
      lastError = error;
    }
    if (!received) reconnects += 1;
    if (reconnects > maxReconnects) {
      throw new VibyStreamDisconnectedError(cursor, reconnects - 1, { cause: lastError });
    }
    await abortableDelay(retryMs, options.signal);
  }
}

async function* previewStream<Result extends JsonValue>(
  transport: WebClientTransport,
  chatId: string,
  versionId: string,
  options: VibyWebRequestOptions,
): AsyncGenerator<VibyWebPreviewStreamEvent<Result>> {
  const response = await transport.response(
    "POST",
    `/chats/${segment(chatId)}/versions/${segment(versionId)}/preview`,
    undefined,
    undefined,
    options,
    { Accept: "text/event-stream" },
  );
  if (!response.body) throw new VibyStreamProtocolError("Preview event response has no body.");
  for await (const frame of sseFrames(response.body, options.signal)) {
    if (frame.data === undefined) continue;
    const event = parsePreviewEvent<Result>(frame.data);
    if (frame.event !== undefined && frame.event !== event.type) {
      throw new VibyStreamProtocolError("Preview event type does not match its SSE event name.");
    }
    yield event;
    if (event.type === "preview.result" || event.type === "preview.error") return;
  }
}

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly retry?: number;
}

async function* sseFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  let data: string[] = [];
  const dispatch = (): SseFrame | null => {
    if (data.length === 0 && id === undefined && event === undefined && retry === undefined) return null;
    const frame: SseFrame = {
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      ...(data.length === 0 ? {} : { data: data.join("\n") }),
      ...(retry === undefined ? {} : { retry }),
    };
    id = undefined;
    event = undefined;
    retry = undefined;
    data = [];
    return frame;
  };
  const consume = (line: string): SseFrame | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id" && !value.includes("\0")) id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    if (field === "retry" && /^\d+$/.test(value)) retry = Math.min(Number(value), 60_000);
    return null;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = consume(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        if (frame) yield frame;
        newline = buffer.indexOf("\n");
      }
      if (result.done) break;
    }
    if (buffer.length > 0) {
      const frame = consume(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      if (frame) yield frame;
    }
    const frame = dispatch();
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

function parseGenerationEvent(data: string): VibyApiGenerationEvent {
  let value: Partial<VibyApiGenerationEvent> | null;
  try {
    value = JSON.parse(data) as Partial<VibyApiGenerationEvent> | null;
  } catch (error) {
    throw new VibyStreamProtocolError("Generation stream returned invalid JSON.", { cause: error });
  }
  if (!value || typeof value !== "object" || typeof value.cursor !== "string"
    || typeof value.type !== "string" || typeof value.generationId !== "string") {
    throw new VibyStreamProtocolError("Generation stream returned an invalid event.");
  }
  return value as VibyApiGenerationEvent;
}

function parsePreviewEvent<Result extends JsonValue>(
  data: string,
): VibyWebPreviewStreamEvent<Result> {
  let value: Partial<VibyWebPreviewStreamEvent<Result>> | null;
  try {
    value = JSON.parse(data) as Partial<VibyWebPreviewStreamEvent<Result>> | null;
  } catch (error) {
    throw new VibyStreamProtocolError("Preview stream returned invalid JSON.", { cause: error });
  }
  if (!value || typeof value !== "object" || typeof value.type !== "string") {
    throw new VibyStreamProtocolError("Preview stream returned an invalid event.");
  }
  if (value.type === "preview.error" && typeof value.error !== "string") {
    throw new VibyStreamProtocolError("Preview stream returned an invalid error event.");
  }
  if (value.type === "preview.result" && !("result" in value)) {
    throw new VibyStreamProtocolError("Preview stream returned an invalid result event.");
  }
  return value as VibyWebPreviewStreamEvent<Result>;
}

function generationBody(input: VibyWebCreateChatInput | VibyWebGenerationInput): object {
  return {
    ...input,
    ...(input.attachments === undefined ? {} : {
      attachments: input.attachments.map((attachment) => ({
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        base64: encodeBase64(attachment.bytes),
      })),
    }),
  };
}

function importProjectBody(input: VibyWebImportProjectInput): object {
  const source = input.source.type === "files"
    ? {
        type: "files" as const,
        files: input.source.files.map((entry) => entry.type === "artifact"
          ? {
              ...entry,
              bytes: undefined,
              base64: encodeBase64(entry.bytes),
            }
          : entry),
      }
    : input.source.type === "zip"
      ? { type: "zip" as const, base64: encodeBase64(input.source.bytes) }
      : input.source;
  return { ...input, source };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeBaseUrl(value: string | URL | undefined): string {
  const url = value === undefined ? DEFAULT_BASE_URL : String(value);
  if (!url.trim() || url.includes("?") || url.includes("#")) {
    throw new ConfigurationError("baseUrl must be a URL without query parameters or a fragment.");
  }
  return url.replace(/\/+$/, "");
}

function queryString(input: object | undefined): string {
  if (!input) return "";
  const values = input as Record<string, unknown>;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (name === "signal" || value === undefined) continue;
    query.set(name, name === "metadata" ? JSON.stringify(value) : String(value));
  }
  const result = query.toString();
  return result ? `?${result}` : "";
}

async function apiError(response: Response): Promise<VibyApiClientError> {
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    body = await response.text().catch(() => null);
  }
  const object = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const code = typeof object?.code === "string" ? object.code : `http_${response.status}`;
  const message = typeof object?.error === "string"
    ? object.error
    : response.statusText || `Viby API request failed with status ${response.status}.`;
  return new VibyApiClientError(response.status, code, message, body);
}

function segment(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigurationError("API resource ids must be non-empty strings.");
  }
  return encodeURIComponent(value);
}

function integerOption(
  value: number | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new ConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function compareCursors(left: string, right: string): number {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return left.localeCompare(right);
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function isTerminalEvent(type: string): boolean {
  return type === "generation.succeeded"
    || type === "generation.failed"
    || type === "generation.cancelled";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
