import { randomBytes } from "node:crypto";
import { ConfigurationError } from "./errors.js";
import type {
  CreateRepositoryBranchInput,
  CreateRepositoryInput,
  CreateRepositoryPullRequestInput,
  GetRepositoryBranchInput,
  IntegrationAuthorizationContext,
  IntegrationAuthorizationResult,
  IntegrationCredential,
  IntegrationOperationContext,
  IntegrationPage,
  IntegrationSourceFile,
  ListRepositoriesInput,
  ListRepositoryBranchesInput,
  ListRepositoryOwnersInput,
  MergeRepositoryPullRequestInput,
  PushRepositoryVersionInput,
  PushRepositoryVersionResult,
  ReadRepositorySourceInput,
  RepositoryBranchData,
  RepositoryCommitData,
  RepositoryData,
  RepositoryIntegration,
  RepositoryOwnerData,
  RepositoryPullRequestData,
  RepositoryReference,
  RepositorySourceData,
  RepositorySourceReference,
} from "./integrations.js";
import { normalizeProjectPath } from "./utils.js";

const DEFAULT_API_URL = "https://api.bitbucket.org/2.0";
const DEFAULT_AUTHORIZATION_URL = "https://bitbucket.org/site/oauth2/authorize";
const DEFAULT_TOKEN_URL = "https://bitbucket.org/site/oauth2/access_token";
const DEFAULT_SCOPES = Object.freeze([
  "account",
  "repository",
  "repository:write",
  "repository:admin",
  "pullrequest",
  "pullrequest:write",
]);
const DEFAULT_SOURCE_FILES = 5_000;
const DEFAULT_SOURCE_BYTES = 25_000_000;
const DEFAULT_CONCURRENCY = 8;
const PAGE_LENGTH = 100;
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

export interface BitbucketPushOptions {
  /** Optional Bitbucket author string, for example `Ada <ada@example.com>`. */
  readonly author?: string;
}

export interface BitbucketPullRequestOptions {
  readonly reviewers?: readonly string[];
  readonly closeSourceBranch?: boolean;
}

export interface BitbucketMergeOptions {
  readonly message?: string;
  readonly closeSourceBranch?: boolean;
}

export interface BitbucketRepositoryOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  /** OAuth consumer scopes used for connection discovery; Bitbucket still grants its configured scopes. */
  readonly scopes?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly source?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
    readonly concurrency?: number;
  };
}

interface BitbucketCredentialData {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string | null;
}

interface BitbucketRuntime {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly apiUrl: string;
  readonly apiOrigin: string;
  readonly apiPath: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly scopes: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly concurrency: number;
}

interface BitbucketRequestOptions {
  readonly method?: string;
  readonly credential?: BitbucketCredentialData;
  readonly basic?: string;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly form?: URLSearchParams;
  readonly body?: BodyInit | Uint8Array;
  readonly signal?: AbortSignal | undefined;
  readonly expected?: readonly number[];
}

interface BitbucketPage<Value> {
  readonly values?: readonly Value[];
  readonly next?: unknown;
  readonly size?: unknown;
  readonly page?: unknown;
  readonly pagelen?: unknown;
}

interface BitbucketLinks {
  readonly html?: { readonly href?: unknown };
  readonly avatar?: { readonly href?: unknown };
  readonly self?: { readonly href?: unknown };
}

interface BitbucketWorkspaceResponse {
  readonly uuid?: unknown;
  readonly slug?: unknown;
  readonly name?: unknown;
  readonly links?: BitbucketLinks;
}

interface BitbucketWorkspaceAccessResponse {
  readonly workspace?: BitbucketWorkspaceResponse;
}

interface BitbucketRepositoryResponse {
  readonly uuid?: unknown;
  readonly slug?: unknown;
  readonly full_name?: unknown;
  readonly name?: unknown;
  readonly is_private?: unknown;
  readonly mainbranch?: { readonly name?: unknown } | null;
  readonly workspace?: BitbucketWorkspaceResponse;
  readonly owner?: { readonly nickname?: unknown; readonly username?: unknown };
  readonly links?: BitbucketLinks;
}

interface BitbucketCommitResponse {
  readonly hash?: unknown;
  readonly message?: unknown;
  readonly links?: BitbucketLinks;
}

interface BitbucketBranchResponse {
  readonly name?: unknown;
  readonly target?: BitbucketCommitResponse;
}

interface BitbucketTreeEntry {
  readonly type?: unknown;
  readonly path?: unknown;
  readonly size?: unknown;
  readonly attributes?: readonly unknown[];
  readonly links?: BitbucketLinks & { readonly meta?: { readonly href?: unknown } };
}

interface BitbucketPullRequestResponse {
  readonly id?: unknown;
  readonly title?: unknown;
  readonly state?: unknown;
  readonly draft?: unknown;
  readonly links?: BitbucketLinks;
  readonly source?: {
    readonly branch?: { readonly name?: unknown };
    readonly commit?: { readonly hash?: unknown };
  };
  readonly destination?: { readonly branch?: { readonly name?: unknown } };
}

interface RepositoryCursor {
  readonly workspace: number;
  readonly pageUrl: string | null;
  readonly offset: number;
}

interface RemoteSourceFile extends IntegrationSourceFile {
  readonly executable?: boolean;
}

export class BitbucketRepositoryError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: { readonly status?: number; readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BitbucketRepositoryError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** Creates a Bitbucket Cloud OAuth provider for `integrations.repository`. */
export function bitbucket(
  options: BitbucketRepositoryOptions,
): RepositoryIntegration<BitbucketPushOptions, BitbucketPullRequestOptions, BitbucketMergeOptions> {
  const runtime = normalizeOptions(options);
  return {
    provider: "bitbucket",
    displayName: "Bitbucket",
    connection: {
      async startAuthorization(input) {
        input.signal?.throwIfAborted();
        const url = new URL(runtime.authorizationUrl);
        url.searchParams.set("client_id", runtime.clientId);
        url.searchParams.set("response_type", "code");
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
    },
    async listOwners(input, context) {
      return listOwners(runtime, input, context);
    },
    async listRepositories(input, context) {
      return listRepositories(runtime, input, context);
    },
    async getRepository(input, context) {
      return getRepository(runtime, input, context);
    },
    async createRepository(input, context) {
      return createRepository(runtime, input, context);
    },
    async listBranches(input, context) {
      return listBranches(runtime, input, context);
    },
    async getBranch(input, context) {
      return getBranch(runtime, input, context);
    },
    async createBranch(input, context) {
      return createBranch(runtime, input, context);
    },
    async readSource(input, context) {
      return readSource(runtime, input, context);
    },
    async pushVersion(input, context) {
      return pushVersion(runtime, input, context);
    },
    async createPullRequest(input, context) {
      return createPullRequest(runtime, input, context);
    },
    async mergePullRequest(input, context) {
      return mergePullRequest(runtime, input, context);
    },
  };
}

export const bitbucketRepository = bitbucket;

async function completeAuthorization(
  runtime: BitbucketRuntime,
  callbackUrl: string,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationAuthorizationResult> {
  const callback = new URL(callbackUrl);
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    throw new BitbucketRepositoryError(
      callback.searchParams.get("error_description") || `Bitbucket authorization failed: ${providerError}`,
      { status: 401, code: providerError },
    );
  }
  const token = await tokenRequest(runtime, new URLSearchParams({
    grant_type: "authorization_code",
    code: requiredQuery(callback, "code"),
  }), context.signal);
  const credential = tokenCredential(token, null);
  const user = await bitbucketRequest<Record<string, unknown>>(runtime, "/user", {
    credential: credential.data,
    signal: context.signal,
  });
  const id = optionalText(user.uuid) ?? optionalText(user.account_id)
    ?? requiredProviderText(user.nickname, "Bitbucket user id");
  const name = optionalText(user.display_name) ?? optionalText(user.nickname) ?? id;
  const links = record(user.links);
  const html = record(links?.html);
  const avatar = record(links?.avatar);
  return {
    account: {
      id,
      name,
      ...(optionalText(html?.href) ? { url: String(html!.href) } : {}),
      metadata: {
        ...(optionalText(user.nickname) ? { nickname: String(user.nickname) } : {}),
        ...(optionalText(avatar?.href) ? { avatarUrl: String(avatar!.href) } : {}),
      },
    },
    credential: {
      secret: encodeCredential(credential.data),
      expiresAt: credential.expiresAt,
      scopes: tokenScopes(token, runtime.scopes),
    },
  };
}

async function refreshCredential(
  runtime: BitbucketRuntime,
  credential: IntegrationCredential,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationCredential> {
  const current = decodeCredential(credential.secret);
  if (!current.refreshToken) {
    throw new BitbucketRepositoryError("The Bitbucket connection must be authorized again.", {
      status: 401,
      code: "missing_refresh_token",
    });
  }
  const token = await tokenRequest(runtime, new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: current.refreshToken,
  }), context.signal);
  const refreshed = tokenCredential(token, current.refreshToken);
  return {
    secret: encodeCredential(refreshed.data),
    expiresAt: refreshed.expiresAt,
    scopes: tokenScopes(token, credential.scopes),
  };
}

async function listOwners(
  runtime: BitbucketRuntime,
  input: ListRepositoryOwnersInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryOwnerData>> {
  const credential = decodeCredential(context.credential);
  const limit = boundedInteger(input.limit, 20, 1, 100, "Workspace page limit");
  const path = input.cursor
    ? decodePageCursor(runtime, input.cursor, "/user/workspaces")
    : `/user/workspaces?pagelen=${limit}`;
  const page = await bitbucketRequest<BitbucketPage<BitbucketWorkspaceAccessResponse>>(
    runtime,
    path,
    { credential, signal: context.signal },
  );
  return {
    items: (page.values ?? []).map((access) => ownerData(
      requiredResult(access.workspace, "Bitbucket workspace"),
    )),
    nextCursor: optionalText(page.next) ? encodePageCursor(String(page.next)) : null,
  };
}

async function listRepositories(
  runtime: BitbucketRuntime,
  input: ListRepositoriesInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryData>> {
  const credential = decodeCredential(context.credential);
  const workspaces = (await allWorkspaces(runtime, credential, context.signal))
    .filter((workspace) => !input.owner || optionalText(workspace.slug) === input.owner);
  const limit = boundedInteger(input.limit, 20, 1, 100, "Repository page limit");
  const search = optionalText(input.search)?.toLowerCase() ?? null;
  let cursor = decodeRepositoryCursor(input.cursor);
  const items: RepositoryData[] = [];

  while (cursor.workspace < workspaces.length && items.length < limit) {
    const workspace = workspaces[cursor.workspace]!;
    const slug = requiredProviderText(workspace.slug, "Bitbucket workspace slug");
    const path = cursor.pageUrl
      ? validateApiCursor(runtime, cursor.pageUrl, `/repositories/${encodeURIComponent(slug)}`)
      : `/repositories/${encodeURIComponent(slug)}?pagelen=${PAGE_LENGTH}`;
    const page = await bitbucketRequest<BitbucketPage<BitbucketRepositoryResponse>>(
      runtime,
      path,
      { credential, signal: context.signal },
    );
    const values = page.values ?? [];
    for (let index = cursor.offset; index < values.length; index += 1) {
      const repository = values[index]!;
      cursor = { workspace: cursor.workspace, pageUrl: path, offset: index + 1 };
      const mapped = repositoryData(repository);
      if (search && !mapped.name.toLowerCase().includes(search)) continue;
      items.push(mapped);
      if (items.length === limit) break;
    }
    if (items.length === limit && cursor.offset < values.length) break;
    const next = optionalText(page.next);
    cursor = next
      ? { workspace: cursor.workspace, pageUrl: next, offset: 0 }
      : { workspace: cursor.workspace + 1, pageUrl: null, offset: 0 };
  }
  return {
    items,
    nextCursor: cursor.workspace < workspaces.length ? encodeRepositoryCursor(cursor) : null,
  };
}

async function getRepository(
  runtime: BitbucketRuntime,
  input: RepositoryReference,
  context: IntegrationOperationContext,
): Promise<RepositoryData | null> {
  const credential = decodeCredential(context.credential);
  const response = await bitbucketRequestOrNull<BitbucketRepositoryResponse>(
    runtime,
    repositoryPath(input),
    { credential, signal: context.signal },
  );
  return response ? repositoryData(response) : null;
}

async function createRepository(
  runtime: BitbucketRuntime,
  input: CreateRepositoryInput,
  context: IntegrationOperationContext,
): Promise<RepositoryData> {
  if (input.visibility === "internal") {
    throw new ConfigurationError("Bitbucket Cloud repositories support private or public visibility, not internal visibility.");
  }
  const credential = decodeCredential(context.credential);
  const name = repositoryName(input.name);
  const response = await bitbucketRequest<BitbucketRepositoryResponse>(
    runtime,
    `/repositories/${segment(input.owner)}/${segment(name)}`,
    {
      method: "POST",
      credential,
      json: {
        scm: "git",
        name,
        is_private: input.visibility !== "public",
        ...(input.description !== undefined ? { description: input.description } : {}),
        mainbranch: { name: "main" },
      },
      signal: context.signal,
      expected: [200, 201],
    },
  );
  return repositoryData(response);
}

async function listBranches(
  runtime: BitbucketRuntime,
  input: ListRepositoryBranchesInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryBranchData>> {
  const credential = decodeCredential(context.credential);
  const limit = boundedInteger(input.limit, 20, 1, 100, "Branch page limit");
  const prefix = `${repositoryPath(input.repository)}/refs/branches`;
  const path = input.cursor
    ? decodePageCursor(runtime, input.cursor, prefix)
    : `${prefix}?pagelen=${limit}`;
  const page = await bitbucketRequest<BitbucketPage<BitbucketBranchResponse>>(runtime, path, {
    credential,
    signal: context.signal,
  });
  return {
    items: (page.values ?? []).map(branchData),
    nextCursor: optionalText(page.next) ? encodePageCursor(String(page.next)) : null,
  };
}

async function getBranch(
  runtime: BitbucketRuntime,
  input: GetRepositoryBranchInput,
  context: IntegrationOperationContext,
): Promise<RepositoryBranchData | null> {
  const credential = decodeCredential(context.credential);
  const response = await getBranchResponse(runtime, input.repository, input.name, credential, context.signal);
  return response ? branchData(response) : null;
}

async function createBranch(
  runtime: BitbucketRuntime,
  input: CreateRepositoryBranchInput,
  context: IntegrationOperationContext,
): Promise<RepositoryBranchData> {
  const credential = decodeCredential(context.credential);
  return branchData(await createBranchResponse(
    runtime,
    input.repository,
    input.name,
    input.from,
    credential,
    context.signal,
  ));
}

async function readSource(
  runtime: BitbucketRuntime,
  input: ReadRepositorySourceInput,
  context: IntegrationOperationContext,
): Promise<RepositorySourceData> {
  const credential = decodeCredential(context.credential);
  const repository = await bitbucketRequest<BitbucketRepositoryResponse>(
    runtime,
    repositoryPath(input.repository),
    { credential, signal: context.signal },
  );
  const resolved = await resolveSourceReference(
    runtime,
    input.repository,
    input.ref,
    credential,
    context.signal,
  );
  const files = await readSourceFiles(
    runtime,
    input.repository,
    resolved.commit,
    credential,
    context.signal,
  );
  return {
    repository: repositoryData(repository),
    ref: input.ref,
    commit: resolved.commit,
    files,
  };
}

async function pushVersion(
  runtime: BitbucketRuntime,
  input: PushRepositoryVersionInput<BitbucketPushOptions>,
  context: IntegrationOperationContext,
): Promise<PushRepositoryVersionResult> {
  const files = validateSourceFiles(runtime, input.files);
  const credential = decodeCredential(context.credential);
  const target = await getBranchResponse(
    runtime,
    input.repository,
    input.branch,
    credential,
    context.signal,
  );
  if (!target && !input.createBranch) {
    throw new BitbucketRepositoryError(`Bitbucket branch ${input.branch} does not exist.`, {
      status: 404,
    });
  }

  let parent = target?.target ? commitHash(target.target) : null;
  if (!parent && input.baseBranch) {
    const base = await getBranchResponse(
      runtime,
      input.repository,
      input.baseBranch,
      credential,
      context.signal,
    );
    if (!base?.target) {
      throw new BitbucketRepositoryError(`Bitbucket base branch ${input.baseBranch} does not exist.`, {
        status: 404,
      });
    }
    parent = commitHash(base.target);
  }
  if (input.expectedHead !== undefined && input.expectedHead !== parent) {
    if (!parent) {
      throw new BitbucketRepositoryError(
        "Bitbucket cannot compare an expected head with a repository that has no commits.",
        { status: 409, code: "head_missing" },
      );
    }
    return { status: "conflict", expectedHead: input.expectedHead, actualHead: parent };
  }

  const previous = parent
    ? await readSourceFiles(
        runtime,
        input.repository,
        parent,
        credential,
        context.signal,
      )
    : [];
  const changes = sourceChanges(previous, files);
  if (changes.changedFiles === 0 && parent) {
    return {
      status: "pushed",
      commit: { id: parent, message: input.message, branch: input.branch, url: null },
      changedFiles: 0,
    };
  }
  if (changes.changedFiles === 0) {
    throw new BitbucketRepositoryError(
      "Bitbucket cannot initialize an empty repository without at least one file.",
      { status: 422 },
    );
  }

  const multipart = createSourceMultipart({
    branch: input.branch,
    message: input.message,
    parent,
    ...(input.providerOptions?.author ? { author: input.providerOptions.author } : {}),
    files: changes.upserted,
    deleted: changes.deleted,
  });
  let commit: BitbucketCommitResponse;
  try {
    commit = await bitbucketRequest<BitbucketCommitResponse>(
      runtime,
      `${repositoryPath(input.repository)}/src`,
      {
        method: "POST",
        credential,
        headers: { "content-type": `multipart/form-data; boundary=${multipart.boundary}` },
        body: multipart.body,
        signal: context.signal,
        expected: [200, 201],
      },
    );
  } catch (error) {
    if (!(error instanceof BitbucketRepositoryError) || ![400, 409].includes(error.status ?? 0)) {
      throw error;
    }
    const actual = await getBranchResponse(
      runtime,
      input.repository,
      input.branch,
      credential,
      context.signal,
    );
    const actualHead = actual?.target ? commitHash(actual.target) : null;
    if (!actualHead || actualHead === parent) throw error;
    return {
      status: "conflict",
      expectedHead: input.expectedHead ?? parent,
      actualHead,
    };
  }
  return {
    status: "pushed",
    commit: commitData(commit, input.branch, input.message),
    changedFiles: changes.changedFiles,
  };
}

async function createPullRequest(
  runtime: BitbucketRuntime,
  input: CreateRepositoryPullRequestInput<BitbucketPullRequestOptions>,
  context: IntegrationOperationContext,
): Promise<RepositoryPullRequestData> {
  const credential = decodeCredential(context.credential);
  const response = await bitbucketRequest<BitbucketPullRequestResponse>(
    runtime,
    `${repositoryPath(input.repository)}/pullrequests`,
    {
      method: "POST",
      credential,
      json: {
        title: input.title,
        source: { branch: { name: input.head } },
        destination: { branch: { name: input.base } },
        ...(input.body !== undefined ? { description: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
        ...(input.providerOptions?.closeSourceBranch !== undefined
          ? { close_source_branch: input.providerOptions.closeSourceBranch }
          : {}),
        ...(input.providerOptions?.reviewers
          ? { reviewers: input.providerOptions.reviewers.map((uuid) => ({ uuid })) }
          : {}),
      },
      signal: context.signal,
      expected: [200, 201],
    },
  );
  return pullRequestData(response);
}

async function mergePullRequest(
  runtime: BitbucketRuntime,
  input: MergeRepositoryPullRequestInput<BitbucketMergeOptions>,
  context: IntegrationOperationContext,
): Promise<RepositoryPullRequestData> {
  const credential = decodeCredential(context.credential);
  const path = `${repositoryPath(input.repository)}/pullrequests/${input.number}`;
  const current = await bitbucketRequest<BitbucketPullRequestResponse>(runtime, path, {
    credential,
    signal: context.signal,
  });
  if (String(current.state).toUpperCase() === "MERGED") return pullRequestData(current);
  const currentHead = requiredProviderText(current.source?.commit?.hash, "Bitbucket pull request head");
  if (input.expectedHead && input.expectedHead !== currentHead) {
    throw new BitbucketRepositoryError("The Bitbucket pull request head changed before merge.", {
      status: 409,
      code: "head_changed",
    });
  }
  await bitbucketRequest(runtime, `${path}/merge?async=false`, {
    method: "POST",
    credential,
    json: {
      type: "pullrequest",
      merge_strategy: bitbucketMergeStrategy(input.method),
      ...(input.providerOptions?.message ? { message: input.providerOptions.message } : {}),
      ...(input.providerOptions?.closeSourceBranch !== undefined
        ? { close_source_branch: input.providerOptions.closeSourceBranch }
        : {}),
    },
    headers: { "x-viby-idempotency-key": input.idempotencyKey },
    signal: context.signal,
    expected: [200, 202],
  });
  return pullRequestData(await bitbucketRequest<BitbucketPullRequestResponse>(runtime, path, {
    credential,
    signal: context.signal,
  }));
}

async function resolveSourceReference(
  runtime: BitbucketRuntime,
  repository: RepositoryReference,
  ref: RepositorySourceReference,
  credential: BitbucketCredentialData,
  signal?: AbortSignal,
): Promise<{ readonly commit: string }> {
  if ("commit" in ref) {
    const response = await bitbucketRequest<BitbucketCommitResponse>(
      runtime,
      `${repositoryPath(repository)}/commit/${segment(ref.commit)}`,
      { credential, signal },
    );
    return { commit: commitHash(response) };
  }
  const kind = "branch" in ref ? "branches" : "tags";
  const name = "branch" in ref ? ref.branch : ref.tag;
  const response = await bitbucketRequest<BitbucketBranchResponse>(
    runtime,
    `${repositoryPath(repository)}/refs/${kind}/${segment(name)}`,
    { credential, signal },
  );
  return { commit: commitHash(requiredResult(response.target, "Bitbucket reference target")) };
}

async function readSourceFiles(
  runtime: BitbucketRuntime,
  repository: RepositoryReference,
  commit: string,
  credential: BitbucketCredentialData,
  signal?: AbortSignal,
): Promise<readonly RemoteSourceFile[]> {
  const prefix = `${repositoryPath(repository)}/src/${segment(commit)}`;
  const queue = [`${prefix}/?pagelen=${PAGE_LENGTH}`];
  const entries: BitbucketTreeEntry[] = [];
  let declaredBytes = 0;
  while (queue.length > 0) {
    let path: string | null = queue.shift()!;
    while (path) {
      const page: BitbucketPage<BitbucketTreeEntry> = await bitbucketRequest(runtime, path, {
        credential,
        signal,
      });
      for (const entry of page.values ?? []) {
        const attributes = new Set((entry.attributes ?? []).map(String));
        if (attributes.has("link")) {
          throw new BitbucketRepositoryError("Bitbucket source imports do not allow symbolic links.", {
            status: 422,
          });
        }
        if (attributes.has("subrepository")) {
          throw new BitbucketRepositoryError("Bitbucket source imports do not allow subrepositories.", {
            status: 422,
          });
        }
        const type = String(entry.type ?? "");
        if (type === "commit_directory") {
          const directory = normalizeProjectPath(requiredProviderText(entry.path, "Bitbucket directory path"));
          queue.push(`${prefix}/${sourcePath(directory)}/?pagelen=${PAGE_LENGTH}`);
          continue;
        }
        if (type !== "commit_file") continue;
        entries.push(entry);
        if (entries.length > runtime.maxFiles) {
          throw new BitbucketRepositoryError(`Bitbucket source exceeds the ${runtime.maxFiles} file limit.`, {
            status: 422,
          });
        }
        declaredBytes += nonNegativeInteger(entry.size, "Bitbucket source file size");
        if (declaredBytes > runtime.maxBytes) {
          throw new BitbucketRepositoryError(`Bitbucket source exceeds the ${runtime.maxBytes} byte limit.`, {
            status: 422,
          });
        }
      }
      path = optionalText(page.next)
        ? validateApiCursor(runtime, String(page.next), prefix)
        : null;
    }
  }
  let downloadedBytes = 0;
  return mapConcurrent(entries, runtime.concurrency, async (entry) => {
    const path = normalizeProjectPath(requiredProviderText(entry.path, "Bitbucket source path"));
    const response = await bitbucketRawRequest(runtime, `${prefix}/${sourcePath(path)}`, {
      credential,
      headers: { accept: "application/octet-stream" },
      signal,
    });
    const content = new Uint8Array(await response.arrayBuffer());
    downloadedBytes += content.byteLength;
    if (downloadedBytes > runtime.maxBytes) {
      throw new BitbucketRepositoryError(`Bitbucket source exceeds the ${runtime.maxBytes} byte limit.`, {
        status: 422,
      });
    }
    const attributes = new Set((entry.attributes ?? []).map(String));
    return {
      path,
      content,
      ...(attributes.has("executable") ? { executable: true } : {}),
    };
  });
}

async function getBranchResponse(
  runtime: BitbucketRuntime,
  repository: RepositoryReference,
  name: string,
  credential: BitbucketCredentialData,
  signal?: AbortSignal,
): Promise<BitbucketBranchResponse | null> {
  return bitbucketRequestOrNull(runtime, `${repositoryPath(repository)}/refs/branches/${segment(name)}`, {
    credential,
    signal,
  });
}

async function createBranchResponse(
  runtime: BitbucketRuntime,
  repository: RepositoryReference,
  name: string,
  from: string,
  credential: BitbucketCredentialData,
  signal?: AbortSignal,
): Promise<BitbucketBranchResponse> {
  return bitbucketRequest(runtime, `${repositoryPath(repository)}/refs/branches`, {
    method: "POST",
    credential,
    json: { name, target: { hash: from } },
    signal,
    expected: [200, 201],
  });
}

async function allWorkspaces(
  runtime: BitbucketRuntime,
  credential: BitbucketCredentialData,
  signal?: AbortSignal,
): Promise<readonly BitbucketWorkspaceResponse[]> {
  const workspaces: BitbucketWorkspaceResponse[] = [];
  let path: string | null = `/user/workspaces?pagelen=${PAGE_LENGTH}`;
  while (path) {
    const page: BitbucketPage<BitbucketWorkspaceAccessResponse> = await bitbucketRequest(runtime, path, {
      credential,
      signal,
    });
    for (const access of page.values ?? []) {
      workspaces.push(requiredResult(access.workspace, "Bitbucket workspace"));
    }
    path = optionalText(page.next)
      ? validateApiCursor(runtime, String(page.next), "/user/workspaces")
      : null;
  }
  return workspaces;
}

async function tokenRequest(
  runtime: BitbucketRuntime,
  form: URLSearchParams,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return bitbucketRequest(runtime, runtime.tokenUrl, {
    method: "POST",
    basic: `${runtime.clientId}:${runtime.clientSecret}`,
    form,
    signal,
    expected: [200],
  });
}

async function bitbucketRequest<Value = unknown>(
  runtime: BitbucketRuntime,
  path: string,
  options: BitbucketRequestOptions = {},
): Promise<Value> {
  const response = await bitbucketRawRequest(runtime, path, options);
  if (response.status === 204) return undefined as Value;
  const text = await response.text();
  if (!text) return undefined as Value;
  try {
    return JSON.parse(text) as Value;
  } catch (cause) {
    throw new BitbucketRepositoryError("Bitbucket returned an invalid JSON response.", {
      status: response.status,
      cause,
    });
  }
}

async function bitbucketRequestOrNull<Value>(
  runtime: BitbucketRuntime,
  path: string,
  options: BitbucketRequestOptions = {},
): Promise<Value | null> {
  try {
    return await bitbucketRequest<Value>(runtime, path, options);
  } catch (error) {
    if (error instanceof BitbucketRepositoryError && error.status === 404) return null;
    throw error;
  }
}

async function bitbucketRawRequest(
  runtime: BitbucketRuntime,
  path: string,
  options: BitbucketRequestOptions = {},
): Promise<Response> {
  options.signal?.throwIfAborted();
  const url = requestUrl(runtime, path);
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (options.credential) headers.set("authorization", `Bearer ${options.credential.accessToken}`);
  if (options.basic) headers.set("authorization", `Basic ${Buffer.from(options.basic).toString("base64")}`);
  let body: BodyInit | Uint8Array | undefined = options.body;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = options.form.toString();
  }
  let response: Response;
  try {
    const requestBody = body instanceof Uint8Array ? new Uint8Array(body).buffer : body;
    response = await runtime.fetch(url, {
      method: options.method ?? "GET",
      headers,
      ...(requestBody !== undefined ? { body: requestBody } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
  } catch (cause) {
    throw new BitbucketRepositoryError("Bitbucket request failed before receiving a response.", {
      cause,
    });
  }
  const expected = options.expected ?? [200];
  if (expected.includes(response.status)) return response;
  const text = await response.text();
  let payload: Record<string, unknown> | null = null;
  try {
    payload = text ? record(JSON.parse(text)) : null;
  } catch {
    payload = null;
  }
  const error = record(payload?.error);
  const message = optionalText(error?.message) ?? optionalText(payload?.message)
    ?? `Bitbucket request failed with HTTP ${response.status}.`;
  const code = optionalText(error?.key) ?? optionalText(payload?.type);
  throw new BitbucketRepositoryError(message, {
    status: response.status,
    ...(code ? { code } : {}),
  });
}

function normalizeOptions(options: BitbucketRepositoryOptions): BitbucketRuntime {
  const clientId = requiredOption(options.clientId, "Bitbucket OAuth clientId");
  const clientSecret = requiredOption(options.clientSecret, "Bitbucket OAuth clientSecret");
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? DEFAULT_API_URL, "Bitbucket API URL");
  const api = new URL(apiUrl);
  const authorizationUrl = absoluteUrl(
    options.authorizationUrl ?? DEFAULT_AUTHORIZATION_URL,
    "Bitbucket authorization URL",
  );
  const tokenUrl = absoluteUrl(options.tokenUrl ?? DEFAULT_TOKEN_URL, "Bitbucket token URL");
  const maxFiles = boundedInteger(options.source?.maxFiles, DEFAULT_SOURCE_FILES, 1, 100_000, "Bitbucket source file limit");
  const maxBytes = boundedInteger(options.source?.maxBytes, DEFAULT_SOURCE_BYTES, 1, 1_000_000_000, "Bitbucket source byte limit");
  const concurrency = boundedInteger(options.source?.concurrency, DEFAULT_CONCURRENCY, 1, 64, "Bitbucket source concurrency");
  return {
    clientId,
    clientSecret,
    apiUrl,
    apiOrigin: api.origin,
    apiPath: api.pathname.replace(/\/$/, ""),
    authorizationUrl,
    tokenUrl,
    scopes: Object.freeze([...(options.scopes ?? DEFAULT_SCOPES)]),
    fetch: options.fetch ?? globalThis.fetch,
    maxFiles,
    maxBytes,
    concurrency,
  };
}

function tokenCredential(
  token: Record<string, unknown>,
  fallbackRefreshToken: string | null,
): { readonly data: BitbucketCredentialData; readonly expiresAt: Date | null } {
  const accessToken = requiredProviderText(token.access_token, "Bitbucket access token");
  const refreshToken = optionalText(token.refresh_token) ?? fallbackRefreshToken;
  const seconds = optionalNumber(token.expires_in);
  const expiresAt = seconds === null
    ? null
    : new Date(Date.now() + Math.max(0, seconds * 1_000 - TOKEN_EXPIRY_LEEWAY_MS));
  return {
    data: { version: 1, accessToken, refreshToken },
    expiresAt,
  };
}

function tokenScopes(token: Record<string, unknown>, fallback: readonly string[]): readonly string[] {
  const scope = optionalText(token.scopes) ?? optionalText(token.scope);
  return scope ? scope.split(/[ ,]+/).filter(Boolean) : [...fallback];
}

function encodeCredential(value: BitbucketCredentialData): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeCredential(value: Uint8Array): BitbucketCredentialData {
  try {
    const parsed = JSON.parse(textDecoder.decode(value)) as Partial<BitbucketCredentialData>;
    if (parsed.version !== 1) throw new Error("invalid credential");
    const accessToken = optionalText(parsed.accessToken);
    if (!accessToken) throw new Error("invalid credential");
    return {
      version: 1,
      accessToken,
      refreshToken: optionalText(parsed.refreshToken),
    };
  } catch (cause) {
    throw new BitbucketRepositoryError("The stored Bitbucket credential is invalid.", {
      status: 401,
      code: "invalid_credential",
      cause,
    });
  }
}

function ownerData(workspace: BitbucketWorkspaceResponse): RepositoryOwnerData {
  const id = requiredProviderText(workspace.uuid, "Bitbucket workspace id");
  const slug = requiredProviderText(workspace.slug, "Bitbucket workspace slug");
  return {
    id,
    name: slug,
    kind: "workspace",
    avatarUrl: optionalText(workspace.links?.avatar?.href),
  };
}

function repositoryData(repository: BitbucketRepositoryResponse): RepositoryData {
  const fullName = requiredProviderText(repository.full_name, "Bitbucket repository full name");
  const slash = fullName.indexOf("/");
  const workspace = optionalText(repository.workspace?.slug)
    ?? (slash === -1 ? null : fullName.slice(0, slash));
  return {
    id: requiredProviderText(repository.uuid, "Bitbucket repository id"),
    owner: requiredProviderText(workspace, "Bitbucket repository workspace"),
    name: requiredProviderText(repository.slug ?? repository.name, "Bitbucket repository slug"),
    defaultBranch: optionalText(repository.mainbranch?.name) ?? "main",
    visibility: repository.is_private === false ? "public" : "private",
    url: requiredProviderText(repository.links?.html?.href, "Bitbucket repository URL"),
  };
}

function branchData(branch: BitbucketBranchResponse): RepositoryBranchData {
  return {
    name: requiredProviderText(branch.name, "Bitbucket branch name"),
    head: commitHash(requiredResult(branch.target, "Bitbucket branch target")),
    protected: false,
  };
}

function commitData(commit: BitbucketCommitResponse, branch: string, fallbackMessage: string): RepositoryCommitData {
  return {
    id: commitHash(commit),
    message: optionalText(commit.message) ?? fallbackMessage,
    branch,
    url: optionalText(commit.links?.html?.href),
  };
}

function pullRequestData(pullRequest: BitbucketPullRequestResponse): RepositoryPullRequestData {
  const state = String(pullRequest.state ?? "").toUpperCase();
  return {
    id: String(requiredPositiveInteger(pullRequest.id, "Bitbucket pull request id")),
    number: requiredPositiveInteger(pullRequest.id, "Bitbucket pull request number"),
    title: requiredProviderText(pullRequest.title, "Bitbucket pull request title"),
    head: requiredProviderText(pullRequest.source?.branch?.name, "Bitbucket pull request source branch"),
    base: requiredProviderText(pullRequest.destination?.branch?.name, "Bitbucket pull request destination branch"),
    status: state === "MERGED"
      ? "merged"
      : state === "OPEN" && pullRequest.draft ? "draft"
        : state === "OPEN" ? "open" : "closed",
    url: requiredProviderText(pullRequest.links?.html?.href, "Bitbucket pull request URL"),
  };
}

function commitHash(commit: BitbucketCommitResponse): string {
  return requiredProviderText(commit.hash, "Bitbucket commit hash");
}

function sourceChanges(previous: readonly RemoteSourceFile[], next: readonly RemoteSourceFile[]) {
  const previousByPath = new Map(previous.map((file) => [file.path, file]));
  const nextPaths = new Set(next.map((file) => file.path));
  const upserted = next.filter((file) => {
    const before = previousByPath.get(file.path);
    return !before
      || before.executable !== file.executable
      || !bytesEqual(before.content, file.content);
  });
  const deleted = previous.filter((file) => !nextPaths.has(file.path)).map((file) => file.path);
  return { upserted, deleted, changedFiles: upserted.length + deleted.length };
}

function createSourceMultipart(input: {
  readonly branch: string;
  readonly message: string;
  readonly parent: string | null;
  readonly author?: string;
  readonly files: readonly RemoteSourceFile[];
  readonly deleted: readonly string[];
}): { readonly boundary: string; readonly body: Uint8Array } {
  const boundary = `viby-${randomBytes(18).toString("hex")}`;
  const chunks: Uint8Array[] = [];
  const line = (value: string) => chunks.push(textEncoder.encode(value));
  const field = (name: string, value: string) => {
    line(`--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"\r\n\r\n${value}\r\n`);
  };
  field("branch", input.branch);
  field("message", input.message);
  if (input.parent) field("parents", input.parent);
  if (input.author) field("author", input.author);
  for (const path of input.deleted) field("files", path);
  for (const file of input.files) {
    const name = `/${file.path}`;
    const filename = file.path.split("/").at(-1) ?? "file";
    line(
      `--${boundary}\r\nContent-Disposition: form-data; name="${quoted(name)}"; filename="${quoted(filename)}"${file.executable ? '; x-attributes="executable"' : ""}\r\nContent-Type: application/octet-stream\r\n\r\n`,
    );
    chunks.push(file.content);
    line("\r\n");
  }
  line(`--${boundary}--\r\n`);
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0);
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { boundary, body };
}

function validateSourceFiles(
  runtime: BitbucketRuntime,
  files: readonly IntegrationSourceFile[],
): readonly RemoteSourceFile[] {
  if (files.length > runtime.maxFiles) {
    throw new BitbucketRepositoryError(`Bitbucket source exceeds the ${runtime.maxFiles} file limit.`, {
      status: 422,
    });
  }
  let bytes = 0;
  const seen = new Set<string>();
  return files.map((file) => {
    const path = normalizeProjectPath(file.path);
    if (seen.has(path)) throw new ConfigurationError(`Duplicate source path: ${path}`);
    seen.add(path);
    bytes += file.content.byteLength;
    if (bytes > runtime.maxBytes) {
      throw new BitbucketRepositoryError(`Bitbucket source exceeds the ${runtime.maxBytes} byte limit.`, {
        status: 422,
      });
    }
    return {
      path,
      content: new Uint8Array(file.content),
      ...(file.mediaType !== undefined ? { mediaType: file.mediaType } : {}),
      ...(file.executable !== undefined ? { executable: file.executable } : {}),
    };
  });
}

function repositoryPath(reference: RepositoryReference): string {
  return `/repositories/${segment(reference.owner)}/${segment(reference.name)}`;
}

function sourcePath(path: string): string {
  return path.split("/").map(segment).join("/");
}

function segment(value: string): string {
  const normalized = requiredOption(value, "Bitbucket path segment");
  return encodeURIComponent(normalized);
}

function repositoryName(value: string): string {
  const name = requiredOption(value, "Bitbucket repository name");
  if (name.includes("/")) throw new ConfigurationError("Bitbucket repository names cannot contain slashes.");
  return name;
}

function requestUrl(runtime: BitbucketRuntime, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${runtime.apiUrl}${path.startsWith("/") ? path : `/${path}`}`;
}

function validateApiCursor(runtime: BitbucketRuntime, value: string, prefix: string): string {
  if (value.startsWith("/") && !value.startsWith("//")) {
    if (!value.startsWith(prefix)) {
      throw new ConfigurationError("Bitbucket pagination cursor does not belong to this API resource.");
    }
    return value;
  }
  let url: URL;
  try {
    url = new URL(value, `${runtime.apiUrl}/`);
  } catch {
    throw new ConfigurationError("Invalid Bitbucket pagination cursor.");
  }
  const requiredPath = `${runtime.apiPath}${prefix}`;
  if (url.origin !== runtime.apiOrigin || !url.pathname.startsWith(requiredPath)) {
    throw new ConfigurationError("Bitbucket pagination cursor does not belong to this API resource.");
  }
  return url.href;
}

function encodePageCursor(value: string): string {
  return Buffer.from(JSON.stringify({ version: 1, url: value })).toString("base64url");
}

function decodePageCursor(runtime: BitbucketRuntime, value: string, prefix: string): string {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1 || !optionalText(parsed.url)) throw new Error("invalid cursor");
    return validateApiCursor(runtime, String(parsed.url), prefix);
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("Invalid Bitbucket pagination cursor.", { cause });
  }
}

function encodeRepositoryCursor(value: RepositoryCursor): string {
  return Buffer.from(JSON.stringify({ version: 1, ...value })).toString("base64url");
}

function decodeRepositoryCursor(value?: string): RepositoryCursor {
  if (!value) return { workspace: 0, pageUrl: null, offset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Record<string, unknown>;
    if (parsed.version !== 1) throw new Error("invalid cursor version");
    const workspace = requiredNonNegativeInteger(parsed.workspace, "Bitbucket cursor workspace");
    const offset = requiredNonNegativeInteger(parsed.offset, "Bitbucket cursor offset");
    const pageUrl = parsed.pageUrl === null ? null : requiredProviderText(parsed.pageUrl, "Bitbucket cursor URL");
    return { workspace, pageUrl, offset };
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("Invalid Bitbucket repository cursor.", { cause });
  }
}

function bitbucketMergeStrategy(method?: "merge" | "squash" | "rebase"): string {
  if (method === "squash") return "squash";
  if (method === "rebase") return "fast_forward";
  return "merge_commit";
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}

function quoted(value: string): string {
  return value.replaceAll(/["\r\n]/g, "_");
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name);
  if (!value) throw new BitbucketRepositoryError(`Bitbucket callback is missing ${name}.`, { status: 400 });
  return value;
}

function requiredOption(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) throw new ConfigurationError(`${label} is required.`);
  return normalized;
}

function absoluteUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.hostname !== "localhost") throw new Error("HTTPS required");
    return url.href;
  } catch (cause) {
    throw new ConfigurationError(`${label} must be an absolute HTTPS URL.`, { cause });
  }
}

function normalizeBaseUrl(value: string, label: string): string {
  return absoluteUrl(value, label).replace(/\/$/, "");
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function optionalNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function requiredProviderText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new BitbucketRepositoryError(`${label} is missing from the provider response.`);
  return text;
}

function requiredResult<Value>(value: Value | null | undefined, label: string): Value {
  if (value === null || value === undefined) {
    throw new BitbucketRepositoryError(`${label} is missing from the provider response.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new BitbucketRepositoryError(`${label} is invalid in the provider response.`);
  }
  return number;
}

function requiredNonNegativeInteger(value: unknown, label: string): number {
  const number = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new ConfigurationError(`${label} is invalid.`);
  return number;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const number = value === undefined ? 0 : typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(number) || number < 0) {
    throw new BitbucketRepositoryError(`${label} is invalid in the provider response.`);
  }
  return number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return number;
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  mapper: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  async function worker(): Promise<void> {
    while (next < values.length) {
      const index = next;
      next += 1;
      results[index] = await mapper(values[index]!, index);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, () => worker()));
  return results;
}
