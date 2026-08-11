import { createHash } from "node:crypto";
import { blake3 } from "@noble/hashes/blake3";
import { bytesToHex } from "@noble/hashes/utils";
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
  IntegrationCredential,
  IntegrationExternalAccount,
  IntegrationOperationContext,
  IntegrationPage,
  IntegrationSourceFile,
  ListDeploymentProjectsInput,
} from "./integrations.js";

const DEFAULT_API_URL = "https://api.cloudflare.com/client/v4";
const DEFAULT_AUTHORIZATION_URL = "https://dash.cloudflare.com/oauth2/auth";
const DEFAULT_TOKEN_URL = "https://dash.cloudflare.com/oauth2/token";
const DEFAULT_REVOKE_URL = "https://dash.cloudflare.com/oauth2/revoke";
const DEFAULT_USER_INFO_URL = "https://dash.cloudflare.com/oauth2/userinfo";
const DEFAULT_ASSETS_DIRECTORY = "dist";
const MAX_ACCOUNTS_PER_PAGE = 50;
const PROJECTS_PER_PAGE = 100;
const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_FILE_BYTES = 25 * 1024 * 1024;
const DEFAULT_BATCH_BYTES = 40 * 1024 * 1024;
const DEFAULT_BATCH_FILES = 2_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

export interface CloudflareProjectOptions {
  /** Required when the connection can access more than one Cloudflare account. */
  readonly accountId?: string;
  readonly productionBranch?: string;
}

export interface CloudflareAccountData {
  readonly id: string;
  readonly name: string;
}

export interface CloudflareDeployOptions {
  /** Directory containing prebuilt Pages assets inside the immutable source snapshot. Defaults to `dist`. */
  readonly assetsDirectory?: string;
  /** Preview branch. Production deployments always use the project's production branch. */
  readonly branch?: string;
  readonly commitMessage?: string;
  readonly pagesBuildOutputDirectory?: string;
}

export interface CloudflareDeploymentOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly revokeUrl?: string;
  readonly userInfoUrl?: string;
  /** Scope identifiers configured on the Cloudflare OAuth client. */
  readonly scopes?: readonly string[];
  readonly tokenEndpointAuthMethod?: "client_secret_basic" | "client_secret_post";
  readonly fetch?: typeof globalThis.fetch;
  readonly source?: {
    readonly maxFiles?: number;
    readonly maxFileBytes?: number;
    readonly batchBytes?: number;
    readonly batchFiles?: number;
    readonly concurrency?: number;
  };
}

interface CloudflareCredentialData {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

interface CloudflareRuntime {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly userInfoUrl: string;
  readonly scopes: readonly string[];
  readonly tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post";
  readonly fetch: typeof globalThis.fetch;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly batchBytes: number;
  readonly batchFiles: number;
  readonly concurrency: number;
}

interface CloudflareRequestOptions {
  readonly method?: string;
  readonly credential?: CloudflareCredentialData;
  readonly authorization?: string;
  readonly query?: Readonly<Record<string, string | number | null | undefined>>;
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: BodyInit | null;
  readonly json?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly expected?: readonly number[];
}

interface CloudflareAccountResponse {
  readonly id?: unknown;
  readonly name?: unknown;
}

interface CloudflareProjectResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly subdomain?: unknown;
  readonly production_branch?: unknown;
  readonly canonical_deployment?: unknown;
}

interface CloudflareDeploymentResponse {
  readonly id?: unknown;
  readonly project_id?: unknown;
  readonly project_name?: unknown;
  readonly environment?: unknown;
  readonly url?: unknown;
  readonly aliases?: unknown;
  readonly created_on?: unknown;
  readonly latest_stage?: unknown;
  readonly deployment_trigger?: unknown;
}

interface ProjectLocator {
  readonly accountId: string;
  readonly project: CloudflareProjectResponse;
}

interface DeploymentLocator {
  readonly accountId: string;
  readonly projectName: string;
  readonly deploymentId: string;
}

interface AssetFile {
  readonly path: string;
  readonly assetPath: string;
  readonly content: Uint8Array;
  readonly mediaType: string;
  readonly hash: string;
}

interface CloudflareCursor {
  readonly account: number;
  readonly page: number;
  readonly offset: number;
}

export class CloudflareDeploymentError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: { readonly status?: number; readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CloudflareDeploymentError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** Creates a Cloudflare OAuth and Pages Direct Upload provider for `integrations.deployment`. */
export function cloudflare(
  options: CloudflareDeploymentOptions,
): DeploymentIntegration<CloudflareProjectOptions, CloudflareDeployOptions> {
  const runtime = normalizeOptions(options);
  return {
    provider: "cloudflare",
    displayName: "Cloudflare",
    connection: {
      async startAuthorization(input) {
        input.signal?.throwIfAborted();
        const url = new URL(runtime.authorizationUrl);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("client_id", runtime.clientId);
        url.searchParams.set("redirect_uri", input.callbackUrl);
        url.searchParams.set("state", input.state);
        const scopes = input.scopes ?? runtime.scopes;
        if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
        return { url: url.href, expiresAt: null };
      },
      async completeAuthorization(input, context) {
        return completeAuthorization(runtime, input.callbackUrl, context);
      },
      async refreshCredential(credential, context) {
        return refreshCredential(runtime, credential, context);
      },
      async revokeCredential(credential, context) {
        const current = decodeCredential(credential.secret);
        const body = tokenBody(runtime, {
          token: current.refreshToken ?? current.accessToken,
          token_type_hint: current.refreshToken ? "refresh_token" : "access_token",
        });
        await oauthRequest(runtime, runtime.revokeUrl, {
          body,
          authorization: tokenAuthorization(runtime),
          signal: context.signal,
          expected: [200, 204],
        });
      },
    },
    async listProjects(input, context) {
      return listProjects(runtime, input, context);
    },
    async getProject(input, context) {
      const locator = await locateProject(runtime, input, context);
      return locator ? projectData(locator.project) : null;
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
  };
}

export const cloudflareDeployment = cloudflare;

/** Reads the authorized account choices persisted with a Cloudflare connection. */
export function cloudflareAccounts(
  account: IntegrationExternalAccount,
): readonly CloudflareAccountData[] {
  const values = account.metadata?.accounts;
  if (!Array.isArray(values)) return [];
  return values.flatMap((value) => {
    const item = record(value);
    const id = optionalText(item?.id);
    const name = optionalText(item?.name);
    return id && name ? [{ id, name }] : [];
  });
}

async function completeAuthorization(
  runtime: CloudflareRuntime,
  callbackUrl: string,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationAuthorizationResult> {
  const callback = new URL(callbackUrl);
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    throw new CloudflareDeploymentError(
      callback.searchParams.get("error_description")
        || `Cloudflare authorization failed: ${providerError}`,
      { status: 401, code: providerError },
    );
  }
  const redirectUri = `${callback.origin}${callback.pathname}`;
  const token = await oauthRequest<Record<string, unknown>>(runtime, runtime.tokenUrl, {
    body: tokenBody(runtime, {
      grant_type: "authorization_code",
      code: requiredQuery(callback, "code"),
      redirect_uri: redirectUri,
    }),
    authorization: tokenAuthorization(runtime),
    signal: context.signal,
  });
  const accessToken = requiredProviderText(token.access_token, "Cloudflare access token");
  const user = await oauthRequest<Record<string, unknown>>(runtime, runtime.userInfoUrl, {
    method: "GET",
    authorization: `Bearer ${accessToken}`,
    signal: context.signal,
  });
  const subject = optionalText(user.sub) ?? optionalText(user.id)
    ?? `cloudflare_${createHash("sha256").update(accessToken).digest("hex").slice(0, 24)}`;
  const email = optionalText(user.email);
  const name = optionalText(user.name) ?? optionalText(user.preferred_username) ?? email
    ?? `Cloudflare account ${subject}`;
  const scopes = tokenScopes(token.scope, runtime.scopes);
  const credential = tokenCredential(token, null);
  const accounts = await listAccounts(runtime, credential.data, context.signal);
  return {
    account: {
      id: subject,
      name,
      metadata: {
        ...compactRecord({ email }),
        accounts: accounts.map((account) => ({
          id: requiredProviderText(account.id, "Cloudflare account id"),
          name: requiredProviderText(account.name, "Cloudflare account name"),
        })),
      },
    },
    credential: {
      secret: encodeCredential(credential.data),
      expiresAt: credential.expiresAt,
      scopes,
    },
  };
}

async function refreshCredential(
  runtime: CloudflareRuntime,
  credential: IntegrationCredential,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationCredential> {
  const current = decodeCredential(credential.secret);
  if (!current.refreshToken) {
    throw new CloudflareDeploymentError("The Cloudflare connection has no refresh token.", {
      status: 401,
      code: "missing_refresh_token",
    });
  }
  const token = await oauthRequest<Record<string, unknown>>(runtime, runtime.tokenUrl, {
    body: tokenBody(runtime, {
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    }),
    authorization: tokenAuthorization(runtime),
    signal: context.signal,
  });
  const refreshed = tokenCredential(token, current.refreshToken);
  return {
    secret: encodeCredential(refreshed.data),
    expiresAt: refreshed.expiresAt,
    scopes: tokenScopes(token.scope, credential.scopes),
  };
}

async function listProjects(
  runtime: CloudflareRuntime,
  input: ListDeploymentProjectsInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<DeploymentProjectData>> {
  const credential = decodeCredential(context.credential);
  const accounts = await listAccounts(runtime, credential, context.signal);
  const limit = integerInRange(input.limit ?? 20, "Project page limit", 1, 100);
  const search = optionalText(input.search)?.toLowerCase() ?? null;
  let cursor = decodeCursor(input.cursor);
  const items: DeploymentProjectData[] = [];

  while (cursor.account < accounts.length && items.length < limit) {
    const account = accounts[cursor.account]!;
    const accountId = requiredProviderText(account.id, "Cloudflare account id");
    const page = await cloudflareRequest<readonly CloudflareProjectResponse[]>(
      runtime,
      `/accounts/${encodeURIComponent(accountId)}/pages/projects`,
      {
        credential,
        query: { page: cursor.page, per_page: PROJECTS_PER_PAGE },
        signal: context.signal,
      },
    );
    const projects = page.result ?? [];
    for (let index = cursor.offset; index < projects.length; index += 1) {
      const project = projects[index]!;
      const name = requiredProviderText(project.name, "Cloudflare Pages project name");
      cursor = { account: cursor.account, page: cursor.page, offset: index + 1 };
      if (search && !name.toLowerCase().includes(search)) continue;
      items.push(projectData(project));
      if (items.length === limit) break;
    }
    if (items.length === limit && cursor.offset < projects.length) break;
    const totalPages = resultPages(page.resultInfo, cursor.page, projects.length);
    cursor = cursor.page < totalPages
      ? { account: cursor.account, page: cursor.page + 1, offset: 0 }
      : { account: cursor.account + 1, page: 1, offset: 0 };
  }
  return {
    items,
    nextCursor: cursor.account < accounts.length ? encodeCursor(cursor) : null,
  };
}

async function createProject(
  runtime: CloudflareRuntime,
  input: CreateDeploymentProjectInput<CloudflareProjectOptions>,
  context: IntegrationOperationContext,
): Promise<DeploymentProjectData> {
  const credential = decodeCredential(context.credential);
  const provider = input.providerOptions;
  const accounts = await listAccounts(runtime, credential, context.signal);
  const configuredAccount = optionalText(provider?.accountId);
  const account = configuredAccount
    ? accounts.find((candidate) => optionalText(candidate.id) === configuredAccount)
    : accounts.length === 1 ? accounts[0] : undefined;
  if (!account) {
    if (configuredAccount) {
      throw new ConfigurationError(`Cloudflare account ${configuredAccount} is not accessible.`);
    }
    throw new ConfigurationError(
      "Cloudflare project creation requires providerOptions.accountId when the connection can access multiple accounts.",
    );
  }
  const accountId = requiredProviderText(account.id, "Cloudflare account id");
  const name = cloudflareProjectName(input.name);
  const response = await cloudflareRequest<CloudflareProjectResponse>(
    runtime,
    `/accounts/${encodeURIComponent(accountId)}/pages/projects`,
    {
      method: "POST",
      credential,
      json: {
        name,
        production_branch: branchName(provider?.productionBranch ?? "main", "Production branch"),
      },
      signal: context.signal,
    },
  );
  return projectData(requiredResult(response.result, "Cloudflare Pages project"));
}

async function locateProject(
  runtime: CloudflareRuntime,
  input: { readonly id?: string; readonly name?: string },
  context: IntegrationOperationContext,
): Promise<ProjectLocator | null> {
  const id = optionalText(input.id);
  const name = optionalText(input.name);
  if ((id ? 1 : 0) + (name ? 1 : 0) !== 1) {
    throw new ConfigurationError("A Cloudflare project lookup requires exactly one id or name.");
  }
  const credential = decodeCredential(context.credential);
  const accounts = await listAccounts(runtime, credential, context.signal);
  const matches: ProjectLocator[] = [];
  for (const account of accounts) {
    const accountId = requiredProviderText(account.id, "Cloudflare account id");
    if (name) {
      const response = await cloudflareRequest<CloudflareProjectResponse>(
        runtime,
        `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(name)}`,
        { credential, signal: context.signal, expected: [200, 404] },
      );
      if (response.result) matches.push({ accountId, project: response.result });
      continue;
    }
    for (let pageNumber = 1; ; pageNumber += 1) {
      const response = await cloudflareRequest<readonly CloudflareProjectResponse[]>(
        runtime,
        `/accounts/${encodeURIComponent(accountId)}/pages/projects`,
        {
          credential,
          query: { page: pageNumber, per_page: PROJECTS_PER_PAGE },
          signal: context.signal,
        },
      );
      const projects = response.result ?? [];
      const project = projects.find((candidate) => optionalText(candidate.id) === id);
      if (project) matches.push({ accountId, project });
      if (pageNumber >= resultPages(response.resultInfo, pageNumber, projects.length)) break;
    }
  }
  if (matches.length > 1) {
    throw new ConfigurationError(
      `Cloudflare project ${name ?? id} is ambiguous across the connected accounts; use its unique project id.`,
    );
  }
  return matches[0] ?? null;
}

async function deployVersion(
  runtime: CloudflareRuntime,
  input: DeployVersionInput<CloudflareDeployOptions>,
  context: IntegrationOperationContext,
): Promise<DeploymentData> {
  const projectId = requiredText(input.project, "Deployment project id");
  const environment = requiredText(input.environment, "Deployment environment") as DeploymentEnvironment;
  const idempotencyKey = requiredText(input.idempotencyKey, "Deployment idempotency key");
  const provider = input.providerOptions;
  const assetsDirectory = sourceDirectory(provider?.assetsDirectory ?? DEFAULT_ASSETS_DIRECTORY);
  const files = normalizeAssets(runtime, input.files, assetsDirectory);
  const locator = await locateProject(runtime, { id: projectId }, context);
  if (!locator) {
    throw new CloudflareDeploymentError(`Cloudflare Pages project ${projectId} was not found.`, {
      status: 404,
      code: "project_not_found",
    });
  }
  const credential = decodeCredential(context.credential);
  const projectName = requiredProviderText(locator.project.name, "Cloudflare Pages project name");
  const commitHash = createHash("sha256").update(idempotencyKey).digest("hex").slice(0, 40);
  const existing = await findDeploymentByCommit(
    runtime,
    credential,
    locator.accountId,
    projectName,
    commitHash,
    context.signal,
  );
  if (existing) return deploymentData(locator.accountId, existing);

  const uploadToken = await cloudflareRequest<{ readonly jwt?: unknown }>(
    runtime,
    `/accounts/${encodeURIComponent(locator.accountId)}/pages/projects/${encodeURIComponent(projectName)}/upload-token`,
    { credential, signal: context.signal },
  );
  const jwt = requiredProviderText(uploadToken.result?.jwt, "Cloudflare Pages upload token");
  await uploadAssets(runtime, jwt, files.assets, context.signal);

  const manifest = Object.fromEntries(files.assets.map((file) => [`/${file.assetPath}`, file.hash]));
  const form = new FormData();
  form.set("manifest", JSON.stringify(manifest));
  form.set("commit_dirty", "false");
  form.set("commit_hash", commitHash);
  form.set("commit_message", optionalText(provider?.commitMessage) ?? `Viby deployment ${idempotencyKey}`);
  form.set(
    "pages_build_output_dir",
    sourceDirectory(provider?.pagesBuildOutputDirectory ?? assetsDirectory),
  );
  const production = environment === "production";
  if (!production) {
    form.set("branch", previewBranch(environment, provider?.branch, commitHash));
  }
  for (const file of files.special) {
    form.set(
      file.assetPath,
      new Blob([new Uint8Array(file.content).buffer as ArrayBuffer], { type: file.mediaType }),
      file.assetPath,
    );
  }
  const response = await cloudflareRequest<CloudflareDeploymentResponse>(
    runtime,
    `/accounts/${encodeURIComponent(locator.accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
    {
      method: "POST",
      credential,
      body: form,
      signal: context.signal,
    },
  );
  return deploymentData(
    locator.accountId,
    requiredResult(response.result, "Cloudflare Pages deployment"),
  );
}

async function getDeployment(
  runtime: CloudflareRuntime,
  id: string,
  context: IntegrationOperationContext,
): Promise<DeploymentData | null> {
  const locator = decodeDeploymentLocator(requiredText(id, "Deployment id"));
  const credential = decodeCredential(context.credential);
  const response = await cloudflareRequest<CloudflareDeploymentResponse>(
    runtime,
    `/accounts/${encodeURIComponent(locator.accountId)}/pages/projects/${encodeURIComponent(locator.projectName)}/deployments/${encodeURIComponent(locator.deploymentId)}`,
    { credential, signal: context.signal, expected: [200, 404] },
  );
  return response.result ? deploymentData(locator.accountId, response.result) : null;
}

async function findDeploymentByCommit(
  runtime: CloudflareRuntime,
  credential: CloudflareCredentialData,
  accountId: string,
  projectName: string,
  commitHash: string,
  signal?: AbortSignal,
): Promise<CloudflareDeploymentResponse | null> {
  for (let pageNumber = 1; ; pageNumber += 1) {
    const response = await cloudflareRequest<readonly CloudflareDeploymentResponse[]>(
      runtime,
      `/accounts/${encodeURIComponent(accountId)}/pages/projects/${encodeURIComponent(projectName)}/deployments`,
      {
        credential,
        query: { page: pageNumber, per_page: PROJECTS_PER_PAGE },
        signal,
      },
    );
    const deployments = response.result ?? [];
    const found = deployments.find((deployment) => {
      const trigger = record(deployment.deployment_trigger);
      const metadata = record(trigger?.metadata);
      return optionalText(metadata?.commit_hash) === commitHash;
    });
    if (found) return found;
    if (pageNumber >= resultPages(response.resultInfo, pageNumber, deployments.length)) return null;
  }
}

async function uploadAssets(
  runtime: CloudflareRuntime,
  jwt: string,
  files: readonly AssetFile[],
  signal?: AbortSignal,
): Promise<void> {
  const missingResponse = await cloudflareRequest<readonly unknown[]>(runtime, "/pages/assets/check-missing", {
    method: "POST",
    authorization: `Bearer ${jwt}`,
    json: { hashes: files.map((file) => file.hash) },
    signal,
  });
  const missing = new Set((missingResponse.result ?? []).map((value) => optionalText(value)).filter(isText));
  const batches = assetBatches(runtime, files.filter((file) => missing.has(file.hash)));
  await mapConcurrent(batches, runtime.concurrency, async (batch) => {
    await cloudflareRequest(runtime, "/pages/assets/upload", {
      method: "POST",
      authorization: `Bearer ${jwt}`,
      json: batch.map((file) => ({
        key: file.hash,
        value: Buffer.from(file.content).toString("base64"),
        metadata: { contentType: file.mediaType },
        base64: true,
      })),
      signal,
    });
  });
  try {
    await cloudflareRequest(runtime, "/pages/assets/upsert-hashes", {
      method: "POST",
      authorization: `Bearer ${jwt}`,
      json: { hashes: files.map((file) => file.hash) },
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    // Cloudflare documents this cache update as an optimization; uploaded assets remain deployable.
  }
}

function normalizeAssets(
  runtime: CloudflareRuntime,
  input: readonly IntegrationSourceFile[],
  directory: string,
): { readonly assets: readonly AssetFile[]; readonly special: readonly AssetFile[] } {
  if (!Array.isArray(input) || input.length === 0) {
    throw new ConfigurationError("A Cloudflare deployment requires an immutable source snapshot.");
  }
  const prefix = directory === "." ? "" : `${directory}/`;
  const paths = new Set<string>();
  const selected: AssetFile[] = [];
  for (const inputFile of input) {
    const path = sourcePath(inputFile.path);
    if (paths.has(path)) throw new ConfigurationError(`Duplicate deployment source path: ${path}`);
    paths.add(path);
    if (!(inputFile.content instanceof Uint8Array)) {
      throw new ConfigurationError(`Deployment source ${path} must contain Uint8Array bytes.`);
    }
    if (prefix && !path.startsWith(prefix)) continue;
    const assetPath = prefix ? path.slice(prefix.length) : path;
    if (!assetPath) continue;
    if (inputFile.content.byteLength > runtime.maxFileBytes) {
      throw new ConfigurationError(
        `Cloudflare Pages asset ${assetPath} exceeds ${runtime.maxFileBytes} bytes.`,
      );
    }
    selected.push({
      path,
      assetPath,
      content: inputFile.content,
      mediaType: optionalText(inputFile.mediaType) ?? contentType(assetPath),
      hash: cloudflareAssetHash(assetPath, inputFile.content),
    });
  }
  if (selected.length === 0) {
    throw new ConfigurationError(
      `Cloudflare Pages requires prebuilt assets in ${directory}. Build the project first or set providerOptions.assetsDirectory to the directory containing deployable assets.`,
    );
  }
  if (selected.length > runtime.maxFiles) {
    throw new ConfigurationError(`Cloudflare Pages deployment exceeds ${runtime.maxFiles} files.`);
  }
  const specialNames = new Set([
    "_headers",
    "_redirects",
    "_routes.json",
    "_worker.js",
    "_worker.bundle",
    "functions-filepath-routing-config.json",
  ]);
  const special = selected.filter((file) => specialNames.has(file.assetPath));
  if (special.some((file) => file.assetPath === "_worker.js")
    && special.some((file) => file.assetPath === "_worker.bundle")) {
    throw new ConfigurationError("Cloudflare Pages cannot deploy _worker.js and _worker.bundle together.");
  }
  return {
    assets: selected.filter((file) => !specialNames.has(file.assetPath)),
    special,
  };
}

function assetBatches(
  runtime: CloudflareRuntime,
  files: readonly AssetFile[],
): readonly (readonly AssetFile[])[] {
  const batches: AssetFile[][] = [];
  let batch: AssetFile[] = [];
  let bytes = 0;
  for (const file of [...files].sort((left, right) => right.content.byteLength - left.content.byteLength)) {
    if (batch.length > 0
      && (batch.length >= runtime.batchFiles || bytes + file.content.byteLength > runtime.batchBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(file);
    bytes += file.content.byteLength;
  }
  if (batch.length > 0) batches.push(batch);
  return batches;
}

async function listAccounts(
  runtime: CloudflareRuntime,
  credential: CloudflareCredentialData,
  signal?: AbortSignal,
): Promise<readonly CloudflareAccountResponse[]> {
  const accounts: CloudflareAccountResponse[] = [];
  for (let pageNumber = 1; ; pageNumber += 1) {
    const response = await cloudflareRequest<readonly CloudflareAccountResponse[]>(runtime, "/accounts", {
      credential,
      query: { page: pageNumber, per_page: MAX_ACCOUNTS_PER_PAGE },
      signal,
    });
    const page = response.result ?? [];
    accounts.push(...page);
    if (pageNumber >= resultPages(response.resultInfo, pageNumber, page.length)) break;
  }
  if (accounts.length === 0) {
    throw new CloudflareDeploymentError("The Cloudflare connection cannot access any accounts.", {
      status: 403,
      code: "no_accessible_accounts",
    });
  }
  return accounts;
}

interface CloudflareEnvelope<Result> {
  readonly result: Result | null;
  readonly resultInfo: Record<string, unknown> | null;
}

async function cloudflareRequest<Result = Record<string, unknown>>(
  runtime: CloudflareRuntime,
  path: string,
  options: CloudflareRequestOptions = {},
): Promise<CloudflareEnvelope<Result>> {
  const url = new URL(path.startsWith("http")
    ? path
    : `${runtime.apiUrl}${path.startsWith("/") ? path : `/${path}`}`);
  for (const [key, value] of Object.entries(options.query ?? {})) {
    if (value !== undefined && value !== null && value !== "") url.searchParams.set(key, String(value));
  }
  const headers = new Headers(options.headers);
  headers.set("accept", "application/json");
  if (options.authorization) headers.set("authorization", options.authorization);
  else if (options.credential) headers.set("authorization", `Bearer ${options.credential.accessToken}`);
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
    throw new CloudflareDeploymentError("Could not reach the Cloudflare API.", { cause });
  }
  const payload = await responsePayload(response);
  const expected = options.expected ?? [200];
  if (!expected.includes(response.status)) throw cloudflareResponseError(response.status, payload);
  if (response.status === 404) return { result: null, resultInfo: null };
  const envelope = record(payload);
  if (envelope && "success" in envelope && envelope.success === false) {
    throw cloudflareResponseError(response.status, payload);
  }
  return {
    result: (envelope && "result" in envelope ? envelope.result : payload) as Result,
    resultInfo: record(envelope?.result_info),
  };
}

async function oauthRequest<Result = Record<string, unknown>>(
  runtime: CloudflareRuntime,
  url: string,
  options: {
    readonly method?: string;
    readonly body?: URLSearchParams;
    readonly authorization?: string | undefined;
    readonly signal?: AbortSignal | undefined;
    readonly expected?: readonly number[];
  },
): Promise<Result> {
  const headers = new Headers({ accept: "application/json" });
  if (options.authorization) headers.set("authorization", options.authorization);
  if (options.body) headers.set("content-type", "application/x-www-form-urlencoded");
  let response: Response;
  try {
    response = await runtime.fetch(url, {
      method: options.method ?? "POST",
      headers,
      ...(options.body ? { body: options.body } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new CloudflareDeploymentError("Could not reach Cloudflare OAuth.", { cause });
  }
  const payload = await responsePayload(response);
  if (!(options.expected ?? [200]).includes(response.status)) {
    const value = record(payload);
    throw new CloudflareDeploymentError(
      optionalText(value?.error_description) ?? optionalText(value?.error)
        ?? `Cloudflare OAuth request failed with status ${response.status}.`,
      {
        status: response.status,
        ...(optionalText(value?.error) ? { code: String(value!.error) } : {}),
      },
    );
  }
  return (payload ?? {}) as Result;
}

function tokenBody(
  runtime: CloudflareRuntime,
  values: Readonly<Record<string, string>>,
): URLSearchParams {
  const body = new URLSearchParams(values);
  if (runtime.tokenEndpointAuthMethod === "client_secret_post") {
    body.set("client_id", runtime.clientId);
    body.set("client_secret", runtime.clientSecret);
  }
  return body;
}

function tokenAuthorization(runtime: CloudflareRuntime): string | undefined {
  return runtime.tokenEndpointAuthMethod === "client_secret_basic"
    ? `Basic ${Buffer.from(`${runtime.clientId}:${runtime.clientSecret}`).toString("base64")}`
    : undefined;
}

function tokenCredential(
  value: Record<string, unknown>,
  fallbackRefreshToken: string | null,
): { readonly data: CloudflareCredentialData; readonly expiresAt: Date | null } {
  const accessToken = requiredProviderText(value.access_token, "Cloudflare access token");
  const expiresIn = optionalNumber(value.expires_in);
  return {
    data: {
      version: 1,
      accessToken,
      refreshToken: optionalText(value.refresh_token) ?? fallbackRefreshToken,
    },
    expiresAt: expiresIn === null ? null : new Date(Date.now() + expiresIn * 1000),
  };
}

function projectData(value: CloudflareProjectResponse): DeploymentProjectData {
  const canonical = record(value.canonical_deployment);
  const subdomain = optionalText(value.subdomain);
  const deploymentUrl = optionalText(canonical?.url);
  return {
    id: requiredProviderText(value.id, "Cloudflare Pages project id"),
    name: requiredProviderText(value.name, "Cloudflare Pages project name"),
    url: deploymentUrl ? httpUrl(deploymentUrl, "Cloudflare Pages project URL")
      : subdomain ? httpUrl(`https://${subdomain}`, "Cloudflare Pages project URL")
        : null,
  };
}

function deploymentData(accountId: string, value: CloudflareDeploymentResponse): DeploymentData {
  const projectName = requiredProviderText(value.project_name, "Cloudflare Pages project name");
  const nativeId = requiredProviderText(value.id, "Cloudflare Pages deployment id");
  const latestStage = record(value.latest_stage);
  return {
    id: encodeDeploymentLocator({ accountId, projectName, deploymentId: nativeId }),
    projectId: requiredProviderText(value.project_id, "Cloudflare Pages project id"),
    environment: optionalText(value.environment) ?? "preview",
    status: deploymentStatus(latestStage?.status),
    url: deploymentUrl(value),
    createdAt: deploymentDate(value.created_on),
  };
}

function deploymentUrl(value: CloudflareDeploymentResponse): string | null {
  const url = optionalText(value.url);
  if (url) return httpUrl(url, "Cloudflare Pages deployment URL");
  if (Array.isArray(value.aliases)) {
    const alias = value.aliases.map(optionalText).find(isText);
    if (alias) return httpUrl(alias, "Cloudflare Pages deployment alias");
  }
  return null;
}

function deploymentStatus(value: unknown): DeploymentData["status"] {
  const status = optionalText(value)?.toLowerCase();
  if (status === "success") return "ready";
  if (status === "failure") return "failed";
  if (status === "canceled" || status === "cancelled") return "cancelled";
  if (status === "active") return "building";
  return "queued";
}

function normalizeOptions(options: CloudflareDeploymentOptions): CloudflareRuntime {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Cloudflare deployment options are required.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ConfigurationError("A Fetch implementation is required for Cloudflare.");
  }
  const maxFileBytes = integerInRange(
    options.source?.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES,
    "Cloudflare max file bytes",
    1,
    DEFAULT_MAX_FILE_BYTES,
  );
  const batchBytes = integerInRange(
    options.source?.batchBytes ?? DEFAULT_BATCH_BYTES,
    "Cloudflare upload batch bytes",
    maxFileBytes,
    DEFAULT_BATCH_BYTES,
  );
  const tokenEndpointAuthMethod = options.tokenEndpointAuthMethod ?? "client_secret_basic";
  if (tokenEndpointAuthMethod !== "client_secret_basic"
    && tokenEndpointAuthMethod !== "client_secret_post") {
    throw new ConfigurationError(
      "Cloudflare token endpoint authentication must be client_secret_basic or client_secret_post.",
    );
  }
  return {
    clientId: requiredText(options.clientId, "Cloudflare OAuth client id"),
    clientSecret: requiredText(options.clientSecret, "Cloudflare OAuth client secret"),
    apiUrl: baseUrl(options.apiUrl ?? DEFAULT_API_URL, "Cloudflare API URL"),
    authorizationUrl: httpUrl(options.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL, "Cloudflare authorization URL"),
    tokenUrl: httpUrl(options.tokenUrl ?? DEFAULT_TOKEN_URL, "Cloudflare token URL"),
    revokeUrl: httpUrl(options.revokeUrl ?? DEFAULT_REVOKE_URL, "Cloudflare revoke URL"),
    userInfoUrl: httpUrl(options.userInfoUrl ?? DEFAULT_USER_INFO_URL, "Cloudflare user info URL"),
    scopes: Object.freeze((options.scopes ?? []).map((scope) => requiredText(scope, "Cloudflare OAuth scope"))),
    tokenEndpointAuthMethod,
    fetch: fetchImplementation,
    maxFiles: integerInRange(options.source?.maxFiles ?? DEFAULT_MAX_FILES, "Cloudflare max files", 1, 100_000),
    maxFileBytes,
    batchBytes,
    batchFiles: integerInRange(
      options.source?.batchFiles ?? DEFAULT_BATCH_FILES,
      "Cloudflare upload batch files",
      1,
      DEFAULT_BATCH_FILES,
    ),
    concurrency: integerInRange(options.source?.concurrency ?? 3, "Cloudflare upload concurrency", 1, 16),
  };
}

function tokenScopes(value: unknown, fallback: readonly string[]): readonly string[] {
  if (Array.isArray(value)) return value.map((scope) => requiredProviderText(scope, "OAuth scope"));
  const text = optionalText(value);
  return text ? text.split(/\s+/).filter(Boolean) : fallback;
}

function cloudflareAssetHash(path: string, content: Uint8Array): string {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  const extension = dot > 0 ? name.slice(dot + 1) : "";
  const input = `${Buffer.from(content).toString("base64")}${extension}`;
  return bytesToHex(blake3(textEncoder.encode(input))).slice(0, 32);
}

function previewBranch(environment: string, configured: string | undefined, commitHash: string): string {
  if (configured) return branchName(configured, "Cloudflare preview branch");
  if (environment !== "preview") {
    const normalized = environment.toLowerCase().replace(/[^a-z0-9._/-]+/g, "-").slice(0, 100);
    if (normalized) return branchName(normalized, "Cloudflare preview branch");
  }
  return `viby-${commitHash.slice(0, 12)}`;
}

function branchName(value: string, label: string): string {
  const branch = requiredText(value, label);
  if (branch.length > 255 || branch.startsWith("/") || branch.endsWith("/")
    || branch.includes("..") || branch.includes("\\") || /[\u0000-\u001f\u007f ~^:?*[\]]/.test(branch)) {
    throw new ConfigurationError(`${label} is not a valid branch name.`);
  }
  return branch;
}

function cloudflareProjectName(value: string): string {
  const name = requiredText(value, "Cloudflare Pages project name");
  if (name.length > 58 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(name)) {
    throw new ConfigurationError(
      "Cloudflare Pages project name must be 1-58 lowercase letters, numbers, or dashes and cannot start or end with a dash.",
    );
  }
  return name;
}

function sourceDirectory(value: string): string {
  const directory = requiredText(value, "Cloudflare Pages assets directory").replace(/\/$/, "");
  if (directory === ".") return directory;
  sourcePath(`${directory}/asset`);
  return directory;
}

function sourcePath(value: string): string {
  const path = requiredText(value, "Deployment source path");
  const segments = path.split("/");
  if (path.startsWith("/") || path.endsWith("/") || path.includes("\\")
    || segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new ConfigurationError(`Unsafe deployment source path: ${path}`);
  }
  return path;
}

function contentType(path: string): string {
  const extension = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const types: Readonly<Record<string, string>> = {
    css: "text/css; charset=utf-8",
    csv: "text/csv; charset=utf-8",
    gif: "image/gif",
    html: "text/html; charset=utf-8",
    ico: "image/x-icon",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "application/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain; charset=utf-8",
    webmanifest: "application/manifest+json",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    xml: "application/xml; charset=utf-8",
  };
  return types[extension] ?? "application/octet-stream";
}

function encodeDeploymentLocator(value: DeploymentLocator): string {
  return `cfp.${Buffer.from(JSON.stringify(value)).toString("base64url")}`;
}

function decodeDeploymentLocator(value: string): DeploymentLocator {
  try {
    if (!value.startsWith("cfp.")) throw new Error("invalid prefix");
    const parsed = JSON.parse(Buffer.from(value.slice(4), "base64url").toString("utf8")) as Partial<DeploymentLocator>;
    return {
      accountId: requiredProviderText(parsed.accountId, "Cloudflare deployment account id"),
      projectName: requiredProviderText(parsed.projectName, "Cloudflare deployment project name"),
      deploymentId: requiredProviderText(parsed.deploymentId, "Cloudflare deployment id"),
    };
  } catch (cause) {
    throw new ConfigurationError("Cloudflare deployment id is invalid.", { cause });
  }
}

function encodeCursor(value: CloudflareCursor): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeCursor(value: string | undefined): CloudflareCursor {
  if (!value) return { account: 0, page: 1, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<CloudflareCursor>;
    return {
      account: integerInRange(parsed.account ?? -1, "Cloudflare cursor account", 0, Number.MAX_SAFE_INTEGER),
      page: integerInRange(parsed.page ?? -1, "Cloudflare cursor page", 1, Number.MAX_SAFE_INTEGER),
      offset: integerInRange(parsed.offset ?? -1, "Cloudflare cursor offset", 0, PROJECTS_PER_PAGE),
    };
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("Cloudflare project cursor is invalid.", { cause });
  }
}

function encodeCredential(value: CloudflareCredentialData): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeCredential(value: Uint8Array): CloudflareCredentialData {
  try {
    const parsed = JSON.parse(textDecoder.decode(value)) as Partial<CloudflareCredentialData>;
    if (parsed.version !== 1 || !optionalText(parsed.accessToken)) throw new Error("invalid credential");
    return {
      version: 1,
      accessToken: parsed.accessToken!,
      refreshToken: optionalText(parsed.refreshToken),
    };
  } catch (cause) {
    throw new CloudflareDeploymentError("The stored Cloudflare credential is invalid.", { cause });
  }
}

function resultPages(info: Record<string, unknown> | null, current: number, count: number): number {
  const totalPages = optionalNumber(info?.total_pages);
  if (totalPages !== null) return Math.max(current, Math.trunc(totalPages));
  return count < PROJECTS_PER_PAGE ? current : current + 1;
}

function cloudflareResponseError(status: number, payload: unknown): CloudflareDeploymentError {
  const envelope = record(payload);
  const errors = Array.isArray(envelope?.errors) ? envelope.errors : [];
  const first = record(errors[0]);
  return new CloudflareDeploymentError(
    optionalText(first?.message) ?? `Cloudflare API request failed with status ${status}.`,
    {
      status,
      ...(optionalText(first?.code) ? { code: String(first!.code) } : {}),
    },
  );
}

async function responsePayload(response: Response): Promise<unknown> {
  if (response.status === 204) return {};
  const text = await response.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return { errors: [{ message: text.slice(0, 500) }] };
  }
}

function requiredQuery(url: URL, name: string): string {
  const value = optionalText(url.searchParams.get(name));
  if (!value) {
    throw new CloudflareDeploymentError(`Cloudflare callback is missing ${name}.`, { status: 400 });
  }
  return value;
}

function requiredText(value: unknown, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new ConfigurationError(`${label} is required.`);
  return normalized;
}

function requiredProviderText(value: unknown, label: string): string {
  const normalized = optionalText(value);
  if (!normalized) throw new CloudflareDeploymentError(`${label} is missing from the provider response.`);
  return normalized;
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim()
    : typeof value === "number" && Number.isFinite(value) ? String(value)
      : null;
}

function optionalNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
  return null;
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

function requiredResult<Value>(value: Value | null, label: string): Value {
  if (value === null || value === undefined) {
    throw new CloudflareDeploymentError(`${label} is missing from the provider response.`);
  }
  return value;
}

function integerInRange(value: number, label: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value;
}

function httpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
    return url.href.replace(/\/$/, "");
  } catch (cause) {
    throw new ConfigurationError(`${label} must be an absolute HTTP URL.`, { cause });
  }
}

function baseUrl(value: string, label: string): string {
  return httpUrl(value, label).replace(/\/$/, "");
}

function deploymentDate(value: unknown): Date {
  const date = new Date(requiredProviderText(value, "Cloudflare Pages deployment creation time"));
  if (Number.isNaN(date.getTime())) {
    throw new CloudflareDeploymentError("Cloudflare returned an invalid deployment creation time.");
  }
  return date;
}

function isText(value: string | null): value is string {
  return value !== null;
}

async function mapConcurrent<Input, Output>(
  input: readonly Input[],
  concurrency: number,
  mapper: (value: Input) => Promise<Output>,
): Promise<readonly Output[]> {
  const output = new Array<Output>(input.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, input.length) }, async () => {
    while (next < input.length) {
      const index = next;
      next += 1;
      output[index] = await mapper(input[index]!);
    }
  }));
  return output;
}
