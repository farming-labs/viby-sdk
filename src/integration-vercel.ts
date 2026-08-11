import { createHash } from "node:crypto";
import { ConfigurationError } from "./errors.js";
import type {
  CreateDeploymentProjectInput,
  DeploymentData,
  DeploymentEnvironment,
  DeploymentIntegration,
  DeploymentProjectData,
  DeployVersionInput,
  IntegrationAuthorizationContext,
  IntegrationAuthorizationResult,
  IntegrationOperationContext,
  IntegrationPage,
  IntegrationSourceFile,
  ListDeploymentProjectsInput,
} from "./integrations.js";

const DEFAULT_API_URL = "https://api.vercel.com";
const DEFAULT_WEB_URL = "https://vercel.com";
const DEFAULT_SCOPES = Object.freeze([
  "project:read-write",
  "deployment:read-write",
]);
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

export type VercelFramework =
  | "vite"
  | "tanstack-start"
  | "astro"
  | "sveltekit"
  | "remix"
  | "react-router"
  | "nuxtjs"
  | "solidstart"
  | "static"
  | (string & {});

export interface VercelProjectSettings {
  readonly framework?: VercelFramework | null;
  readonly buildCommand?: string | null;
  readonly devCommand?: string | null;
  readonly installCommand?: string | null;
  readonly outputDirectory?: string | null;
  readonly rootDirectory?: string | null;
  readonly nodeVersion?: string;
}

export interface VercelEnvironmentVariable {
  readonly key: string;
  readonly value: string;
  readonly target: "production" | "preview" | "development"
    | readonly ("production" | "preview" | "development")[];
  readonly type?: "system" | "encrypted" | "plain" | "sensitive";
  readonly gitBranch?: string;
}

export interface VercelProjectOptions extends VercelProjectSettings {
  readonly environmentVariables?: readonly VercelEnvironmentVariable[];
}

export interface VercelGitMetadata {
  readonly remoteUrl?: string;
  readonly commitAuthorName?: string;
  readonly commitAuthorEmail?: string;
  readonly commitMessage?: string;
  readonly commitRef?: string;
  readonly commitSha?: string;
  readonly dirty?: boolean;
}

export interface VercelDeployOptions {
  readonly meta?: Readonly<Record<string, string>>;
  readonly gitMetadata?: VercelGitMetadata;
  readonly projectSettings?: VercelProjectSettings;
  readonly skipAutoDetectionConfirmation?: boolean;
}

export interface VercelDeploymentOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  readonly apiUrl?: string;
  readonly webUrl?: string;
  /** Override the external-integration installation entry point. */
  readonly installationUrl?: string;
  /** Scopes configured for this integration in Vercel's Integration Console. */
  readonly scopes?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly source?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
    readonly concurrency?: number;
  };
}

interface VercelCredentialData {
  readonly version: 1;
  readonly accessToken: string;
  readonly teamId: string | null;
  readonly userId: string | null;
  readonly configurationId: string | null;
}

interface VercelRuntime {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly installationUrl: string;
  readonly scopes: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly concurrency: number;
}

interface VercelRequestOptions {
  readonly method?: string;
  readonly credential?: VercelCredentialData;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null | undefined;
  readonly json?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly expected?: readonly number[];
}

interface VercelProjectResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly latestDeployments?: unknown;
  readonly targets?: unknown;
}

interface VercelDeploymentResponse {
  readonly id?: unknown;
  readonly uid?: unknown;
  readonly projectId?: unknown;
  readonly project?: unknown;
  readonly target?: unknown;
  readonly customEnvironment?: unknown;
  readonly readyState?: unknown;
  readonly state?: unknown;
  readonly status?: unknown;
  readonly url?: unknown;
  readonly created?: unknown;
  readonly createdAt?: unknown;
  readonly meta?: unknown;
}

export class VercelDeploymentError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: { readonly status?: number; readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VercelDeploymentError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** Creates an external Vercel Integration provider for `integrations.deployment`. */
export function vercel(
  options: VercelDeploymentOptions,
): DeploymentIntegration<VercelProjectOptions, VercelDeployOptions> {
  const runtime = normalizeOptions(options);
  return {
    provider: "vercel",
    displayName: "Vercel",
    source: { mode: "source" },
    connection: {
      async startAuthorization(input) {
        input.signal?.throwIfAborted();
        const url = new URL(runtime.installationUrl);
        url.searchParams.set("state", input.state);
        return { url: url.href, expiresAt: null };
      },
      async completeAuthorization(input, context) {
        return completeAuthorization(runtime, input.callbackUrl, context);
      },
      async revokeCredential(credential, context) {
        const current = decodeCredential(credential.secret);
        const basic = encodeBasic(`${runtime.clientId}:${runtime.clientSecret}`);
        await vercelRequest(runtime, "/login/oauth/token/revoke", {
          method: "POST",
          headers: {
            authorization: `Basic ${basic}`,
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ token: current.accessToken }),
          signal: context.signal,
          expected: [200, 204],
        });
      },
    },
    async listProjects(input, context) {
      return listProjects(runtime, input, context);
    },
    async getProject(input, context) {
      return getProject(runtime, input, context);
    },
    async createProject(input, context) {
      return createProject(runtime, input, context);
    },
    async deployVersion(input, context) {
      return deployVersion(runtime, input, context);
    },
    async getDeployment(input, context) {
      return getDeployment(runtime, input.id, context);
    },
    async cancelDeployment(input, context) {
      requiredText(input.idempotencyKey, "Deployment cancellation idempotency key");
      const current = await getDeployment(runtime, input.id, context);
      if (!current) {
        throw new VercelDeploymentError(`Vercel deployment ${input.id} was not found.`, {
          status: 404,
          code: "deployment_not_found",
        });
      }
      if (current.status === "cancelled") return current;
      const credential = decodeCredential(context.credential);
      const response = await vercelRequest<VercelDeploymentResponse>(
        runtime,
        `/v12/deployments/${encodeURIComponent(requiredText(input.id, "Deployment id"))}/cancel`,
        {
          method: "PATCH",
          credential,
          signal: context.signal,
        },
      );
      return deploymentData(response, null, "preview", "cancelled");
    },
  };
}

export const vercelDeployment = vercel;

async function completeAuthorization(
  runtime: VercelRuntime,
  callbackUrl: string,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationAuthorizationResult> {
  const callback = new URL(callbackUrl);
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    throw new VercelDeploymentError(
      callback.searchParams.get("error_description") || `Vercel authorization failed: ${providerError}`,
      { status: 401, code: providerError },
    );
  }
  const code = requiredQuery(callback, "code");
  const redirectUri = callback.origin + callback.pathname;
  const token = await vercelRequest<Record<string, unknown>>(runtime, "/v2/oauth/access_token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: runtime.clientId,
      client_secret: runtime.clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    signal: context.signal,
  });
  const accessToken = optionalText(token.access_token);
  if (!accessToken) {
    throw new VercelDeploymentError("Vercel returned no integration access token.", {
      status: 401,
    });
  }
  const teamId = optionalText(token.team_id);
  const callbackTeamId = optionalText(callback.searchParams.get("teamId"));
  if (teamId && callbackTeamId && teamId !== callbackTeamId) {
    throw new VercelDeploymentError("Vercel returned a different team than the installation callback.", {
      status: 401,
      code: "team_mismatch",
    });
  }
  const userId = optionalText(token.user_id);
  const configurationId = optionalText(callback.searchParams.get("configurationId"));
  const accountId = teamId ?? userId ?? configurationId
    ?? `vercel_${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}`;
  const credential: VercelCredentialData = {
    version: 1,
    accessToken,
    teamId,
    userId,
    configurationId,
  };
  return {
    account: {
      id: accountId,
      name: teamId ? `Vercel team ${teamId}` : `Vercel account ${userId ?? accountId}`,
      metadata: compactRecord({ teamId, userId, configurationId }),
    },
    credential: {
      secret: encodeCredential(credential),
      expiresAt: null,
      scopes: runtime.scopes,
    },
  };
}

async function listProjects(
  runtime: VercelRuntime,
  input: ListDeploymentProjectsInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<DeploymentProjectData>> {
  const credential = decodeCredential(context.credential);
  const limit = integerInRange(input.limit ?? 20, "Project page limit", 1, 100);
  const response = await vercelRequest<Record<string, unknown>>(runtime, "/v9/projects", {
    credential,
    query: {
      limit,
      from: optionalText(input.cursor),
      search: optionalText(input.search),
    },
    signal: context.signal,
  });
  const projects = Array.isArray(response.projects) ? response.projects : [];
  const pagination = record(response.pagination);
  return {
    items: projects.map((project) => {
      const value = record(project);
      if (!value) throw new VercelDeploymentError("Vercel returned an invalid project record.");
      return projectData(value);
    }),
    nextCursor: optionalText(pagination?.next),
  };
}

async function getProject(
  runtime: VercelRuntime,
  input: { readonly id?: string; readonly name?: string },
  context: IntegrationOperationContext,
): Promise<DeploymentProjectData | null> {
  const id = optionalText(input.id);
  const name = optionalText(input.name);
  if ((id ? 1 : 0) + (name ? 1 : 0) !== 1) {
    throw new ConfigurationError("A Vercel project lookup requires exactly one id or name.");
  }
  const credential = decodeCredential(context.credential);
  const response = await vercelRequest<VercelProjectResponse>(
    runtime,
    `/v9/projects/${encodeURIComponent(id ?? name!)}`,
    { credential, signal: context.signal, expected: [200, 404] },
  );
  if (isNotFound(response)) return null;
  return projectData(response);
}

async function createProject(
  runtime: VercelRuntime,
  input: CreateDeploymentProjectInput<VercelProjectOptions>,
  context: IntegrationOperationContext,
): Promise<DeploymentProjectData> {
  const credential = decodeCredential(context.credential);
  const name = vercelProjectName(input.name);
  const provider = input.providerOptions;
  const response = await vercelRequest<VercelProjectResponse>(runtime, "/v9/projects", {
    method: "POST",
    credential,
    json: compactObject({
      name,
      framework: provider?.framework,
      buildCommand: provider?.buildCommand,
      devCommand: provider?.devCommand,
      installCommand: provider?.installCommand,
      outputDirectory: provider?.outputDirectory,
      rootDirectory: provider?.rootDirectory,
      nodeVersion: provider?.nodeVersion,
      environmentVariables: provider?.environmentVariables,
    }),
    signal: context.signal,
  });
  return projectData(response);
}

async function deployVersion(
  runtime: VercelRuntime,
  input: DeployVersionInput<VercelDeployOptions>,
  context: IntegrationOperationContext,
): Promise<DeploymentData> {
  const credential = decodeCredential(context.credential);
  const projectId = requiredText(input.project, "Deployment project id");
  const environment = requiredText(input.environment, "Deployment environment") as DeploymentEnvironment;
  const idempotencyKey = requiredText(input.idempotencyKey, "Deployment idempotency key");
  const files = normalizeFiles(runtime, input.files);
  const existing = await findDeploymentByIdempotency(
    runtime,
    credential,
    projectId,
    environment,
    idempotencyKey,
    context.signal,
  );
  if (existing) return existing;

  const project = await getProject(runtime, { id: projectId }, context);
  if (!project) throw new VercelDeploymentError(`Vercel project ${projectId} was not found.`, {
    status: 404,
    code: "project_not_found",
  });
  const uploaded = await mapConcurrent(files, runtime.concurrency, async (file) => {
    const sha = createHash("sha1").update(file.content).digest("hex");
    await vercelRequest(runtime, "/v2/files", {
      method: "POST",
      credential,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(file.content.byteLength),
        "x-vercel-digest": sha,
      },
      body: new Uint8Array(file.content).buffer,
      signal: context.signal,
    });
    return { file: file.path, sha, size: file.content.byteLength };
  });
  const provider = input.providerOptions;
  const target = deploymentTarget(environment);
  const response = await vercelRequest<VercelDeploymentResponse>(runtime, "/v13/deployments", {
    method: "POST",
    credential,
    query: {
      skipAutoDetectionConfirmation: provider?.skipAutoDetectionConfirmation ? "1" : undefined,
    },
    json: compactObject({
      name: project.name,
      project: project.id,
      files: uploaded,
      target: target.target,
      customEnvironmentSlugOrId: target.customEnvironmentSlugOrId,
      meta: {
        ...(provider?.meta ?? {}),
        vibyIdempotencyKey: idempotencyKey,
      },
      gitMetadata: provider?.gitMetadata,
      projectSettings: provider?.projectSettings,
    }),
    signal: context.signal,
  });
  return deploymentData(response, project.id, environment);
}

async function findDeploymentByIdempotency(
  runtime: VercelRuntime,
  credential: VercelCredentialData,
  projectId: string,
  environment: DeploymentEnvironment,
  idempotencyKey: string,
  signal?: AbortSignal,
): Promise<DeploymentData | null> {
  const response = await vercelRequest<Record<string, unknown>>(runtime, "/v6/deployments", {
    credential,
    query: {
      projectId,
      limit: 1,
      "meta-vibyIdempotencyKey": idempotencyKey,
    },
    signal,
  });
  const candidate = Array.isArray(response.deployments) ? response.deployments[0] : undefined;
  if (!candidate) return null;
  const summary = record(candidate);
  if (!summary) return null;
  const candidateId = optionalText(summary.id) ?? optionalText(summary.uid);
  if (!candidateId) return null;
  const details = await vercelRequest<VercelDeploymentResponse>(
    runtime,
    `/v13/deployments/${encodeURIComponent(candidateId)}`,
    { credential, signal, expected: [200, 404] },
  );
  if (isNotFound(details)) return null;
  const meta = record(details.meta);
  if (optionalText(meta?.vibyIdempotencyKey) !== idempotencyKey) return null;
  return deploymentData(details, projectId, environment);
}

async function getDeployment(
  runtime: VercelRuntime,
  id: string,
  context: IntegrationOperationContext,
): Promise<DeploymentData | null> {
  const credential = decodeCredential(context.credential);
  const response = await vercelRequest<VercelDeploymentResponse>(
    runtime,
    `/v13/deployments/${encodeURIComponent(requiredText(id, "Deployment id"))}`,
    { credential, signal: context.signal, expected: [200, 404] },
  );
  return isNotFound(response) ? null : deploymentData(response, null, "preview");
}

function projectData(value: VercelProjectResponse): DeploymentProjectData {
  const id = requiredText(value.id, "Vercel project id");
  const name = requiredText(value.name, "Vercel project name");
  return { id, name, url: projectUrl(value) };
}

function projectUrl(project: VercelProjectResponse): string | null {
  if (Array.isArray(project.latestDeployments)) {
    for (const item of project.latestDeployments) {
      const url = optionalText(record(item)?.url);
      if (url) return httpsUrl(url);
    }
  }
  const production = record(record(project.targets)?.production);
  if (Array.isArray(production?.alias)) {
    const alias = production.alias.find((value) => optionalText(value));
    if (alias) return httpsUrl(String(alias));
  }
  return null;
}

function deploymentData(
  value: VercelDeploymentResponse,
  fallbackProjectId: string | null,
  fallbackEnvironment: DeploymentEnvironment,
  forcedStatus?: "cancelled",
): DeploymentData {
  const project = record(value.project);
  const customEnvironment = record(value.customEnvironment);
  const projectId = optionalText(value.projectId) ?? optionalText(project?.id) ?? fallbackProjectId;
  if (!projectId) throw new VercelDeploymentError("Vercel returned no deployment project id.");
  const target = optionalText(value.target);
  const environment = target === "production"
    ? "production"
    : target === "staging"
      ? "staging"
      : optionalText(customEnvironment?.slug) ?? fallbackEnvironment;
  return {
    id: optionalText(value.id) ?? requiredText(value.uid, "Vercel deployment id"),
    projectId,
    environment,
    status: forcedStatus ?? deploymentStatus(value.readyState ?? value.state ?? value.status),
    url: optionalText(value.url) ? httpsUrl(String(value.url)) : null,
    createdAt: deploymentDate(value.createdAt ?? value.created),
  };
}

function deploymentStatus(value: unknown): DeploymentData["status"] {
  const status = optionalText(value)?.toUpperCase();
  if (status === "READY") return "ready";
  if (status === "ERROR" || status === "BLOCKED") return "failed";
  if (status === "CANCELED" || status === "CANCELLED" || status === "DELETED") {
    return "cancelled";
  }
  if (status === "BUILDING" || status === "INITIALIZING") return "building";
  return "queued";
}

function deploymentTarget(environment: string): {
  readonly target?: string;
  readonly customEnvironmentSlugOrId?: string;
} {
  if (environment === "preview") return {};
  if (environment === "production" || environment === "staging") {
    return { target: environment };
  }
  return { customEnvironmentSlugOrId: environment };
}

function normalizeFiles(runtime: VercelRuntime, input: readonly IntegrationSourceFile[]) {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConfigurationError("A Vercel deployment requires at least one source file.");
  }
  if (input.length > runtime.maxFiles) {
    throw new ConfigurationError(`Vercel deployment source exceeds ${runtime.maxFiles} files.`);
  }
  const paths = new Set<string>();
  let bytes = 0;
  return input.map((file) => {
    const path = sourcePath(file.path);
    if (paths.has(path)) throw new ConfigurationError(`Duplicate deployment source path: ${path}`);
    paths.add(path);
    if (!(file.content instanceof Uint8Array)) {
      throw new ConfigurationError(`Deployment source ${path} must contain Uint8Array bytes.`);
    }
    bytes += file.content.byteLength;
    if (bytes > runtime.maxBytes) {
      throw new ConfigurationError(`Vercel deployment source exceeds ${runtime.maxBytes} bytes.`);
    }
    return { path, content: file.content };
  });
}

async function vercelRequest<Result = Record<string, unknown>>(
  runtime: VercelRuntime,
  path: string,
  options: VercelRequestOptions = {},
): Promise<Result> {
  const url = new URL(`${runtime.apiUrl}${path.startsWith("/") ? path : `/${path}`}`);
  if (options.credential?.teamId) url.searchParams.set("teamId", options.credential.teamId);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.credential) headers.set("authorization", `Bearer ${options.credential.accessToken}`);
  let body = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  }
  let response: Response;
  try {
    response = await runtime.fetch(url, {
      method: options.method ?? "GET",
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new VercelDeploymentError("Could not reach the Vercel API.", { cause });
  }
  const expected = options.expected ?? [200];
  const payload = await responsePayload(response);
  if (!expected.includes(response.status)) {
    const error = record(record(payload)?.error);
    throw new VercelDeploymentError(
      optionalText(error?.message) ?? `Vercel API request failed with status ${response.status}.`,
      { status: response.status, ...(optionalText(error?.code) ? { code: String(error!.code) } : {}) },
    );
  }
  if (response.status === 404) return { __vibyNotFound: true } as Result;
  return (payload ?? {}) as Result;
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { error: { message: text.slice(0, 500) } };
  }
}

function normalizeOptions(options: VercelDeploymentOptions): VercelRuntime {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Vercel deployment options are required.");
  }
  const slug = requiredText(options.slug, "Vercel integration slug");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(slug)) {
    throw new ConfigurationError("Vercel integration slug must be lowercase letters, numbers, or dashes.");
  }
  const apiUrl = httpUrl(options.apiUrl ?? DEFAULT_API_URL, "Vercel API URL");
  const webUrl = httpUrl(options.webUrl ?? DEFAULT_WEB_URL, "Vercel web URL");
  const installationUrl = httpUrl(
    options.installationUrl ?? `${webUrl}/integrations/${slug}/new`,
    "Vercel installation URL",
  );
  const scopes = Object.freeze((options.scopes ?? DEFAULT_SCOPES).map((scope) => (
    requiredText(scope, "Vercel integration scope")
  )));
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ConfigurationError("A Fetch implementation is required for Vercel.");
  }
  return {
    clientId: requiredText(options.clientId, "Vercel integration client id"),
    clientSecret: requiredText(options.clientSecret, "Vercel integration client secret"),
    slug,
    apiUrl,
    webUrl,
    installationUrl,
    scopes,
    fetch: fetchImplementation,
    maxFiles: integerInRange(options.source?.maxFiles ?? 20_000, "Vercel max files", 1, 100_000),
    maxBytes: integerInRange(
      options.source?.maxBytes ?? 100 * 1024 * 1024,
      "Vercel max source bytes",
      1,
      Number.MAX_SAFE_INTEGER,
    ),
    concurrency: integerInRange(options.source?.concurrency ?? 8, "Vercel upload concurrency", 1, 64),
  };
}

function encodeCredential(value: VercelCredentialData): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeCredential(value: Uint8Array): VercelCredentialData {
  try {
    const parsed = JSON.parse(textDecoder.decode(value)) as Partial<VercelCredentialData>;
    if (parsed.version !== 1 || !optionalText(parsed.accessToken)) throw new Error("invalid credential");
    return {
      version: 1,
      accessToken: parsed.accessToken!,
      teamId: optionalText(parsed.teamId),
      userId: optionalText(parsed.userId),
      configurationId: optionalText(parsed.configurationId),
    };
  } catch (cause) {
    throw new VercelDeploymentError("The stored Vercel credential is invalid.", { cause });
  }
}

function requiredQuery(url: URL, name: string): string {
  const value = optionalText(url.searchParams.get(name));
  if (!value) throw new VercelDeploymentError(`Vercel callback is missing ${name}.`, { status: 400 });
  return value;
}

function requiredText(value: unknown, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new ConfigurationError(`${label} is required.`);
  return normalized;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim()
    : typeof value === "number" && Number.isFinite(value) ? String(value)
      : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactRecord(
  value: Readonly<Record<string, string | null>>,
): Readonly<Record<string, string>> {
  return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => (
    entry[1] !== null
  )));
}

function compactObject(value: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function integerInRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function vercelProjectName(value: string): string {
  const name = requiredText(value, "Vercel project name");
  if (name.length > 100 || !/^[a-z0-9._-]+$/.test(name) || name.includes("---")) {
    throw new ConfigurationError(
      "Vercel project name must be at most 100 lowercase letters, numbers, dots, underscores, or dashes and cannot contain ---.",
    );
  }
  return name;
}

function sourcePath(value: string): string {
  const path = requiredText(value, "Deployment source path");
  const segments = path.split("/");
  if (path.startsWith("/") || path.includes("\\")
    || segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ConfigurationError(`Unsafe deployment source path: ${path}`);
  }
  return path;
}

function httpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(requiredText(value, label));
  } catch (cause) {
    throw new ConfigurationError(`${label} must be an absolute HTTP URL.`, { cause });
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError(`${label} must use HTTP or HTTPS.`);
  }
  url.search = "";
  url.hash = "";
  return url.href.replace(/\/$/, "");
}

function httpsUrl(value: string): string {
  return /^https?:\/\//i.test(value) ? value : `https://${value}`;
}

function deploymentDate(value: unknown): Date {
  if (typeof value === "number" && Number.isFinite(value)) return new Date(value);
  if (typeof value === "string") {
    const date = new Date(value);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return new Date();
}

function isNotFound(value: unknown): boolean {
  return record(value)?.__vibyNotFound === true;
}

function encodeBasic(value: string): string {
  return Buffer.from(value).toString("base64");
}

async function mapConcurrent<Input, Output>(
  input: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (next < input.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(input[index]!, index);
    }
  }));
  return output;
}
