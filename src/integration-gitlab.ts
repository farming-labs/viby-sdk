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

const DEFAULT_BASE_URL = "https://gitlab.com";
const DEFAULT_SCOPES = Object.freeze(["api"]);
const DEFAULT_SOURCE_FILES = 5_000;
const DEFAULT_SOURCE_BYTES = 25_000_000;
const DEFAULT_CONCURRENCY = 8;
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder(undefined, { fatal: true });

export interface GitLabPushOptions {
  readonly authorName?: string;
  readonly authorEmail?: string;
}

export interface GitLabPullRequestOptions {
  readonly removeSourceBranch?: boolean;
  readonly squash?: boolean;
  readonly assigneeIds?: readonly number[];
  readonly reviewerIds?: readonly number[];
}

export interface GitLabMergeOptions {
  readonly mergeCommitMessage?: string;
  readonly squashCommitMessage?: string;
  readonly removeSourceBranch?: boolean;
}

export interface GitLabRepositoryOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  /** GitLab.com or the root URL of a self-managed GitLab instance. */
  readonly baseUrl?: string;
  readonly apiUrl?: string;
  readonly authorizationUrl?: string;
  readonly tokenUrl?: string;
  readonly revokeUrl?: string;
  readonly scopes?: readonly string[];
  readonly fetch?: typeof globalThis.fetch;
  readonly source?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
    readonly concurrency?: number;
  };
}

interface GitLabCredentialData {
  readonly version: 1;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly redirectUri: string;
}

interface GitLabAuthorizationSession {
  readonly version: 1;
  readonly redirectUri: string;
}

interface GitLabRuntime {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly baseUrl: string;
  readonly baseOrigin: string;
  readonly apiUrl: string;
  readonly apiPath: string;
  readonly authorizationUrl: string;
  readonly tokenUrl: string;
  readonly revokeUrl: string;
  readonly scopes: readonly string[];
  readonly fetch: typeof globalThis.fetch;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly concurrency: number;
}

interface GitLabRequestOptions {
  readonly method?: string;
  readonly credential?: GitLabCredentialData;
  readonly headers?: Readonly<Record<string, string>>;
  readonly json?: unknown;
  readonly form?: URLSearchParams;
  readonly signal?: AbortSignal | undefined;
  readonly expected?: readonly number[];
}

interface GitLabUserResponse {
  readonly id?: unknown;
  readonly username?: unknown;
  readonly name?: unknown;
  readonly web_url?: unknown;
  readonly avatar_url?: unknown;
}

interface GitLabNamespaceResponse {
  readonly id?: unknown;
  readonly name?: unknown;
  readonly path?: unknown;
  readonly full_path?: unknown;
  readonly kind?: unknown;
  readonly avatar_url?: unknown;
}

interface GitLabProjectResponse {
  readonly id?: unknown;
  readonly path?: unknown;
  readonly name?: unknown;
  readonly path_with_namespace?: unknown;
  readonly default_branch?: unknown;
  readonly visibility?: unknown;
  readonly web_url?: unknown;
  readonly namespace?: GitLabNamespaceResponse;
}

interface GitLabCommitResponse {
  readonly id?: unknown;
  readonly message?: unknown;
  readonly web_url?: unknown;
}

interface GitLabBranchResponse {
  readonly name?: unknown;
  readonly protected?: unknown;
  readonly commit?: GitLabCommitResponse;
}

interface GitLabTagResponse {
  readonly name?: unknown;
  readonly commit?: GitLabCommitResponse;
}

interface GitLabTreeEntry {
  readonly id?: unknown;
  readonly path?: unknown;
  readonly type?: unknown;
  readonly mode?: unknown;
}

interface GitLabMergeRequestResponse {
  readonly id?: unknown;
  readonly iid?: unknown;
  readonly title?: unknown;
  readonly source_branch?: unknown;
  readonly target_branch?: unknown;
  readonly state?: unknown;
  readonly draft?: unknown;
  readonly sha?: unknown;
  readonly web_url?: unknown;
  readonly merged_at?: unknown;
}

interface RemoteSourceFile extends IntegrationSourceFile {
  readonly executable?: boolean;
}

export class GitLabRepositoryError extends Error {
  readonly status: number | null;
  readonly code: string | null;

  constructor(
    message: string,
    options: { readonly status?: number; readonly code?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitLabRepositoryError";
    this.status = options.status ?? null;
    this.code = options.code ?? null;
  }
}

/** Creates a GitLab OAuth provider for `integrations.repository`. */
export function gitlab(
  options: GitLabRepositoryOptions,
): RepositoryIntegration<GitLabPushOptions, GitLabPullRequestOptions, GitLabMergeOptions> {
  const runtime = normalizeOptions(options);
  return {
    provider: "gitlab",
    displayName: "GitLab",
    connection: {
      async startAuthorization(input) {
        input.signal?.throwIfAborted();
        const redirectUri = absoluteUrl(input.callbackUrl, "GitLab callback URL");
        const url = new URL(runtime.authorizationUrl);
        url.searchParams.set("client_id", runtime.clientId);
        url.searchParams.set("redirect_uri", redirectUri);
        url.searchParams.set("response_type", "code");
        url.searchParams.set("state", input.state);
        const scopes = input.scopes ?? runtime.scopes;
        if (scopes.length > 0) url.searchParams.set("scope", scopes.join(" "));
        return {
          url: url.href,
          expiresAt: null,
          session: encodeSession({ version: 1, redirectUri }),
        };
      },
      async completeAuthorization(input, context) {
        return completeAuthorization(runtime, input.callbackUrl, input.session, context);
      },
      async refreshCredential(credential, context) {
        return refreshCredential(runtime, credential, context);
      },
      async revokeCredential(credential, context) {
        return revokeCredential(runtime, credential, context);
      },
    },
    listOwners: (input, context) => listOwners(runtime, input, context),
    listRepositories: (input, context) => listRepositories(runtime, input, context),
    getRepository: (input, context) => getRepository(runtime, input, context),
    createRepository: (input, context) => createRepository(runtime, input, context),
    listBranches: (input, context) => listBranches(runtime, input, context),
    getBranch: (input, context) => getBranch(runtime, input, context),
    createBranch: (input, context) => createBranch(runtime, input, context),
    readSource: (input, context) => readSource(runtime, input, context),
    pushVersion: (input, context) => pushVersion(runtime, input, context),
    createPullRequest: (input, context) => createPullRequest(runtime, input, context),
    mergePullRequest: (input, context) => mergePullRequest(runtime, input, context),
  };
}

export const gitlabRepository = gitlab;

async function completeAuthorization(
  runtime: GitLabRuntime,
  callbackUrl: string,
  encodedSession: Uint8Array | undefined,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationAuthorizationResult> {
  const callback = new URL(callbackUrl);
  const providerError = callback.searchParams.get("error");
  if (providerError) {
    throw new GitLabRepositoryError(
      callback.searchParams.get("error_description") || `GitLab authorization failed: ${providerError}`,
      { status: 401, code: providerError },
    );
  }
  if (!encodedSession) {
    throw new GitLabRepositoryError("The GitLab authorization session is missing.", {
      status: 401,
      code: "missing_session",
    });
  }
  const session = decodeSession(encodedSession);
  const token = await tokenRequest(runtime, new URLSearchParams({
    client_id: runtime.clientId,
    client_secret: runtime.clientSecret,
    code: requiredQuery(callback, "code"),
    grant_type: "authorization_code",
    redirect_uri: session.redirectUri,
  }), context.signal);
  const credential = tokenCredential(token, null, session.redirectUri);
  const user = await gitlabRequest<GitLabUserResponse>(runtime, "/user", {
    credential: credential.data,
    signal: context.signal,
  });
  const id = String(requiredPositiveInteger(user.id, "GitLab user id"));
  const username = requiredProviderText(user.username, "GitLab username");
  return {
    account: {
      id,
      name: optionalText(user.name) ?? username,
      ...(optionalText(user.web_url) ? { url: String(user.web_url) } : {}),
      metadata: {
        username,
        ...(optionalText(user.avatar_url) ? { avatarUrl: String(user.avatar_url) } : {}),
        instance: runtime.baseUrl,
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
  runtime: GitLabRuntime,
  credential: IntegrationCredential,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationCredential> {
  const current = decodeCredential(credential.secret);
  if (!current.refreshToken) {
    throw new GitLabRepositoryError("The GitLab connection must be authorized again.", {
      status: 401,
      code: "missing_refresh_token",
    });
  }
  const token = await tokenRequest(runtime, new URLSearchParams({
    client_id: runtime.clientId,
    client_secret: runtime.clientSecret,
    refresh_token: current.refreshToken,
    grant_type: "refresh_token",
    redirect_uri: current.redirectUri,
  }), context.signal);
  const refreshed = tokenCredential(token, current.refreshToken, current.redirectUri);
  return {
    secret: encodeCredential(refreshed.data),
    expiresAt: refreshed.expiresAt,
    scopes: tokenScopes(token, credential.scopes),
  };
}

async function revokeCredential(
  runtime: GitLabRuntime,
  credential: IntegrationCredential,
  context: IntegrationAuthorizationContext,
): Promise<void> {
  const current = decodeCredential(credential.secret);
  await gitlabRequest(runtime, runtime.revokeUrl, {
    method: "POST",
    form: new URLSearchParams({
      client_id: runtime.clientId,
      client_secret: runtime.clientSecret,
      token: current.accessToken,
    }),
    signal: context.signal,
    expected: [200],
  });
}

async function listOwners(
  runtime: GitLabRuntime,
  input: ListRepositoryOwnersInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryOwnerData>> {
  const credential = decodeCredential(context.credential);
  const limit = boundedInteger(input.limit, 20, 1, 100, "GitLab namespace page limit");
  const path = input.cursor
    ? decodeCursor(runtime, input.cursor, "/namespaces")
    : `/namespaces?owned_only=true&per_page=${limit}&page=1`;
  const page = await gitlabPage<GitLabNamespaceResponse>(runtime, path, {
    credential,
    signal: context.signal,
  });
  return {
    items: page.items.map(ownerData),
    nextCursor: page.next ? encodeCursor(page.next) : null,
  };
}

async function listRepositories(
  runtime: GitLabRuntime,
  input: ListRepositoriesInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryData>> {
  const credential = decodeCredential(context.credential);
  const limit = boundedInteger(input.limit, 20, 1, 100, "GitLab repository page limit");
  const path = input.cursor
    ? decodeCursor(runtime, input.cursor, "/projects")
    : (() => {
        const query = new URLSearchParams({
          membership: "true",
          simple: "true",
          order_by: "id",
          sort: "asc",
          per_page: String(limit),
          page: "1",
        });
        if (input.search?.trim()) query.set("search", input.search.trim());
        return `/projects?${query}`;
      })();
  const page = await gitlabPage<GitLabProjectResponse>(runtime, path, {
    credential,
    signal: context.signal,
  });
  const repositories = page.items.map(repositoryData);
  return {
    items: input.owner
      ? repositories.filter((repository) => repository.owner === input.owner)
      : repositories,
    nextCursor: page.next ? encodeCursor(page.next) : null,
  };
}

async function getRepository(
  runtime: GitLabRuntime,
  input: RepositoryReference,
  context: IntegrationOperationContext,
): Promise<RepositoryData | null> {
  const response = await gitlabRequestOrNull<GitLabProjectResponse>(
    runtime,
    repositoryPath(input),
    { credential: decodeCredential(context.credential), signal: context.signal },
  );
  return response ? repositoryData(response) : null;
}

async function createRepository(
  runtime: GitLabRuntime,
  input: CreateRepositoryInput,
  context: IntegrationOperationContext,
): Promise<RepositoryData> {
  const credential = decodeCredential(context.credential);
  const namespace = await gitlabRequest<GitLabNamespaceResponse>(
    runtime,
    `/namespaces/${segment(input.owner)}`,
    { credential, signal: context.signal },
  );
  const response = await gitlabRequest<GitLabProjectResponse>(runtime, "/projects", {
    method: "POST",
    credential,
    json: {
      name: repositoryName(input.name),
      path: repositoryName(input.name),
      namespace_id: requiredPositiveInteger(namespace.id, "GitLab namespace id"),
      visibility: input.visibility ?? "private",
      ...(input.description !== undefined ? { description: input.description } : {}),
    },
    signal: context.signal,
    expected: [201],
  });
  return repositoryData(response);
}

async function listBranches(
  runtime: GitLabRuntime,
  input: ListRepositoryBranchesInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryBranchData>> {
  const credential = decodeCredential(context.credential);
  const limit = boundedInteger(input.limit, 20, 1, 100, "GitLab branch page limit");
  const prefix = `${repositoryPath(input.repository)}/repository/branches`;
  const path = input.cursor
    ? decodeCursor(runtime, input.cursor, prefix)
    : `${prefix}?per_page=${limit}&page=1`;
  const page = await gitlabPage<GitLabBranchResponse>(runtime, path, {
    credential,
    signal: context.signal,
  });
  return {
    items: page.items.map(branchData),
    nextCursor: page.next ? encodeCursor(page.next) : null,
  };
}

async function getBranch(
  runtime: GitLabRuntime,
  input: GetRepositoryBranchInput,
  context: IntegrationOperationContext,
): Promise<RepositoryBranchData | null> {
  const response = await getBranchResponse(
    runtime,
    input.repository,
    input.name,
    decodeCredential(context.credential),
    context.signal,
  );
  return response ? branchData(response) : null;
}

async function createBranch(
  runtime: GitLabRuntime,
  input: CreateRepositoryBranchInput,
  context: IntegrationOperationContext,
): Promise<RepositoryBranchData> {
  const response = await gitlabRequest<GitLabBranchResponse>(
    runtime,
    `${repositoryPath(input.repository)}/repository/branches`,
    {
      method: "POST",
      credential: decodeCredential(context.credential),
      json: { branch: input.name, ref: input.from },
      signal: context.signal,
      expected: [201],
    },
  );
  return branchData(response);
}

async function readSource(
  runtime: GitLabRuntime,
  input: ReadRepositorySourceInput,
  context: IntegrationOperationContext,
): Promise<RepositorySourceData> {
  const credential = decodeCredential(context.credential);
  const repository = await gitlabRequest<GitLabProjectResponse>(
    runtime,
    repositoryPath(input.repository),
    { credential, signal: context.signal },
  );
  const commit = await resolveSourceReference(
    runtime,
    input.repository,
    input.ref,
    credential,
    context.signal,
  );
  return {
    repository: repositoryData(repository),
    ref: input.ref,
    commit,
    files: await readSourceFiles(
      runtime,
      input.repository,
      commit,
      credential,
      context.signal,
    ),
  };
}

async function pushVersion(
  runtime: GitLabRuntime,
  input: PushRepositoryVersionInput<GitLabPushOptions>,
  context: IntegrationOperationContext,
): Promise<PushRepositoryVersionResult> {
  const files = validateSourceFiles(runtime, input.files);
  const credential = decodeCredential(context.credential);
  let target = await getBranchResponse(
    runtime,
    input.repository,
    input.branch,
    credential,
    context.signal,
  );
  if (!target && input.baseBranch) {
    if (!input.createBranch) {
      throw new GitLabRepositoryError(`GitLab branch ${input.branch} does not exist.`, { status: 404 });
    }
    target = await gitlabRequest<GitLabBranchResponse>(
      runtime,
      `${repositoryPath(input.repository)}/repository/branches`,
      {
        method: "POST",
        credential,
        json: { branch: input.branch, ref: input.baseBranch },
        signal: context.signal,
        expected: [201],
      },
    );
  }
  if (!target && !input.createBranch) {
    throw new GitLabRepositoryError(`GitLab branch ${input.branch} does not exist.`, { status: 404 });
  }
  const parent = target?.commit ? commitHash(target.commit) : null;
  if (input.expectedHead !== undefined && input.expectedHead !== parent) {
    if (!parent) {
      throw new GitLabRepositoryError(
        "GitLab cannot compare an expected head with a repository that has no commits.",
        { status: 409, code: "head_missing" },
      );
    }
    return { status: "conflict", expectedHead: input.expectedHead, actualHead: parent };
  }
  const previous = parent
    ? await readSourceFiles(runtime, input.repository, parent, credential, context.signal)
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
    throw new GitLabRepositoryError(
      "GitLab cannot initialize an empty repository without at least one file.",
      { status: 422 },
    );
  }
  const actions = gitlabCommitActions(previous, changes.upserted, changes.deleted);
  let commit: GitLabCommitResponse;
  try {
    commit = await gitlabRequest<GitLabCommitResponse>(
      runtime,
      `${repositoryPath(input.repository)}/repository/commits`,
      {
        method: "POST",
        credential,
        json: {
          branch: input.branch,
          commit_message: input.message,
          actions,
          ...(input.providerOptions?.authorName
            ? { author_name: input.providerOptions.authorName }
            : {}),
          ...(input.providerOptions?.authorEmail
            ? { author_email: input.providerOptions.authorEmail }
            : {}),
        },
        signal: context.signal,
        expected: [201],
      },
    );
  } catch (error) {
    if (!(error instanceof GitLabRepositoryError) || ![400, 409, 422].includes(error.status ?? 0)) {
      throw error;
    }
    const actual = await getBranchResponse(
      runtime,
      input.repository,
      input.branch,
      credential,
      context.signal,
    );
    const actualHead = actual?.commit ? commitHash(actual.commit) : null;
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
  runtime: GitLabRuntime,
  input: CreateRepositoryPullRequestInput<GitLabPullRequestOptions>,
  context: IntegrationOperationContext,
): Promise<RepositoryPullRequestData> {
  const provider = input.providerOptions;
  const response = await gitlabRequest<GitLabMergeRequestResponse>(
    runtime,
    `${repositoryPath(input.repository)}/merge_requests`,
    {
      method: "POST",
      credential: decodeCredential(context.credential),
      json: {
        source_branch: input.head,
        target_branch: input.base,
        title: input.draft && !/^draft:/i.test(input.title) ? `Draft: ${input.title}` : input.title,
        ...(input.body !== undefined ? { description: input.body } : {}),
        ...(provider?.removeSourceBranch !== undefined
          ? { remove_source_branch: provider.removeSourceBranch }
          : {}),
        ...(provider?.squash !== undefined ? { squash: provider.squash } : {}),
        ...(provider?.assigneeIds ? { assignee_ids: [...provider.assigneeIds] } : {}),
        ...(provider?.reviewerIds ? { reviewer_ids: [...provider.reviewerIds] } : {}),
      },
      signal: context.signal,
      expected: [201],
    },
  );
  return pullRequestData(response);
}

async function mergePullRequest(
  runtime: GitLabRuntime,
  input: MergeRepositoryPullRequestInput<GitLabMergeOptions>,
  context: IntegrationOperationContext,
): Promise<RepositoryPullRequestData> {
  if (input.method === "rebase") {
    throw new ConfigurationError(
      "GitLab rebases asynchronously; use the provider API before requesting a portable merge.",
    );
  }
  const credential = decodeCredential(context.credential);
  const path = `${repositoryPath(input.repository)}/merge_requests/${input.number}`;
  const current = await gitlabRequest<GitLabMergeRequestResponse>(runtime, path, {
    credential,
    signal: context.signal,
  });
  if (String(current.state).toLowerCase() === "merged" || current.merged_at) {
    return pullRequestData(current);
  }
  const currentHead = requiredProviderText(current.sha, "GitLab merge request head");
  if (input.expectedHead && input.expectedHead !== currentHead) {
    throw new GitLabRepositoryError("The GitLab merge request head changed before merge.", {
      status: 409,
      code: "head_changed",
    });
  }
  const provider = input.providerOptions;
  const merged = await gitlabRequest<GitLabMergeRequestResponse>(runtime, `${path}/merge`, {
    method: "PUT",
    credential,
    headers: { "idempotency-key": input.idempotencyKey },
    json: {
      sha: currentHead,
      ...(input.method === "squash" ? { squash: true } : {}),
      ...(provider?.mergeCommitMessage
        ? { merge_commit_message: provider.mergeCommitMessage }
        : {}),
      ...(provider?.squashCommitMessage
        ? { squash_commit_message: provider.squashCommitMessage }
        : {}),
      ...(provider?.removeSourceBranch !== undefined
        ? { should_remove_source_branch: provider.removeSourceBranch }
        : {}),
    },
    signal: context.signal,
    expected: [200],
  });
  return pullRequestData(merged);
}

async function resolveSourceReference(
  runtime: GitLabRuntime,
  repository: RepositoryReference,
  ref: RepositorySourceReference,
  credential: GitLabCredentialData,
  signal?: AbortSignal,
): Promise<string> {
  if ("commit" in ref) {
    const commit = await gitlabRequest<GitLabCommitResponse>(
      runtime,
      `${repositoryPath(repository)}/repository/commits/${segment(ref.commit)}`,
      { credential, signal },
    );
    return commitHash(commit);
  }
  if ("branch" in ref) {
    const branch = await gitlabRequest<GitLabBranchResponse>(
      runtime,
      `${repositoryPath(repository)}/repository/branches/${segment(ref.branch)}`,
      { credential, signal },
    );
    return commitHash(requiredResult(branch.commit, "GitLab branch commit"));
  }
  const tag = await gitlabRequest<GitLabTagResponse>(
    runtime,
    `${repositoryPath(repository)}/repository/tags/${segment(ref.tag)}`,
    { credential, signal },
  );
  return commitHash(requiredResult(tag.commit, "GitLab tag commit"));
}

async function readSourceFiles(
  runtime: GitLabRuntime,
  repository: RepositoryReference,
  commit: string,
  credential: GitLabCredentialData,
  signal?: AbortSignal,
): Promise<readonly RemoteSourceFile[]> {
  const prefix = `${repositoryPath(repository)}/repository/tree`;
  let path: string | null = `${prefix}?recursive=true&ref=${encodeURIComponent(commit)}&per_page=100&page=1`;
  const entries: GitLabTreeEntry[] = [];
  while (path) {
    const page: { readonly items: readonly GitLabTreeEntry[]; readonly next: string | null } =
      await gitlabPage<GitLabTreeEntry>(runtime, path, { credential, signal });
    for (const entry of page.items) {
      const type = String(entry.type ?? "");
      const mode = String(entry.mode ?? "");
      if (type === "commit" || mode === "160000") {
        throw new GitLabRepositoryError("GitLab source imports do not allow submodules.", {
          status: 422,
        });
      }
      if (mode === "120000") {
        throw new GitLabRepositoryError("GitLab source imports do not allow symbolic links.", {
          status: 422,
        });
      }
      if (type !== "blob") continue;
      entries.push(entry);
      if (entries.length > runtime.maxFiles) {
        throw new GitLabRepositoryError(
          `GitLab source exceeds the ${runtime.maxFiles} file limit.`,
          { status: 422 },
        );
      }
    }
    path = page.next;
  }
  let downloadedBytes = 0;
  return mapConcurrent(entries, runtime.concurrency, async (entry) => {
    const sourcePath = normalizeProjectPath(requiredProviderText(entry.path, "GitLab source path"));
    const blob = requiredProviderText(entry.id, "GitLab blob id");
    const response = await gitlabRawRequest(
      runtime,
      `${repositoryPath(repository)}/repository/blobs/${segment(blob)}/raw`,
      { credential, headers: { accept: "application/octet-stream" }, signal },
    );
    const content = new Uint8Array(await response.arrayBuffer());
    downloadedBytes += content.byteLength;
    if (downloadedBytes > runtime.maxBytes) {
      throw new GitLabRepositoryError(
        `GitLab source exceeds the ${runtime.maxBytes} byte limit.`,
        { status: 422 },
      );
    }
    return {
      path: sourcePath,
      content,
      ...(String(entry.mode) === "100755" ? { executable: true } : {}),
    };
  });
}

async function getBranchResponse(
  runtime: GitLabRuntime,
  repository: RepositoryReference,
  name: string,
  credential: GitLabCredentialData,
  signal?: AbortSignal,
): Promise<GitLabBranchResponse | null> {
  return gitlabRequestOrNull(
    runtime,
    `${repositoryPath(repository)}/repository/branches/${segment(name)}`,
    { credential, signal },
  );
}

async function tokenRequest(
  runtime: GitLabRuntime,
  form: URLSearchParams,
  signal?: AbortSignal,
): Promise<Record<string, unknown>> {
  return gitlabRequest(runtime, runtime.tokenUrl, {
    method: "POST",
    form,
    signal,
    expected: [200],
  });
}

async function gitlabPage<Value>(
  runtime: GitLabRuntime,
  path: string,
  options: GitLabRequestOptions,
): Promise<{ readonly items: readonly Value[]; readonly next: string | null }> {
  const response = await gitlabRawRequest(runtime, path, options);
  const payload = await response.json().catch((cause) => {
    throw new GitLabRepositoryError("GitLab returned an invalid JSON response.", {
      status: response.status,
      cause,
    });
  });
  if (!Array.isArray(payload)) {
    throw new GitLabRepositoryError("GitLab returned an invalid paginated response.", {
      status: response.status,
    });
  }
  const currentUrl = new URL(requestUrl(runtime, path));
  const resourcePrefix = currentUrl.pathname.slice(runtime.apiPath.length);
  const link = nextLink(response.headers.get("link"));
  const nextPage = response.headers.get("x-next-page")?.trim();
  const next = link ? validateApiUrl(runtime, link, resourcePrefix) : (nextPage
    ? (() => {
        const url = new URL(currentUrl);
        url.searchParams.set("page", nextPage);
        return validateApiUrl(runtime, url.href, resourcePrefix);
      })()
    : null);
  return { items: payload as Value[], next };
}

async function gitlabRequest<Value = unknown>(
  runtime: GitLabRuntime,
  path: string,
  options: GitLabRequestOptions = {},
): Promise<Value> {
  const response = await gitlabRawRequest(runtime, path, options);
  if (response.status === 204) return undefined as Value;
  const text = await response.text();
  if (!text) return undefined as Value;
  try {
    return JSON.parse(text) as Value;
  } catch (cause) {
    throw new GitLabRepositoryError("GitLab returned an invalid JSON response.", {
      status: response.status,
      cause,
    });
  }
}

async function gitlabRequestOrNull<Value>(
  runtime: GitLabRuntime,
  path: string,
  options: GitLabRequestOptions = {},
): Promise<Value | null> {
  try {
    return await gitlabRequest<Value>(runtime, path, options);
  } catch (error) {
    if (error instanceof GitLabRepositoryError && error.status === 404) return null;
    throw error;
  }
}

async function gitlabRawRequest(
  runtime: GitLabRuntime,
  path: string,
  options: GitLabRequestOptions = {},
): Promise<Response> {
  options.signal?.throwIfAborted();
  const url = requestUrl(runtime, path);
  const headers = new Headers(options.headers);
  if (!headers.has("accept")) headers.set("accept", "application/json");
  if (options.credential) headers.set("authorization", `Bearer ${options.credential.accessToken}`);
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(options.json);
  } else if (options.form) {
    headers.set("content-type", "application/x-www-form-urlencoded");
    body = options.form.toString();
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
    throw new GitLabRepositoryError("GitLab request failed before receiving a response.", { cause });
  }
  const expected = options.expected ?? [200];
  if (expected.includes(response.status)) return response;
  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = null;
  }
  const object = record(payload);
  const message = providerErrorMessage(object?.message ?? object?.error_description ?? object?.error)
    ?? `GitLab request failed with HTTP ${response.status}.`;
  const code = optionalText(object?.error);
  throw new GitLabRepositoryError(message, {
    status: response.status,
    ...(code ? { code } : {}),
  });
}

function normalizeOptions(options: GitLabRepositoryOptions): GitLabRuntime {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("GitLab repository options are required.");
  }
  const clientId = requiredOption(options.clientId, "GitLab OAuth clientId");
  const clientSecret = requiredOption(options.clientSecret, "GitLab OAuth clientSecret");
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL, "GitLab base URL");
  const base = new URL(baseUrl);
  const apiUrl = normalizeBaseUrl(options.apiUrl ?? `${baseUrl}/api/v4`, "GitLab API URL");
  const api = new URL(apiUrl);
  if (api.origin !== base.origin) {
    throw new ConfigurationError("GitLab API URL must use the configured GitLab origin.");
  }
  return {
    clientId,
    clientSecret,
    baseUrl,
    baseOrigin: base.origin,
    apiUrl,
    apiPath: api.pathname.replace(/\/$/, ""),
    authorizationUrl: sameOriginUrl(
      options.authorizationUrl ?? `${baseUrl}/oauth/authorize`,
      base.origin,
      "GitLab authorization URL",
    ),
    tokenUrl: sameOriginUrl(
      options.tokenUrl ?? `${baseUrl}/oauth/token`,
      base.origin,
      "GitLab token URL",
    ),
    revokeUrl: sameOriginUrl(
      options.revokeUrl ?? `${baseUrl}/oauth/revoke`,
      base.origin,
      "GitLab revoke URL",
    ),
    scopes: Object.freeze([...(options.scopes ?? DEFAULT_SCOPES)]),
    fetch: options.fetch ?? globalThis.fetch,
    maxFiles: boundedInteger(
      options.source?.maxFiles,
      DEFAULT_SOURCE_FILES,
      1,
      100_000,
      "GitLab source file limit",
    ),
    maxBytes: boundedInteger(
      options.source?.maxBytes,
      DEFAULT_SOURCE_BYTES,
      1,
      1_000_000_000,
      "GitLab source byte limit",
    ),
    concurrency: boundedInteger(
      options.source?.concurrency,
      DEFAULT_CONCURRENCY,
      1,
      64,
      "GitLab source concurrency",
    ),
  };
}

function tokenCredential(
  token: Record<string, unknown>,
  fallbackRefreshToken: string | null,
  redirectUri: string,
): { readonly data: GitLabCredentialData; readonly expiresAt: Date | null } {
  const accessToken = requiredProviderText(token.access_token, "GitLab access token");
  const refreshToken = optionalText(token.refresh_token) ?? fallbackRefreshToken;
  const seconds = optionalNumber(token.expires_in);
  return {
    data: { version: 1, accessToken, refreshToken, redirectUri },
    expiresAt: seconds === null
      ? null
      : new Date(Date.now() + Math.max(0, seconds * 1_000 - TOKEN_EXPIRY_LEEWAY_MS)),
  };
}

function tokenScopes(token: Record<string, unknown>, fallback: readonly string[]): readonly string[] {
  const scope = optionalText(token.scope);
  return scope ? scope.split(/[ ,]+/).filter(Boolean) : [...fallback];
}

function encodeCredential(value: GitLabCredentialData): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeCredential(value: Uint8Array): GitLabCredentialData {
  try {
    const parsed = JSON.parse(textDecoder.decode(value)) as Partial<GitLabCredentialData>;
    if (parsed.version !== 1) throw new Error("invalid credential");
    return {
      version: 1,
      accessToken: requiredProviderText(parsed.accessToken, "GitLab access token"),
      refreshToken: optionalText(parsed.refreshToken),
      redirectUri: absoluteUrl(parsed.redirectUri ?? "", "GitLab redirect URI"),
    };
  } catch (cause) {
    throw new GitLabRepositoryError("The stored GitLab credential is invalid.", {
      status: 401,
      code: "invalid_credential",
      cause,
    });
  }
}

function encodeSession(value: GitLabAuthorizationSession): Uint8Array {
  return textEncoder.encode(JSON.stringify(value));
}

function decodeSession(value: Uint8Array): GitLabAuthorizationSession {
  try {
    const parsed = JSON.parse(textDecoder.decode(value)) as Partial<GitLabAuthorizationSession>;
    if (parsed.version !== 1) throw new Error("invalid session");
    return {
      version: 1,
      redirectUri: absoluteUrl(parsed.redirectUri ?? "", "GitLab redirect URI"),
    };
  } catch (cause) {
    throw new GitLabRepositoryError("The GitLab authorization session is invalid.", {
      status: 401,
      code: "invalid_session",
      cause,
    });
  }
}

function ownerData(namespace: GitLabNamespaceResponse): RepositoryOwnerData {
  const kind = String(namespace.kind ?? "").toLowerCase();
  return {
    id: String(requiredPositiveInteger(namespace.id, "GitLab namespace id")),
    name: requiredProviderText(
      namespace.full_path ?? namespace.path,
      "GitLab namespace path",
    ),
    kind: kind === "user" ? "user" : "organization",
    avatarUrl: optionalText(namespace.avatar_url),
  };
}

function repositoryData(repository: GitLabProjectResponse): RepositoryData {
  const fullPath = requiredProviderText(
    repository.path_with_namespace,
    "GitLab project path",
  );
  const name = requiredProviderText(repository.path ?? repository.name, "GitLab project name");
  const owner = fullPath.endsWith(`/${name}`)
    ? fullPath.slice(0, -(name.length + 1))
    : requiredProviderText(repository.namespace?.full_path, "GitLab project namespace");
  const visibility = String(repository.visibility ?? "private");
  if (!(["private", "internal", "public"] as const).includes(visibility as never)) {
    throw new GitLabRepositoryError("GitLab returned an unsupported project visibility.");
  }
  return {
    id: String(requiredPositiveInteger(repository.id, "GitLab project id")),
    owner,
    name,
    defaultBranch: optionalText(repository.default_branch) ?? "main",
    visibility: visibility as RepositoryData["visibility"],
    url: requiredProviderText(repository.web_url, "GitLab project URL"),
  };
}

function branchData(branch: GitLabBranchResponse): RepositoryBranchData {
  return {
    name: requiredProviderText(branch.name, "GitLab branch name"),
    head: commitHash(requiredResult(branch.commit, "GitLab branch commit")),
    protected: branch.protected === true,
  };
}

function commitData(
  commit: GitLabCommitResponse,
  branch: string,
  fallbackMessage: string,
): RepositoryCommitData {
  return {
    id: commitHash(commit),
    message: optionalText(commit.message) ?? fallbackMessage,
    branch,
    url: optionalText(commit.web_url),
  };
}

function pullRequestData(mergeRequest: GitLabMergeRequestResponse): RepositoryPullRequestData {
  const state = String(mergeRequest.state ?? "").toLowerCase();
  const title = requiredProviderText(mergeRequest.title, "GitLab merge request title");
  return {
    id: String(requiredPositiveInteger(mergeRequest.id, "GitLab merge request id")),
    number: requiredPositiveInteger(mergeRequest.iid, "GitLab merge request iid"),
    title,
    head: requiredProviderText(mergeRequest.source_branch, "GitLab merge request source branch"),
    base: requiredProviderText(mergeRequest.target_branch, "GitLab merge request target branch"),
    status: state === "merged" || mergeRequest.merged_at
      ? "merged"
      : state === "opened" && (mergeRequest.draft === true || /^draft:/i.test(title))
        ? "draft"
        : state === "opened" ? "open" : "closed",
    url: requiredProviderText(mergeRequest.web_url, "GitLab merge request URL"),
  };
}

function commitHash(commit: GitLabCommitResponse): string {
  return requiredProviderText(commit.id, "GitLab commit id");
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

function gitlabCommitActions(
  previous: readonly RemoteSourceFile[],
  upserted: readonly RemoteSourceFile[],
  deleted: readonly string[],
): readonly Record<string, unknown>[] {
  const previousByPath = new Map(previous.map((file) => [file.path, file]));
  const actions: Record<string, unknown>[] = [];
  for (const file of upserted) {
    const before = previousByPath.get(file.path);
    if (!before || !bytesEqual(before.content, file.content)) {
      actions.push({
        action: before ? "update" : "create",
        file_path: file.path,
        content: bytesToBase64(file.content),
        encoding: "base64",
      });
    }
    if ((before?.executable ?? false) !== (file.executable ?? false)) {
      actions.push({
        action: "chmod",
        file_path: file.path,
        execute_filemode: file.executable === true,
      });
    }
  }
  for (const path of deleted) actions.push({ action: "delete", file_path: path });
  return actions;
}

function validateSourceFiles(
  runtime: GitLabRuntime,
  files: readonly IntegrationSourceFile[],
): readonly RemoteSourceFile[] {
  if (!Array.isArray(files) || files.length > runtime.maxFiles) {
    throw new ConfigurationError(`GitLab source must contain at most ${runtime.maxFiles} files.`);
  }
  const seen = new Set<string>();
  let bytes = 0;
  return files.map((file) => {
    const path = normalizeProjectPath(file.path);
    if (seen.has(path)) throw new ConfigurationError(`Duplicate GitLab source path: ${path}`);
    seen.add(path);
    if (!(file.content instanceof Uint8Array)) {
      throw new ConfigurationError(`GitLab source file ${path} must contain bytes.`);
    }
    bytes += file.content.byteLength;
    if (bytes > runtime.maxBytes) {
      throw new ConfigurationError(`GitLab source exceeds the ${runtime.maxBytes} byte limit.`);
    }
    return {
      path,
      content: new Uint8Array(file.content),
      ...(file.mediaType ? { mediaType: file.mediaType } : {}),
      ...(file.executable ? { executable: true } : {}),
    };
  });
}

function repositoryPath(reference: RepositoryReference): string {
  return `/projects/${segment(`${requiredOption(reference.owner, "GitLab repository owner")}/${repositoryName(reference.name)}`)}`;
}

function repositoryName(value: string): string {
  const name = requiredOption(value, "GitLab repository name");
  if (name.includes("/") || name === "." || name === "..") {
    throw new ConfigurationError("GitLab repository name must be one path segment.");
  }
  return name;
}

function requestUrl(runtime: GitLabRuntime, path: string): string {
  if (/^https?:\/\//i.test(path)) {
    const url = new URL(path);
    if (url.origin !== runtime.baseOrigin) {
      throw new ConfigurationError("GitLab request must remain on the configured GitLab origin.");
    }
    if (url.href === runtime.tokenUrl || url.href === runtime.revokeUrl) return url.href;
    return validateApiUrl(runtime, url.href);
  }
  if (!path.startsWith("/")) throw new ConfigurationError("GitLab request path must be absolute.");
  return `${runtime.apiUrl}${path}`;
}

function validateApiUrl(runtime: GitLabRuntime, value: string, prefix?: string): string {
  const url = new URL(value);
  if (url.origin !== runtime.baseOrigin) {
    throw new ConfigurationError("GitLab cursor must remain on the configured GitLab origin.");
  }
  if (!url.pathname.startsWith(`${runtime.apiPath}/`) && url.pathname !== runtime.apiPath) {
    throw new ConfigurationError("GitLab cursor must remain inside the configured API path.");
  }
  if (prefix && !url.pathname.startsWith(`${runtime.apiPath}${prefix}`)) {
    throw new ConfigurationError("GitLab cursor does not match the requested resource.");
  }
  return url.href;
}

function encodeCursor(value: string): string {
  return Buffer.from(value).toString("base64url");
}

function decodeCursor(runtime: GitLabRuntime, value: string, prefix: string): string {
  try {
    return validateApiUrl(runtime, Buffer.from(value, "base64url").toString("utf8"), prefix);
  } catch (cause) {
    if (cause instanceof ConfigurationError) throw cause;
    throw new ConfigurationError("GitLab cursor is invalid.");
  }
}

function nextLink(value: string | null): string | null {
  if (!value) return null;
  for (const item of value.split(",")) {
    const match = item.match(/^\s*<([^>]+)>;\s*rel="?next"?\s*$/i);
    if (match?.[1]) return match[1];
  }
  return null;
}

function bytesToBase64(value: Uint8Array): string {
  return Buffer.from(value).toString("base64");
}

function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  return left.byteLength === right.byteLength && left.every((value, index) => value === right[index]);
}

function segment(value: string): string {
  return encodeURIComponent(requiredOption(value, "GitLab path segment"));
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new GitLabRepositoryError(`GitLab callback is missing ${name}.`, { status: 401 });
  return value;
}

function requiredOption(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ConfigurationError(`${label} is required.`);
  return normalized;
}

function absoluteUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (!/^https?:$/.test(url.protocol)) throw new Error("unsupported protocol");
    return url.href;
  } catch {
    throw new ConfigurationError(`${label} must be an absolute HTTP URL.`);
  }
}

function sameOriginUrl(value: string, origin: string, label: string): string {
  const url = absoluteUrl(value, label);
  if (new URL(url).origin !== origin) {
    throw new ConfigurationError(`${label} must use the configured GitLab origin.`);
  }
  return url;
}

function normalizeBaseUrl(value: string, label: string): string {
  return absoluteUrl(value, label).replace(/\/$/, "");
}

function optionalText(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function optionalNumber(value: unknown): number | null {
  const number = typeof value === "number" ? value : Number(value);
  return Number.isFinite(number) ? number : null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function providerErrorMessage(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  const object = record(value);
  if (!object) return null;
  return Object.entries(object)
    .map(([key, entry]) => `${key}: ${Array.isArray(entry) ? entry.join(", ") : String(entry)}`)
    .join("; ") || null;
}

function requiredProviderText(value: unknown, label: string): string {
  const text = optionalText(value);
  if (!text) throw new GitLabRepositoryError(`${label} was missing from the provider response.`);
  return text;
}

function requiredResult<Value>(value: Value | null | undefined, label: string): Value {
  if (value === undefined || value === null) {
    throw new GitLabRepositoryError(`${label} was missing from the provider response.`);
  }
  return value;
}

function requiredPositiveInteger(value: unknown, label: string): number {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) {
    throw new GitLabRepositoryError(`${label} was invalid in the provider response.`);
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
    throw new ConfigurationError(`${label} must be an integer from ${minimum} through ${maximum}.`);
  }
  return number;
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (cursor < values.length) {
      const index = cursor;
      cursor += 1;
      output[index] = await operation(values[index]!);
    }
  }));
  return output;
}
