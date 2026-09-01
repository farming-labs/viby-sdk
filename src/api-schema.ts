import { ConfigurationError } from "./errors.js";

export type VibyApiMethod = "delete" | "get" | "patch" | "post" | "put";
export type VibyApiResponseKind = "binary" | "json" | "sse";

export interface VibyApiOperation {
  readonly id: string;
  readonly method: VibyApiMethod;
  readonly path: string;
  readonly summary: string;
  readonly tag: string;
  readonly status: number;
  readonly response: VibyApiResponseKind;
  readonly requestSchema?: VibyJsonSchemaName;
  /** OAuth callbacks authenticate with single-use state instead of the host session. */
  readonly public?: boolean;
  /** Compact compatibility aliases; prefer the chat-nested route. */
  readonly deprecated?: boolean;
}

export interface VibyOpenApiOptions {
  readonly title?: string;
  readonly version?: string;
  /** Defaults to /api/viby. */
  readonly basePath?: string;
  /** Optional absolute server URL, such as https://app.example.com. */
  readonly serverUrl?: string;
  readonly description?: string;
}

export interface VibyOpenApiDocument extends Record<string, unknown> {
  readonly openapi: "3.1.0";
  readonly info: Readonly<Record<string, unknown>>;
  readonly paths: Readonly<Record<string, unknown>>;
  readonly components: Readonly<Record<string, unknown>>;
}

const operations = [
  operation("listChats", "get", "/chats", "List chats", "Chats"),
  operation("createChat", "post", "/chats", "Create a chat and optionally start generation", "Chats", 201, "json", "CreateChatRequest"),
  operation("importChat", "post", "/chats/imports", "Import project source", "Chats", 201, "json", "ImportChatRequest"),
  operation("getChat", "get", "/chats/{chatId}", "Get a chat snapshot", "Chats"),
  operation("updateChat", "patch", "/chats/{chatId}", "Update chat metadata", "Chats", 200, "json", "UpdateChatRequest"),
  operation("deleteChat", "delete", "/chats/{chatId}", "Soft-delete a chat", "Chats", 200, "json", "DeleteChatRequest"),
  operation("restoreChat", "post", "/chats/{chatId}/restore", "Restore a deleted chat", "Chats"),
  operation("getAttachment", "get", "/chats/{chatId}/attachments/{attachmentId}", "Download an attachment", "Artifacts", 200, "binary"),
  operation("listEnvironmentVariables", "get", "/chats/{chatId}/environment", "List project environment variables", "Environment"),
  operation("setEnvironmentVariable", "put", "/chats/{chatId}/environment/{environment}/{name}", "Set a project environment variable", "Environment", 200, "json", "EnvironmentVariableRequest"),
  operation("deleteEnvironmentVariable", "delete", "/chats/{chatId}/environment/{environment}/{name}", "Delete a project environment variable", "Environment"),
  operation("getChatToolSources", "get", "/chats/{chatId}/tool-sources", "Get selected chat tool sources", "Tool sources"),
  operation("setChatToolSources", "put", "/chats/{chatId}/tool-sources", "Select chat tool sources", "Tool sources", 200, "json", "ChatToolSourcesRequest"),
  operation("listChatRepositoryLinks", "get", "/chats/{chatId}/repository-links", "List linked repositories", "Repositories"),
  operation("listChatRepositoryPushes", "get", "/chats/{chatId}/repository-pushes", "List repository push history", "Repositories"),
  operation("listChatDeploymentProjects", "get", "/chats/{chatId}/deployment-projects", "List linked deployment projects", "Deployments"),
  operation("listChatDeployments", "get", "/chats/{chatId}/deployments", "List deployment history", "Deployments"),
  operation("listMessages", "get", "/chats/{chatId}/messages", "List chat messages", "Messages"),
  operation("startGeneration", "post", "/chats/{chatId}/messages", "Start a generation", "Generations", 202, "json", "GenerateRequest"),
  operation("getMessage", "get", "/chats/{chatId}/messages/{messageId}", "Get a message", "Messages"),
  operation("listMessageFeedback", "get", "/chats/{chatId}/messages/{messageId}/feedback", "List message feedback", "Feedback"),
  operation("submitMessageFeedback", "post", "/chats/{chatId}/messages/{messageId}/feedback", "Submit immutable message feedback", "Feedback", 201, "json", "MessageFeedbackRequest"),
  operation("startChatInspection", "post", "/chats/{chatId}/inspections", "Start a read-only chat inspection", "Generations", 202, "json", "GenerateRequest"),
  operation("listVersions", "get", "/chats/{chatId}/versions", "List immutable versions", "Versions"),
  operation("getVersion", "get", "/chats/{chatId}/versions/{versionId}", "Get an immutable version", "Versions"),
  operation("getProjectArtifact", "get", "/chats/{chatId}/versions/{versionId}/artifacts/{path}", "Download a binary project entry", "Artifacts", 200, "binary"),
  operation("listVisualArtifacts", "get", "/chats/{chatId}/versions/{versionId}/visual-artifacts", "List visual artifacts", "Artifacts"),
  operation("getVisualArtifact", "get", "/chats/{chatId}/versions/{versionId}/visual-artifacts/{artifactId}", "Download a visual artifact", "Artifacts", 200, "binary"),
  operation("listVersionChanges", "get", "/chats/{chatId}/versions/{versionId}/changes", "List immutable source changes", "Versions"),
  operation("applyVersionChanges", "post", "/chats/{chatId}/versions/{versionId}/changes", "Apply an immutable source change set", "Versions", 201, "json", "ApplyChangesRequest"),
  operation("restoreVersion", "post", "/chats/{chatId}/versions/{versionId}/restore", "Restore an immutable version", "Versions", 201, "json", "VersionCopyRequest"),
  operation("forkVersion", "post", "/chats/{chatId}/versions/{versionId}/fork", "Fork an immutable version into a new chat", "Versions", 201, "json", "VersionCopyRequest"),
  operation("listVersionPushes", "get", "/chats/{chatId}/versions/{versionId}/repository-pushes", "List version push history", "Repositories"),
  operation("pushVersion", "post", "/chats/{chatId}/versions/{versionId}/repository-pushes", "Push an immutable version", "Repositories", 201, "json", "RepositoryPushRequest"),
  operation("listVersionDeployments", "get", "/chats/{chatId}/versions/{versionId}/deployments", "List version deployments", "Deployments"),
  operation("deployVersion", "post", "/chats/{chatId}/versions/{versionId}/deployments", "Deploy an immutable version", "Deployments", 201, "json", "VersionDeploymentRequest"),
  operation("getDeploymentArtifact", "get", "/chats/{chatId}/versions/{versionId}/deployments/{deploymentId}/artifact", "Download prepared deployment output", "Artifacts", 200, "binary"),
  operation("startIteration", "post", "/chats/{chatId}/versions/{versionId}/messages", "Start a version iteration", "Generations", 202, "json", "GenerateRequest"),
  operation("startVersionInspection", "post", "/chats/{chatId}/versions/{versionId}/inspections", "Start a read-only version inspection", "Generations", 202, "json", "GenerateRequest"),
  operation("downloadVersion", "get", "/chats/{chatId}/versions/{versionId}/download", "Download framework-native source", "Artifacts", 200, "binary"),
  operation("startVersionPreview", "post", "/chats/{chatId}/versions/{versionId}/preview", "Start or reuse a version preview", "Previews", 201, "json"),
  operation("listPreviews", "get", "/previews", "List durable previews", "Previews"),
  operation("cleanupPreviews", "post", "/previews/cleanup", "Clean up expired previews", "Previews", 200, "json", "CleanupRequest"),
  operation("getPreview", "get", "/previews/{previewId}", "Get a durable preview", "Previews"),
  operation("stopPreview", "delete", "/previews/{previewId}", "Stop a durable preview", "Previews"),
  operation("stopPreviewAlias", "post", "/previews/{previewId}/stop", "Stop a durable preview", "Previews", 200, "json", undefined, false, true),
  operation("reconnectPreview", "post", "/previews/{previewId}/reconnect", "Reconnect a durable preview", "Previews"),
  operation("getGeneration", "get", "/generations/{generationId}", "Get generation state and attempts", "Generations"),
  operation("listProviderRequestAttribution", "get", "/generations/{generationId}/provider-requests", "List durable provider request attribution", "Generations"),
  operation("getGeneratedArtifact", "get", "/generations/{generationId}/artifacts/{artifactId}", "Download a generated artifact", "Artifacts", 200, "binary"),
  operation("streamGenerationEvents", "get", "/generations/{generationId}/events", "Stream resumable generation events", "Generations", 200, "sse"),
  operation("pageGenerationEvents", "get", "/generations/{generationId}/events/page", "Page durable generation events", "Generations"),
  operation("listGenerationSteering", "get", "/generations/{generationId}/steering", "List generation steering", "Generations"),
  operation("steerGeneration", "post", "/generations/{generationId}/steering", "Queue a durable steering instruction", "Generations", 202, "json", "SteeringRequest"),
  operation("cancelGeneration", "post", "/generations/{generationId}/cancel", "Cancel a generation", "Generations", 200, "json", "CancelGenerationRequest"),
  operation("retryGeneration", "post", "/generations/{generationId}/retry", "Retry a failed generation", "Generations", 202),
  operation("resumeGeneration", "post", "/generations/{generationId}/resume", "Resume a durable generation", "Generations", 202),
  operation("resolveGenerationTask", "post", "/generations/{generationId}/tasks/{taskId}", "Resolve a generation task", "Generations", 202, "json", "TaskResolutionRequest"),
  operation("listToolSources", "get", "/tool-sources", "List durable tool sources", "Tool sources"),
  operation("createToolSource", "post", "/tool-sources", "Create a durable tool source", "Tool sources", 201, "json", "ToolSourceRequest"),
  operation("getToolSource", "get", "/tool-sources/{toolSourceId}", "Get a durable tool source", "Tool sources"),
  operation("updateToolSource", "patch", "/tool-sources/{toolSourceId}", "Update a durable tool source", "Tool sources", 200, "json", "ToolSourceRequest"),
  operation("archiveToolSource", "delete", "/tool-sources/{toolSourceId}", "Archive a durable tool source", "Tool sources"),
  operation("getToolSourceConnection", "get", "/tool-sources/{toolSourceId}/connection", "Get tool-source connection state", "Tool sources"),
  operation("connectToolSource", "post", "/tool-sources/{toolSourceId}/connect", "Connect a tool source", "Tool sources", 200, "json", "IntegrationConnectRequest"),
  operation("disconnectToolSource", "post", "/tool-sources/{toolSourceId}/disconnect", "Disconnect a tool source", "Tool sources"),
  operation("toolSourceCallbackGet", "get", "/tool-sources/callback", "Complete tool-source authorization", "Callbacks", 200, "json", undefined, true),
  operation("toolSourceCallbackPost", "post", "/tool-sources/callback", "Complete tool-source authorization", "Callbacks", 200, "json", undefined, true),
  operation("listIntegrations", "get", "/integrations", "List configured integrations", "Integrations"),
  operation("listIntegrationCategory", "get", "/integrations/{category}", "List integrations in a category", "Integrations"),
  operation("listIntegrationConnections", "get", "/integrations/{category}/{integrationId}/connections", "List provider connections", "Integrations"),
  operation("connectIntegration", "post", "/integrations/{category}/{integrationId}/connect", "Connect a provider integration", "Integrations", 200, "json", "IntegrationConnectRequest"),
  operation("disconnectIntegration", "delete", "/integrations/{category}/{integrationId}/connections/{connectionId}", "Disconnect a provider integration", "Integrations"),
  operation("integrationCallbackGet", "get", "/integrations/callback", "Complete provider authorization", "Callbacks", 200, "json", undefined, true),
  operation("integrationCallbackPost", "post", "/integrations/callback", "Complete provider authorization", "Callbacks", 200, "json", undefined, true),
  operation("listRepositoryOwners", "get", "/integrations/repository/{integrationId}/owners", "List repository owners", "Repositories"),
  operation("listRepositories", "get", "/integrations/repository/{integrationId}/repositories", "List repositories", "Repositories"),
  operation("createRepository", "post", "/integrations/repository/{integrationId}/repositories", "Create a repository", "Repositories", 201, "json", "RepositoryCreateRequest"),
  operation("listRepositoryBranches", "get", "/integrations/repository/{integrationId}/branches", "List repository branches", "Repositories"),
  operation("createRepositoryBranch", "post", "/integrations/repository/{integrationId}/branches", "Create a repository branch", "Repositories", 201, "json", "RepositoryBranchRequest"),
  operation("createPullRequest", "post", "/integrations/repository/{integrationId}/pull-requests", "Create a pull request", "Repositories", 201, "json", "PullRequestRequest"),
  operation("mergePullRequest", "post", "/integrations/repository/{integrationId}/pull-requests/{pullRequestNumber}/merge", "Merge a pull request", "Repositories", 200, "json", "PullRequestMergeRequest"),
  operation("listDeploymentProjects", "get", "/integrations/deployment/{integrationId}/projects", "List deployment projects", "Deployments"),
  operation("createDeploymentProject", "post", "/integrations/deployment/{integrationId}/projects", "Create a deployment project", "Deployments", 201, "json", "DeploymentProjectRequest"),
  operation("getProviderDeployment", "get", "/integrations/deployment/{integrationId}/deployments/{deploymentId}", "Get a provider deployment", "Deployments"),
  operation("cancelProviderDeployment", "delete", "/integrations/deployment/{integrationId}/deployments/{deploymentId}", "Cancel a provider deployment", "Deployments", 200, "json", "IdempotencyRequest"),
  operation("iterateVersionAlias", "post", "/versions/{versionId}/iterations", "Start a version iteration", "Compatibility", 202, "json", "GenerateRequest", false, true),
  operation("inspectVersionAlias", "post", "/versions/{versionId}/inspections", "Start a version inspection", "Compatibility", 202, "json", "GenerateRequest", false, true),
  operation("downloadVersionAlias", "get", "/versions/{versionId}/download", "Download version source", "Compatibility", 200, "binary", undefined, false, true),
  operation("previewVersionAlias", "post", "/versions/{versionId}/preview", "Start a version preview", "Compatibility", 201, "json", undefined, false, true),
] as const satisfies readonly VibyApiOperation[];

export type VibyApiOperationId = (typeof operations)[number]["id"];
export type VibyApiKnownOperation = (typeof operations)[number];

export const VIBY_API_OPERATIONS: readonly VibyApiKnownOperation[] = deepFreeze([...operations]);

const identifier = { type: "string", minLength: 1, maxLength: 200 };
const jsonObject = { type: "object", additionalProperties: true };
const nullableString = { type: ["string", "null"] };

const schemaDefinitions = {
  Error: {
    type: "object",
    required: ["error", "code"],
    properties: { error: { type: "string" }, code: { type: "string" } },
    additionalProperties: true,
  },
  GenericResponse: jsonObject,
  Chat: {
    type: "object",
    required: ["id", "framework", "title", "metadata", "createdAt", "updatedAt"],
    properties: {
      id: identifier, framework: { type: "string", minLength: 1 }, title: { type: "string" },
      metadata: jsonObject, createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" }, deletedAt: nullableString,
    },
    additionalProperties: true,
  },
  Message: {
    type: "object",
    required: ["id", "chatId", "role", "content", "parts", "createdAt"],
    properties: {
      id: identifier, chatId: identifier, role: { enum: ["user", "assistant"] },
      content: { type: "string" }, finishReason: nullableString,
      parts: { type: "array", items: jsonObject }, createdAt: { type: "string", format: "date-time" },
    },
    additionalProperties: true,
  },
  Generation: {
    type: "object",
    required: ["id", "chatId", "status", "createdAt", "updatedAt"],
    properties: {
      id: identifier, chatId: identifier,
      status: { enum: ["queued", "running", "waiting", "completed", "failed", "cancelled"] },
      createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    additionalProperties: true,
  },
  Version: {
    type: "object",
    required: ["id", "chatId", "number", "framework", "title", "summary", "createdAt"],
    properties: {
      id: identifier, chatId: identifier, number: { type: "integer", minimum: 1 },
      framework: { type: "string" }, title: { type: "string" }, summary: { type: "string" },
      createdAt: { type: "string", format: "date-time" },
    },
    additionalProperties: true,
  },
  MessageFeedback: {
    type: "object",
    required: ["id", "messageId", "rating", "reasons", "metadata", "createdAt"],
    properties: {
      id: identifier, messageId: identifier, rating: { enum: ["positive", "negative"] },
      reasons: { type: "array", items: { type: "string" } }, comment: nullableString,
      metadata: jsonObject, createdAt: { type: "string", format: "date-time" },
    },
    additionalProperties: true,
  },
  Preview: {
    type: "object",
    required: ["id", "chatId", "versionId", "status", "createdAt", "updatedAt"],
    properties: {
      id: identifier, chatId: identifier, versionId: identifier,
      status: { enum: ["starting", "ready", "failed", "stopped", "expired"] },
      url: nullableString, createdAt: { type: "string", format: "date-time" },
      updatedAt: { type: "string", format: "date-time" },
    },
    additionalProperties: true,
  },
  HealthReport: {
    type: "object",
    required: ["status", "ok", "checks", "checkedAt", "durationMs"],
    properties: {
      status: { enum: ["healthy", "degraded", "unhealthy"] }, ok: { type: "boolean" },
      checks: { type: "array", items: jsonObject },
      checkedAt: { type: "string", format: "date-time" }, durationMs: { type: "number", minimum: 0 },
    },
    additionalProperties: false,
  },
  CreateChatRequest: objectSchema({}, ["title", "metadata", "prompt"]),
  UpdateChatRequest: objectSchema({}, ["title", "metadata"]),
  DeleteChatRequest: objectSchema({}, ["retentionMs"]),
  ImportChatRequest: objectSchema({ source: jsonObject }, ["title", "summary", "metadata", "files"]),
  GenerateRequest: objectSchema({ prompt: { type: "string", minLength: 1, maxLength: 100_000 } }, ["model", "skills", "metadata", "attachments"]),
  MessageFeedbackRequest: objectSchema({ rating: { enum: ["positive", "negative"] } }, ["reasons", "comment", "metadata", "idempotencyKey"]),
  ApplyChangesRequest: objectSchema({ changes: { type: "array", minItems: 1, items: jsonObject } }, ["title", "summary"]),
  VersionCopyRequest: objectSchema({}, ["title", "summary", "metadata"]),
  EnvironmentVariableRequest: objectSchema({ value: { type: "string" } }, ["secret"]),
  ChatToolSourcesRequest: objectSchema({ toolSourceIds: { type: "array", items: identifier, uniqueItems: true } }),
  SteeringRequest: objectSchema({ prompt: { type: "string", minLength: 1, maxLength: 100_000 } }, ["attachments", "idempotencyKey"]),
  CancelGenerationRequest: objectSchema({}, ["reason"]),
  TaskResolutionRequest: objectSchema({ resolution: jsonObject }),
  CleanupRequest: objectSchema({}, ["limit"]),
  ToolSourceRequest: objectSchema({}, ["type", "name", "description", "configuration", "enabled"]),
  IntegrationConnectRequest: objectSchema({}, ["callbackUrl", "returnTo", "authorization", "scopes", "force"]),
  RepositoryCreateRequest: objectSchema({ owner: { type: "string" }, name: { type: "string" } }, ["description", "visibility"]),
  RepositoryBranchRequest: objectSchema({ owner: { type: "string" }, repository: { type: "string" }, name: { type: "string" }, from: { type: "string" } }),
  PullRequestRequest: objectSchema({ owner: { type: "string" }, repository: { type: "string" }, head: { type: "string" }, base: { type: "string" }, title: { type: "string" } }, ["body", "draft", "providerOptions"]),
  PullRequestMergeRequest: objectSchema({ owner: { type: "string" }, repository: { type: "string" }, idempotencyKey: { type: "string" } }, ["method", "expectedHead", "providerOptions"]),
  DeploymentProjectRequest: objectSchema({ name: { type: "string" } }, ["providerOptions"]),
  IdempotencyRequest: objectSchema({ idempotencyKey: { type: "string" } }),
  RepositoryPushRequest: objectSchema({ integrationId: { type: "string" }, repository: jsonObject, branch: {}, commit: jsonObject }, ["connectionId", "pullRequest", "idempotencyKey"]),
  VersionDeploymentRequest: objectSchema({ integrationId: { type: "string" }, project: jsonObject }, ["connectionId", "environment", "idempotencyKey", "providerOptions"]),
} as const;

export type VibyJsonSchemaName = keyof typeof schemaDefinitions;

export const vibyJsonSchemas = deepFreeze({
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://viby.farming-labs.dev/schema/v1.json",
  title: "Viby API schemas",
  $defs: schemaDefinitions,
});

/** Create an OpenAPI 3.1 document for the framework-neutral Web API host. */
export function createVibyOpenApiDocument(
  options: VibyOpenApiOptions = {},
): VibyOpenApiDocument {
  const basePath = normalizeBasePath(options.basePath);
  const title = boundedText(options.title, "Viby API", 200, "title");
  const version = boundedText(options.version, "1.0.0", 100, "version");
  const description = boundedText(
    options.description,
    "Durable, framework-neutral chats, generations, versions, previews, tools, and integrations.",
    2_000,
    "description",
  );
  if (options.serverUrl !== undefined) {
    let url: URL;
    try { url = new URL(options.serverUrl); } catch {
      throw new ConfigurationError("OpenAPI serverUrl must be an absolute HTTP(S) URL.");
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") {
      throw new ConfigurationError("OpenAPI serverUrl must use HTTP or HTTPS.");
    }
  }

  const paths: Record<string, Record<string, unknown>> = {};
  for (const operation of VIBY_API_OPERATIONS) {
    const path = `${basePath}${operation.path}` || "/";
    const item = paths[path] ??= {};
    item[operation.method] = openApiOperation(operation);
  }
  const document: VibyOpenApiDocument = {
    openapi: "3.1.0",
    info: { title, version, description },
    ...(options.serverUrl ? { servers: [{ url: options.serverUrl.replace(/\/$/, "") }] } : {}),
    paths,
    components: {
      schemas: structuredClone(schemaDefinitions),
      securitySchemes: {
        hostSession: {
          type: "apiKey",
          in: "cookie",
          name: "host-owned-session",
          description: "Placeholder for the authentication contract supplied to createVibyApi().",
        },
      },
    },
    tags: [...new Set(VIBY_API_OPERATIONS.map((operation) => operation.tag))]
      .map((name) => ({ name })),
    "x-viby-authentication": "host-owned",
  };
  return deepFreeze(document);
}

function operation<const Id extends string>(
  id: Id,
  method: VibyApiMethod,
  path: string,
  summary: string,
  tag: string,
  status = 200,
  response: VibyApiResponseKind = "json",
  requestSchema?: VibyJsonSchemaName,
  isPublic = false,
  deprecated = false,
): VibyApiOperation & { readonly id: Id } {
  return {
    id, method, path, summary, tag, status, response,
    ...(requestSchema ? { requestSchema } : {}),
    ...(isPublic ? { public: true } : {}),
    ...(deprecated ? { deprecated: true } : {}),
  };
}

function openApiOperation(operation: VibyApiOperation): Record<string, unknown> {
  const parameters = [...operation.path.matchAll(/\{([^}]+)\}/g)].map((match) => ({
    name: match[1], in: "path", required: true, schema: { type: "string", minLength: 1 },
  }));
  const contentType = operation.response === "binary"
    ? "application/octet-stream"
    : operation.response === "sse" ? "text/event-stream" : "application/json";
  const responseSchema = operation.response === "binary"
    ? { type: "string", contentEncoding: "base64" }
    : operation.response === "sse" ? { type: "string" } : schemaRef("GenericResponse");
  return {
    operationId: operation.id,
    summary: operation.summary,
    tags: [operation.tag],
    ...(parameters.length ? { parameters } : {}),
    ...(operation.requestSchema ? {
      requestBody: {
        required: true,
        content: { "application/json": { schema: schemaRef(operation.requestSchema) } },
      },
    } : {}),
    responses: {
      [operation.status]: {
        description: operation.summary,
        content: { [contentType]: { schema: responseSchema } },
      },
      default: {
        description: "Typed Viby error",
        content: { "application/json": { schema: schemaRef("Error") } },
      },
    },
    security: operation.public ? [] : [{ hostSession: [] }],
    ...(operation.deprecated ? { deprecated: true } : {}),
  };
}

function objectSchema(
  requiredProperties: Record<string, unknown>,
  optionalProperties: readonly string[] = [],
): Record<string, unknown> {
  const properties = { ...requiredProperties } as Record<string, unknown>;
  for (const name of optionalProperties) properties[name] = {};
  return {
    type: "object",
    ...(Object.keys(requiredProperties).length ? { required: Object.keys(requiredProperties) } : {}),
    properties,
    additionalProperties: false,
  };
}

function schemaRef(name: VibyJsonSchemaName): { $ref: string } {
  return { $ref: `#/components/schemas/${name}` };
}

function normalizeBasePath(value = "/api/viby"): string {
  if (value === "") return "";
  if (!value.startsWith("/") || value.endsWith("/") || value.includes("?") || value.includes("#")) {
    throw new ConfigurationError("OpenAPI basePath must be empty or start with / without a trailing slash, query, or fragment.");
  }
  return value;
}

function boundedText(value: string | undefined, fallback: string, max: number, field: string): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new ConfigurationError(`OpenAPI ${field} must contain 1-${max} characters.`);
  }
  return value.trim();
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}
