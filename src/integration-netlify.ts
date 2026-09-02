import { createHash } from "node:crypto";
import { zipSync } from "fflate";
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
  IntegrationExternalAccount,
  IntegrationOperationContext,
  IntegrationPage,
  IntegrationSourceFile,
  ListDeploymentProjectsInput,
} from "./integrations.js";

const DEFAULT_API_URL = "https://api.netlify.com/api/v1";
const DEFAULT_AUTHORIZATION_URL = "https://app.netlify.com/authorize";
const DEFAULT_TOKEN_URL = "https://api.netlify.com/oauth/token";
const DEFAULT_MAX_FILES = 25_000;
const DEFAULT_MAX_FILE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_FUNCTION_BYTES = 100 * 1024 * 1024;
const DEFAULT_DIFF_TIMEOUT_MS = 120_000;
const DEFAULT_POLL_INTERVAL_MS = 750;
const PROJECTS_PER_PAGE = 100;
const DEPLOYS_PER_PAGE = 100;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

export interface NetlifyProjectOptions {
  /** Team slug used when the authorized user can access more than one Netlify team. */
  readonly accountSlug?: string;
}

export interface NetlifyAccountData {
  readonly id: string;
  readonly name: string;
  readonly slug: string;
}

export interface NetlifyFunctionRoute {
  readonly pattern?: string;
  readonly literal?: string;
  readonly expression?: string;
  readonly methods?: readonly string[];
  readonly preferStatic?: boolean;
}

export interface NetlifyFunctionConfig {
  readonly displayName?: string;
  readonly generator?: string;
  readonly routes?: readonly NetlifyFunctionRoute[];
  readonly excludedRoutes?: readonly Omit<NetlifyFunctionRoute, "methods" | "preferStatic">[];
  readonly priority?: number;
  readonly region?: string;
  readonly memory?: number;
  readonly vcpu?: number;
}

export interface NetlifyFunctionBundle {
  /** Stable Netlify function name. */
  readonly name: string;
  /** Directory containing one already-built function bundle in the immutable prepared output. */
  readonly directory: string;
  readonly runtime?: string;
  readonly invocationMode?: "stream" | "buffered" | (string & {});
  readonly timeout?: number;
  readonly config?: NetlifyFunctionConfig;
}

export interface NetlifyDeployOptions {
  /** Directory containing public assets in the immutable prepared output. Defaults to `.`. */
  readonly publishDirectory?: string;
  /** Already-built function directories to package and upload with the deploy. */
  readonly functions?: readonly NetlifyFunctionBundle[];
  readonly branch?: string;
  readonly title?: string;
  readonly framework?: string;
  readonly frameworkVersion?: string;
}

export interface NetlifyDeploymentOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly source?: {
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
    readonly maxFunctionBytes?: number;
    readonly concurrency?: number;
  };
  readonly diffTimeoutMs?: number;
  readonly pollIntervalMs?: number;
}

interface NetlifyCredentialData {
  readonly version: 1;
  readonly accessToken: string;
}

interface NetlifyRuntime {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly fetch: typeof globalThis.fetch;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxFunctionBytes: number;
  readonly concurrency: number;
  readonly diffTimeoutMs: number;
  readonly pollIntervalMs: number;
}

interface NetlifyRequestOptions {
  readonly method?: string;
  readonly credential?: NetlifyCredentialData;
  readonly query?: Readonly<Record<string, string | number | boolean | null | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null;
  readonly json?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly expected?: readonly number[];
}

interface NetlifyUserResponse {
  readonly id?: unknown;
  readonly uid?: unknown;
  readonly full_name?: unknown;
  readonly email?: unknown;
}

interface NetlifyAccountResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly slug?: unknown;
}

interface NetlifySiteResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly url?: unknown;
  readonly ssl_url?: unknown;
  readonly deploy_url?: unknown;
  readonly account_id?: unknown;
  readonly account_name?: unknown;
  readonly account_slug?: unknown;
}

interface NetlifyDeployResponse {
  readonly id?: unknown;
  readonly site_id?: unknown;
  readonly state?: unknown;
  readonly url?: unknown;
  readonly ssl_url?: unknown;
  readonly deploy_url?: unknown;
  readonly deploy_ssl_url?: unknown;
  readonly draft?: unknown;
  readonly required?: unknown;
  readonly required_functions?: unknown;
  readonly error_message?: unknown;
  readonly branch?: unknown;
  readonly created_at?: unknown;
  readonly title?: unknown;
  readonly context?: unknown;
}

interface PreparedFile {
  readonly path: string;
  readonly content: Uint8Array;
  readonly hash: string;
}

interface PreparedFunction {
  readonly name: string;
  readonly content: Uint8Array;
  readonly hash: string;
  readonly runtime: string;
  readonly invocationMode: string;
  readonly timeout: number | null;
  readonly config: Record<string, unknown> | null;
}

interface NetlifyDeploymentLocator {
  readonly siteId: string;
  readonly deploymentId: string;
  readonly environment: string;
}

export class NetlifyDeploymentError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: { readonly status?: number; readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "NetlifyDeploymentError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** Creates a Netlify OAuth and atomic deploy provider for `integrations.deployment`. */
export function netlify(
  options: NetlifyDeploymentOptions,
): DeploymentIntegration<NetlifyProjectOptions, NetlifyDeployOptions> {
  const runtime = normalizeOptions(options);
  return {
    provider: "netlify",
    displayName: "Netlify",
    source: { mode: "prebuilt" },
    connection: {
      async startAuthorization(input) {
        input.signal?.throwIfAborted();
        const url = new URL(runtime.authorizationUrl);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", runtime.clientId);
        url.searchParams.set("redirect_uri", input.callbackUrl);
        url.searchParams.set("state", input.state);
        return { url: url.href, expiresAt: null };
      },
      async completeAuthorization(input, context) {
        return completeAuthorization(runtime, input.callbackUrl, context);
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
      const locator = decodeDeploymentLocator(requiredText(input.id, "Deployment id"));
      const current = await getDeployment(runtime, input.id, context);
      if (!current) {
        throw new NetlifyDeploymentError(`Netlify deployment ${locator.deploymentId} was not found.`, {
          status: 404,
          code: "deployment_not_found",
        });
      }
      if (current.status === "cancelled") return current;
      const response = await netlifyRequest<NetlifyDeployResponse>(
        runtime,
        `/deploys/${encodeURIComponent(locator.deploymentId)}/cancel`,
        {
          method: "POST",
          credential: decodeCredential(context.credential),
          signal: context.signal,
          expected: [200, 201],
        },
      );
      return deploymentData(response, locator.environment, "cancelled");
    },
  };
}

export const netlifyDeployment = netlify;

/** Reads the authorized team choices persisted with a Netlify connection. */
export function netlifyAccounts(
  account: IntegrationExternalAccount,
): readonly NetlifyAccountData[] {
  const values = account.metadata?.accounts;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const item = record(value);
    const id = optionalText(item?.id);
    const name = optionalText(item?.name);
    const slug = optionalText(item?.slug);
    return id && name && slug ? [{ id, name, slug }] : [];
  });
}

async function completeAuthorization(
  runtime: NetlifyRuntime,
  callbackUrl: string,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationAuthorizationResult> {
  const callback = new URL(callbackUrl);
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    throw new NetlifyDeploymentError(
      callback.searchParams.get("error_description") || `Netlify authorization failed: ${providerError}`,
      { status: 401, code: providerError },
    );
  }
  const code = requiredQuery(callback, "code");
  const redirectUri = callback.origin + callback.pathname;
  const token = await oauthRequest(runtime, {
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code,
      client_id: runtime.clientId,
      client_secret: runtime.clientSecret,
      redirect_uri: redirectUri,
    }),
    signal: context.signal,
  });
  const accessToken = requiredProviderText(token.access_token, "Netlify access token");
  const credential = { version: 1 as const, accessToken };
  const [user, accounts] = await Promise.all([
    netlifyRequest<NetlifyUserResponse>(runtime, "/user", {
      credential,
      signal: context.signal,
    }),
    netlifyRequest<readonly NetlifyAccountResponse[]>(runtime, "/accounts", {
      credential,
      signal: context.signal,
    }),
  ]);
  const userId = optionalText(user.id) ?? optionalText(user.uid)
    ?? `netlify_${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}`;
  const accountChoices = accounts.map(accountData);
  return {
    account: {
      id: userId,
      name: optionalText(user.full_name) ?? optionalText(user.email) ?? `Netlify user ${userId}`,
      metadata: {
        ...(optionalText(user.email) ? { email: optionalText(user.email)! } : {}),
        accounts: accountChoices.map(({ id, name, slug }) => ({ id, name, slug })),
      },
    },
    credential: {
      secret: encodeCredential(credential),
      expiresAt: null,
      scopes: [],
    },
  };
}

async function listProjects(
  runtime: NetlifyRuntime,
  input: ListDeploymentProjectsInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<DeploymentProjectData>> {
  const limit = integerInRange(input.limit ?? 50, "Netlify project page size", 1, PROJECTS_PER_PAGE);
  const page = decodeCursor(input.cursor);
  const sites = await netlifyRequest<readonly NetlifySiteResponse[]>(runtime, "/sites", {
    credential: decodeCredential(context.credential),
    query: {
      name: optionalText(input.search),
      filter: "all",
      page,
      per_page: limit,
    },
    signal: context.signal,
  });
  return {
    items: sites.map(projectData),
    nextCursor: sites.length === limit ? String(page + 1) : null,
  };
}

async function getProject(
  runtime: NetlifyRuntime,
  input: { readonly id?: string; readonly name?: string },
  context: IntegrationOperationContext,
): Promise<DeploymentProjectData | null> {
  const id = optionalText(input.id);
  const name = optionalText(input.name);
  if ((id ? 1 : 0) + (name ? 1 : 0) !== 1) {
    throw new ConfigurationError("A Netlify project lookup requires exactly one id or name.");
  }
  const credential = decodeCredential(context.credential);
  if (id) {
    const site = await netlifyRequest<NetlifySiteResponse>(
      runtime,
      `/sites/${encodeURIComponent(id)}`,
      { credential, signal: context.signal, expected: [200, 404] },
    );
    return site ? projectData(site) : null;
  }
  const sites = await netlifyRequest<readonly NetlifySiteResponse[]>(runtime, "/sites", {
    credential,
    query: { name, filter: "all", page: 1, per_page: PROJECTS_PER_PAGE },
    signal: context.signal,
  });
  const matches = sites.filter((site) => optionalText(site.name) === name);
  if (matches.length > 1) {
    throw new ConfigurationError(`Netlify project ${name} is ambiguous; use its unique project id.`);
  }
  return matches[0] ? projectData(matches[0]) : null;
}

async function createProject(
  runtime: NetlifyRuntime,
  input: CreateDeploymentProjectInput<NetlifyProjectOptions>,
  context: IntegrationOperationContext,
): Promise<DeploymentProjectData> {
  const name = netlifyProjectName(input.name);
  const accounts = netlifyAccounts(context.externalAccount);
  const configuredSlug = optionalText(input.providerOptions?.accountSlug);
  const account = configuredSlug
    ? accounts.find((candidate) => candidate.slug === configuredSlug)
    : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) {
    if (accounts.length === 0) {
      throw new ConfigurationError("The Netlify connection cannot access a team that can create sites.");
    }
    throw new ConfigurationError(
      "Netlify project creation requires providerOptions.accountSlug when the connection can access multiple teams.",
    );
  }
  const site = await netlifyRequest<NetlifySiteResponse>(
    runtime,
    `/${encodeURIComponent(account.slug)}/sites`,
    {
      method: "POST",
      credential: decodeCredential(context.credential),
      json: { name },
      signal: context.signal,
      expected: [200, 201],
    },
  );
  return projectData(site);
}

async function deployVersion(
  runtime: NetlifyRuntime,
  input: DeployVersionInput<NetlifyDeployOptions>,
  context: IntegrationOperationContext,
): Promise<DeploymentData> {
  const siteId = requiredText(input.project, "Deployment project id");
  const environment = requiredText(input.environment, "Deployment environment") as DeploymentEnvironment;
  const idempotencyKey = requiredText(input.idempotencyKey, "Deployment idempotency key");
  const marker = idempotencyMarker(idempotencyKey);
  const credential = decodeCredential(context.credential);
  const existing = await findDeployment(runtime, credential, siteId, marker, context.signal);
  if (existing) return deploymentData(existing, environment);

  const prepared = prepareSource(runtime, input.files, input.providerOptions);
  const title = deploymentTitle(input.providerOptions?.title, marker);
  const requestBody = {
    files: Object.fromEntries(prepared.files.map((file) => [file.path, file.hash])),
    draft: environment !== "production",
    async: true,
    ...(prepared.functions.length > 0
      ? {
          functions: Object.fromEntries(prepared.functions.map((fn) => [fn.name, fn.hash])),
          functions_config: Object.fromEntries(
            prepared.functions.filter((fn) => fn.config).map((fn) => [fn.name, fn.config]),
          ),
        }
      : {}),
    ...(optionalText(input.providerOptions?.branch)
      ? { branch: netlifyBranch(input.providerOptions!.branch!) }
      : {}),
    ...(optionalText(input.providerOptions?.framework)
      ? { framework: optionalText(input.providerOptions!.framework)! }
      : {}),
    ...(optionalText(input.providerOptions?.frameworkVersion)
      ? { framework_version: optionalText(input.providerOptions!.frameworkVersion)! }
      : {}),
    environment: Object.entries(input.environmentVariables ?? {}).map(([key, value]) => ({
      key: environmentVariableName(key),
      value,
      is_secret: true,
      scopes: ["functions"],
    })),
  };
  let deployment = await netlifyRequest<NetlifyDeployResponse>(
    runtime,
    `/sites/${encodeURIComponent(siteId)}/deploys`,
    {
      method: "POST",
      credential,
      query: { title },
      json: requestBody,
      signal: context.signal,
      expected: [200, 201],
    },
  );
  deployment = await waitForDiff(runtime, credential, deployment, siteId, context.signal);
  const deploymentId = requiredProviderText(deployment.id, "Netlify deployment id");
  const requiredFiles = stringArray(deployment.required, "Netlify required file hash");
  const requiredFunctions = stringArray(deployment.required_functions, "Netlify required function hash");
  const fileByHash = groupedByHash(prepared.files);
  const functionByHash = new Map(prepared.functions.map((fn) => [fn.hash, fn]));
  const uploads = [
    ...requiredFiles.flatMap((hash) => (fileByHash.get(hash) ?? []).map((file) => async () => {
      await uploadFile(runtime, credential, deploymentId, file, context.signal);
    })),
    ...requiredFunctions.map((hash) => async () => {
      const fn = functionByHash.get(hash);
      if (!fn) {
        throw new NetlifyDeploymentError(`Netlify requested unknown function digest ${hash}.`, {
          code: "unknown_function_digest",
        });
      }
      await uploadFunction(runtime, credential, deploymentId, fn, context.signal);
    }),
  ];
  await mapConcurrent(uploads, runtime.concurrency, (upload) => upload());
  return deploymentData(deployment, environment);
}

async function getDeployment(
  runtime: NetlifyRuntime,
  id: string,
  context: IntegrationOperationContext,
): Promise<DeploymentData | null> {
  const locator = decodeDeploymentLocator(requiredText(id, "Deployment id"));
  const deployment = await netlifyRequest<NetlifyDeployResponse>(
    runtime,
    `/sites/${encodeURIComponent(locator.siteId)}/deploys/${encodeURIComponent(locator.deploymentId)}`,
    {
      credential: decodeCredential(context.credential),
      signal: context.signal,
      expected: [200, 404],
    },
  );
  return deployment ? deploymentData(deployment, locator.environment) : null;
}

async function findDeployment(
  runtime: NetlifyRuntime,
  credential: NetlifyCredentialData,
  siteId: string,
  marker: string,
  signal?: AbortSignal,
): Promise<NetlifyDeployResponse | null> {
  for (let page = 1; ; page += 1) {
    const deployments = await netlifyRequest<readonly NetlifyDeployResponse[]>(
      runtime,
      `/sites/${encodeURIComponent(siteId)}/deploys`,
      {
        credential,
        query: { page, per_page: DEPLOYS_PER_PAGE },
        signal,
      },
    );
    const found = deployments.find((deployment) => optionalText(deployment.title)?.includes(marker));
    if (found) return found;
    if (deployments.length < DEPLOYS_PER_PAGE) return null;
  }
}

function prepareSource(
  runtime: NetlifyRuntime,
  input: readonly IntegrationSourceFile[],
  options: NetlifyDeployOptions | undefined,
): { readonly files: readonly PreparedFile[]; readonly functions: readonly PreparedFunction[] } {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConfigurationError("A Netlify deployment requires an immutable prepared source snapshot.");
  }
  const normalized = input.map((file) => ({
    path: sourcePath(file.path),
    content: sourceBytes(file),
  }));
  const paths = new Set<string>();
  for (const file of normalized) {
    if (paths.has(file.path)) throw new ConfigurationError(`Duplicate deployment source path: ${file.path}`);
    paths.add(file.path);
  }
  const publishDirectory = sourceDirectory(options?.publishDirectory ?? ".", "Netlify publish directory");
  const functionDefinitions = options?.functions ?? [];
  const functionNames = new Set<string>();
  const functionDirectories = functionDefinitions.map((fn) => ({
    definition: normalizeFunctionDefinition(fn),
    directory: sourceDirectory(fn.directory, "Netlify function directory"),
  }));
  for (const { definition } of functionDirectories) {
    if (functionNames.has(definition.name)) {
      throw new ConfigurationError(`Duplicate Netlify function name: ${definition.name}`);
    }
    functionNames.add(definition.name);
  }
  const functionPrefixes = functionDirectories.map(({ directory }) => directory === "." ? "" : `${directory}/`);
  const publishPrefix = publishDirectory === "." ? "" : `${publishDirectory}/`;
  const files = normalized.flatMap((file): PreparedFile[] => {
    if (functionPrefixes.some((prefix) => !prefix || file.path.startsWith(prefix))) return [];
    if (publishPrefix && !file.path.startsWith(publishPrefix)) return [];
    const path = publishPrefix ? file.path.slice(publishPrefix.length) : file.path;
    if (!path) return [];
    if (file.content.byteLength > runtime.maxFileBytes) {
      throw new ConfigurationError(`Netlify asset ${path} exceeds ${runtime.maxFileBytes} bytes.`);
    }
    return [{ path, content: file.content, hash: sha1(file.content) }];
  });
  if (files.length === 0 && functionDirectories.length === 0) {
    throw new ConfigurationError(
      `Netlify requires prebuilt assets in ${publishDirectory}. Build the project first or configure providerOptions.publishDirectory.`,
    );
  }
  if (files.length > runtime.maxFiles) {
    throw new ConfigurationError(`Netlify deployment exceeds ${runtime.maxFiles} public files.`);
  }
  const functions = functionDirectories.map(({ definition, directory }): PreparedFunction => {
    const prefix = directory === "." ? "" : `${directory}/`;
    const entries = normalized.flatMap((file): Array<readonly [string, Uint8Array]> => {
      if (prefix && !file.path.startsWith(prefix)) return [];
      const path = prefix ? file.path.slice(prefix.length) : file.path;
      return path ? [[path, file.content] as const] : [];
    });
    if (entries.length === 0) {
      throw new ConfigurationError(`Netlify function ${definition.name} has no files in ${directory}.`);
    }
    const content = zipSync(Object.fromEntries(entries), { level: 6 });
    if (content.byteLength > runtime.maxFunctionBytes) {
      throw new ConfigurationError(
        `Netlify function ${definition.name} exceeds ${runtime.maxFunctionBytes} compressed bytes.`,
      );
    }
    return {
      name: definition.name,
      content,
      hash: sha1(content),
      runtime: definition.runtime,
      invocationMode: definition.invocationMode,
      timeout: definition.timeout,
      config: definition.config,
    };
  });
  return { files, functions };
}

function normalizeFunctionDefinition(input: NetlifyFunctionBundle): {
  readonly name: string;
  readonly runtime: string;
  readonly invocationMode: string;
  readonly timeout: number | null;
  readonly config: Record<string, unknown> | null;
} {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("A Netlify function bundle configuration is required.");
  }
  const name = requiredText(input.name, "Netlify function name");
  if (name.length > 128 || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new ConfigurationError("Netlify function names must be 1-128 safe filename characters.");
  }
  const invocationMode = optionalText(input.invocationMode) ?? "stream";
  const timeout = input.timeout === undefined
    ? null
    : integerInRange(input.timeout, "Netlify function timeout", 1, 900);
  return {
    name,
    runtime: optionalText(input.runtime) ?? "js",
    invocationMode,
    timeout,
    config: functionConfig(input.config),
  };
}

function functionConfig(input: NetlifyFunctionConfig | undefined): Record<string, unknown> | null {
  if (!input) return null;
  const config = compactRecord({
    display_name: optionalText(input.displayName),
    generator: optionalText(input.generator),
    routes: input.routes?.map((route) => routeData(route, true)),
    excluded_routes: input.excludedRoutes?.map((route) => routeData(route, false)),
    priority: input.priority,
    region: optionalText(input.region),
    memory: input.memory,
    vcpu: input.vcpu,
  });
  return Object.keys(config).length > 0 ? config : null;
}

function routeData(input: NetlifyFunctionRoute, allowMethods: boolean): Record<string, unknown> {
  if (!input || typeof input !== "object") throw new ConfigurationError("A Netlify function route is required.");
  const selectors = [input.pattern, input.literal, input.expression].map(optionalText).filter(isText);
  if (selectors.length !== 1) {
    throw new ConfigurationError("A Netlify function route requires exactly one pattern, literal, or expression.");
  }
  return compactRecord({
    pattern: optionalText(input.pattern),
    literal: optionalText(input.literal),
    expression: optionalText(input.expression),
    methods: allowMethods && input.methods
      ? input.methods.map((method) => requiredText(method, "Netlify function route method").toUpperCase())
      : undefined,
    prefer_static: allowMethods ? input.preferStatic : undefined,
  });
}

async function waitForDiff(
  runtime: NetlifyRuntime,
  credential: NetlifyCredentialData,
  initial: NetlifyDeployResponse,
  siteId: string,
  signal?: AbortSignal,
): Promise<NetlifyDeployResponse> {
  let deployment = initial;
  const deadline = Date.now() + runtime.diffTimeoutMs;
  while (diffPending(deployment)) {
    signal?.throwIfAborted();
    if (Date.now() >= deadline) {
      throw new NetlifyDeploymentError(
        `Netlify deployment ${requiredProviderText(deployment.id, "Netlify deployment id")} did not finish file diffing in time.`,
        { code: "deploy_diff_timeout" },
      );
    }
    await delay(runtime.pollIntervalMs, signal);
    deployment = await netlifyRequest<NetlifyDeployResponse>(
      runtime,
      `/sites/${encodeURIComponent(siteId)}/deploys/${encodeURIComponent(requiredProviderText(deployment.id, "Netlify deployment id"))}`,
      { credential, signal },
    );
  }
  if (deploymentStatus(deployment.state) === "failed") {
    throw new NetlifyDeploymentError(
      optionalText(deployment.error_message) ?? "Netlify rejected the deployment while preparing uploads.",
      { code: "deploy_failed" },
    );
  }
  return deployment;
}

function diffPending(value: NetlifyDeployResponse): boolean {
  const state = optionalText(value.state)?.toLowerCase();
  return state === "new" || state === "enqueued" || state === "building"
    || state === "preparing" || state === "processing" || state === "retrying";
}

async function uploadFile(
  runtime: NetlifyRuntime,
  credential: NetlifyCredentialData,
  deploymentId: string,
  file: PreparedFile,
  signal?: AbortSignal,
): Promise<void> {
  await netlifyRequest(runtime, `/deploys/${encodeURIComponent(deploymentId)}/files/${encodePath(file.path)}`, {
    method: "PUT",
    credential,
    query: { size: file.content.byteLength },
    headers: { "content-type": "application/octet-stream" },
    body: bytesBody(file.content),
    signal,
    expected: [200, 201],
  });
}

async function uploadFunction(
  runtime: NetlifyRuntime,
  credential: NetlifyCredentialData,
  deploymentId: string,
  fn: PreparedFunction,
  signal?: AbortSignal,
): Promise<void> {
  await netlifyRequest(
    runtime,
    `/deploys/${encodeURIComponent(deploymentId)}/functions/${encodeURIComponent(fn.name)}`,
    {
      method: "PUT",
      credential,
      query: {
        runtime: fn.runtime,
        invocation_mode: fn.invocationMode,
        timeout: fn.timeout,
        size: fn.content.byteLength,
      },
      headers: { "content-type": "application/octet-stream" },
      body: bytesBody(fn.content),
      signal,
      expected: [200, 201],
    },
  );
}

async function netlifyRequest<Result = Record<string, unknown>>(
  runtime: NetlifyRuntime,
  path: string,
  options: NetlifyRequestOptions = {},
): Promise<Result> {
  const url = new URL(path.startsWith("http")
    ? path
    : `${runtime.apiUrl}${path.startsWith("/") ? path : `/${path}`}`);
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
    throw new NetlifyDeploymentError("Could not reach the Netlify API.", { cause });
  }
  const payload = await responsePayload(response);
  const expected = options.expected ?? [200];
  if (!expected.includes(response.status)) throw netlifyResponseError(response.status, payload);
  if (response.status === 404) return null as Result;
  return payload as Result;
}

async function oauthRequest(
  runtime: NetlifyRuntime,
  options: { readonly body: URLSearchParams; readonly signal?: AbortSignal | undefined },
): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await runtime.fetch(runtime.tokenUrl, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: options.body,
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new NetlifyDeploymentError("Could not reach Netlify OAuth.", { cause });
  }
  const payload = await responsePayload(response);
  if (response.status !== 200) throw netlifyResponseError(response.status, payload);
  return record(payload) ?? {};
}

function projectData(value: NetlifySiteResponse): DeploymentProjectData {
  const url = optionalText(value.ssl_url) ?? optionalText(value.url) ?? optionalText(value.deploy_url);
  return {
    id: requiredProviderText(value.id, "Netlify site id"),
    name: requiredProviderText(value.name, "Netlify site name"),
    url: url ? httpUrl(url, "Netlify site URL") : null,
  };
}

function deploymentData(
  value: NetlifyDeployResponse,
  environment: string,
  statusOverride?: DeploymentData["status"],
): DeploymentData {
  const siteId = requiredProviderText(value.site_id, "Netlify site id");
  const nativeId = requiredProviderText(value.id, "Netlify deployment id");
  const url = optionalText(value.deploy_ssl_url) ?? optionalText(value.deploy_url)
    ?? optionalText(value.ssl_url) ?? optionalText(value.url);
  return {
    id: encodeDeploymentLocator({ siteId, deploymentId: nativeId, environment }),
    projectId: siteId,
    environment,
    status: statusOverride ?? deploymentStatus(value.state),
    url: url ? httpUrl(url, "Netlify deployment URL") : null,
    createdAt: providerDate(value.created_at, "Netlify deployment created time"),
  };
}

function deploymentStatus(value: unknown): DeploymentData["status"] {
  const state = optionalText(value)?.toLowerCase();
  if (state === "ready") return "ready";
  if (state === "error" || state === "rejected") return "failed";
  if (state === "cancelled" || state === "canceled") return "cancelled";
  if (["building", "uploading", "uploaded", "preparing", "prepared", "processing", "processed", "retrying"]
    .includes(state ?? "")) return "building";
  return "queued";
}

function accountData(value: NetlifyAccountResponse): NetlifyAccountData {
  return {
    id: requiredProviderText(value.id, "Netlify account id"),
    name: requiredProviderText(value.name, "Netlify account name"),
    slug: requiredProviderText(value.slug, "Netlify account slug"),
  };
}

function normalizeOptions(options: NetlifyDeploymentOptions): NetlifyRuntime {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Netlify deployment options are required.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ConfigurationError("A Fetch implementation is required for Netlify.");
  }
  return {
    clientId: requiredText(options.clientId, "Netlify OAuth client id"),
    clientSecret: requiredText(options.clientSecret, "Netlify OAuth client secret"),
    apiUrl: baseUrl(options.apiUrl ?? DEFAULT_API_URL, "Netlify API URL"),
    authorizationUrl: httpUrl(
      options.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL,
      "Netlify authorization URL",
    ),
    tokenUrl: httpUrl(options.tokenUrl ?? DEFAULT_TOKEN_URL, "Netlify token URL"),
    fetch: fetchImplementation,
    maxFiles: integerInRange(options.source?.maxFiles ?? DEFAULT_MAX_FILES, "Netlify max files", 1, 100_000),
    maxFileBytes: integerInRange(
      options.source?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
      "Netlify max file bytes",
      1,
      1024 * 1024 * 1024,
    ),
    maxFunctionBytes: integerInRange(
      options.source?.maxFunctionBytes ?? DEFAULT_MAX_FUNCTION_BYTES,
      "Netlify max function bytes",
      1,
      1024 * 1024 * 1024,
    ),
    concurrency: integerInRange(options.source?.concurrency ?? 6, "Netlify upload concurrency", 1, 32),
    diffTimeoutMs: integerInRange(
      options.diffTimeoutMs ?? DEFAULT_DIFF_TIMEOUT_MS,
      "Netlify deploy diff timeout",
      1,
      30 * 60_000,
    ),
    pollIntervalMs: integerInRange(
      options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS,
      "Netlify deploy poll interval",
      1,
      60_000,
    ),
  };
}

function netlifyProjectName(value: string): string {
  const name = requiredText(value, "Netlify project name");
  if (name.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new ConfigurationError(
      "Netlify project names must be 1-63 lowercase letters, numbers, or dashes and cannot start or end with a dash.",
    );
  }
  return name;
}

function netlifyBranch(value: string): string {
  const branch = requiredText(value, "Netlify deploy branch");
  if (branch.length > 255 || /[\u0000-\u001f\u007f]/.test(branch)) {
    throw new ConfigurationError("Netlify deploy branch is invalid.");
  }
  return branch;
}

function sourceDirectory(value: string, label: string): string {
  const directory = requiredText(value, label).replace(/\/$/, "");
  if (directory === ".") return directory;
  sourcePath(`${directory}/asset`);
  return directory;
}

function sourcePath(value: string): string {
  const path = requiredText(value, "Deployment source path");
  const segments = path.split("/");
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")
    || path.includes("#") || path.includes("?")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ConfigurationError(`Unsafe deployment source path: ${path}`);
  }
  return path;
}

function sourceBytes(file: IntegrationSourceFile): Uint8Array {
  if (!(file.content instanceof Uint8Array)) {
    throw new ConfigurationError(`Deployment source ${file.path} must contain Uint8Array bytes.`);
  }
  return file.content;
}

function environmentVariableName(value: string): string {
  if (value.length > 255 || !/^[A-Za-z][A-Za-z0-9_]*$/.test(value)) {
    throw new ConfigurationError(`Netlify environment variable name is invalid: ${value}`);
  }
  return value;
}

function idempotencyMarker(key: string): string {
  return `viby:${createHash("sha256").update(key).digest("hex").slice(0, 32)}`;
}

function deploymentTitle(value: string | undefined, marker: string): string {
  const title = optionalText(value);
  return title ? `${title.slice(0, 120)} [${marker}]` : marker;
}

function groupedByHash(files: readonly PreparedFile[]): ReadonlyMap<string, readonly PreparedFile[]> {
  const map = new Map<string, PreparedFile[]>();
  for (const file of files) map.set(file.hash, [...(map.get(file.hash) ?? []), file]);
  return map;
}

function sha1(value: Uint8Array): string {
  return createHash("sha1").update(value).digest("hex");
}

function encodeDeploymentLocator(value: NetlifyDeploymentLocator): string {
  return `nfd.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function decodeDeploymentLocator(value: string): NetlifyDeploymentLocator {
  try {
    if (!value.startsWith("nfd.")) throw new Error("invalid prefix");
    const parsed = JSON.parse(
      Buffer.from(value.slice(4), "base64url").toString("utf8"),
    ) as Partial<NetlifyDeploymentLocator>;
    return {
      siteId: requiredProviderText(parsed.siteId, "Netlify deployment site id"),
      deploymentId: requiredProviderText(parsed.deploymentId, "Netlify deployment id"),
      environment: requiredProviderText(parsed.environment, "Netlify deployment environment"),
    };
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("Netlify deployment id is invalid.", { cause });
  }
}

function decodeCursor(value: string | undefined): number {
  if (!value) return 1;
  const page = Number(value);
  return integerInRange(page, "Netlify project cursor", 1, Number.MAX_SAFE_INTEGER);
}

function encodeCredential(value: NetlifyCredentialData): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeCredential(value: Uint8Array): NetlifyCredentialData {
  try {
    const parsed = JSON.parse(textDecoder.decode(value)) as Partial<NetlifyCredentialData>;
    if (parsed.version !== 1 || !optionalText(parsed.accessToken)) throw new Error("invalid credential");
    return { version: 1, accessToken: parsed.accessToken! };
  } catch (cause) {
    throw new NetlifyDeploymentError("The stored Netlify credential is invalid.", { cause });
  }
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return null;
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function netlifyResponseError(status: number, payload: unknown): NetlifyDeploymentError {
  const value = record(payload);
  return new NetlifyDeploymentError(
    optionalText(value?.message) ?? optionalText(value?.error_description)
      ?? optionalText(value?.error) ?? (typeof payload === "string" ? payload : null)
      ?? `Netlify API request failed with status ${status}.`,
    { status, ...(optionalText(value?.code) ? { code: optionalText(value?.code)! } : {}) },
  );
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new NetlifyDeploymentError(`Netlify callback is missing ${name}.`, { status: 401 });
  return value;
}

function requiredText(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new ConfigurationError(`${label} is required.`);
  return value.trim();
}

function requiredProviderText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new NetlifyDeploymentError(`${label} was missing from the provider response.`);
  return text;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function integerInRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return value;
}

function stringArray(value: unknown, label: string): readonly string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new NetlifyDeploymentError(`${label} list was invalid.`);
  return value.map((item) => requiredProviderText(item, label));
}

function providerDate(value: unknown, label: string): Date {
  const text = optionalText(value);
  const date = text ? new Date(text) : new Date();
  if (Number.isNaN(date.getTime())) throw new NetlifyDeploymentError(`${label} was invalid.`);
  return date;
}

function httpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
    return url.href.replace(/\/$/, "");
  } catch (cause) {
    throw new ConfigurationError(`${label} must be an absolute HTTP(S) URL.`, { cause });
  }
}

function baseUrl(value: string, label: string): string {
  return httpUrl(value, label).replace(/\/$/, "");
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function compactRecord(input: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined && value !== null));
}

function isText(value: string | null): value is string {
  return value !== null;
}

function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function bytesBody(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
}

async function delay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(resolve, milliseconds);
    signal?.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Aborted"));
    }, { once: true });
  });
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  run: (value: Input, index: number) => Promise<Output>,
): Promise<readonly Output[]> {
  const output: Output[] = new Array(values.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (next < values.length) {
      const index = next++;
      output[index] = await run(values[index]!, index);
    }
  });
  await Promise.all(workers);
  return output;
}
