import { createPrivateKey, createSign, type KeyObject } from "node:crypto";
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
  RepositoryData,
  RepositoryIntegration,
  RepositoryOwnerData,
  RepositoryPullRequestData,
  RepositoryReference,
  RepositorySourceData,
} from "./integrations.js";
import { normalizeProjectPath } from "./utils.js";

const DEFAULT_API_URL = "https://api.github.com";
const DEFAULT_WEB_URL = "https://github.com";
const DEFAULT_API_VERSION = "2026-03-10";
const DEFAULT_SOURCE_FILES = 5_000;
const DEFAULT_SOURCE_BYTES = 25_000_000;
const DEFAULT_CONCURRENCY = 8;
const TOKEN_EXPIRY_LEEWAY_MS = 60_000;

export interface GitHubCommitIdentity {
  readonly name: string;
  readonly email: string;
  readonly date?: Date | string;
}

export interface GitHubPushOptions {
  readonly author?: GitHubCommitIdentity;
  readonly committer?: GitHubCommitIdentity;
}

export interface GitHubPullRequestOptions {
  readonly maintainerCanModify?: boolean;
}

export interface GitHubMergeOptions {
  readonly commitTitle?: string;
  readonly commitMessage?: string;
}

export interface GitHubRepositoryOptions {
  readonly appId: string | number;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly privateKey: string | Uint8Array;
  readonly slug: string;
  readonly apiUrl?: string;
  readonly webUrl?: string;
  /** Override for GitHub Enterprise or a custom installation entry point. */
  readonly installationUrl?: string;
  readonly apiVersion?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly source?: {
    readonly maxFiles?: number;
    readonly maxBytes?: number;
    readonly concurrency?: number;
  };
}

interface GitHubCredentialData {
  readonly version: 1;
  readonly installationId: number;
  readonly installationToken: string;
  readonly userToken: string;
  readonly userExpiresAt: string | null;
  readonly userRefreshToken: string | null;
  readonly userRefreshExpiresAt: string | null;
}

interface GitHubAccount {
  readonly id: number;
  readonly login: string;
  readonly type: string;
  readonly avatar_url?: string | null;
  readonly html_url?: string;
}

interface GitHubRepositoryData {
  readonly id: number;
  readonly name: string;
  readonly owner: GitHubAccount;
  readonly default_branch: string;
  readonly visibility?: string;
  readonly private?: boolean;
  readonly html_url: string;
}

interface GitHubPullRequestData {
  readonly id: number;
  readonly number: number;
  readonly title: string;
  readonly state: "open" | "closed";
  readonly draft?: boolean;
  readonly merged?: boolean;
  readonly merged_at?: string | null;
  readonly html_url: string;
  readonly head: { readonly ref: string; readonly sha: string };
  readonly base: { readonly ref: string };
}

interface GitHubRequestOptions {
  readonly method?: string;
  readonly token?: string;
  readonly basic?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal | undefined;
  readonly expected?: readonly number[];
}

interface GitHubRuntime {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly slug: string;
  readonly apiUrl: string;
  readonly webUrl: string;
  readonly installationUrl: string;
  readonly apiVersion: string;
  readonly fetch: typeof globalThis.fetch;
  readonly privateKey: KeyObject;
  readonly maxFiles: number;
  readonly maxBytes: number;
  readonly concurrency: number;
}

export class GitHubRepositoryError extends Error {
  readonly status: number | null;
  readonly documentationUrl: string | null;

  constructor(
    message: string,
    options: { readonly status?: number; readonly documentationUrl?: string; readonly cause?: unknown } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "GitHubRepositoryError";
    this.status = options.status ?? null;
    this.documentationUrl = options.documentationUrl ?? null;
  }
}

/** Creates a GitHub App-backed provider for `integrations.repository`. */
export function github(
  options: GitHubRepositoryOptions,
): RepositoryIntegration<GitHubPushOptions, GitHubPullRequestOptions, GitHubMergeOptions> {
  const runtime = normalizeOptions(options);
  return {
    provider: "github",
    displayName: "GitHub",
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
      async refreshCredential(credential, context) {
        const current = decodeCredential(credential.secret);
        const user = await refreshUserToken(runtime, current, context.signal);
        const installation = await createInstallationToken(
          runtime,
          current.installationId,
          context.signal,
        );
        const next = { ...user, installationToken: installation.token };
        return {
          secret: encodeCredential(next),
          expiresAt: credentialExpiry(installation.expires_at),
          scopes: permissionScopes(installation.permissions),
        };
      },
      async revokeCredential(credential, context) {
        const current = decodeCredential(credential.secret);
        const results = await Promise.allSettled([
          githubRequest(runtime, "/installation/token", {
            method: "DELETE",
            token: current.installationToken,
            signal: context.signal,
            expected: [204, 401],
          }),
          githubRequest(runtime, `/applications/${encodeURIComponent(runtime.clientId)}/token`, {
            method: "DELETE",
            basic: `${runtime.clientId}:${runtime.clientSecret}`,
            body: { access_token: current.userToken },
            signal: context.signal,
            expected: [204, 404, 422],
          }),
        ]);
        const failed = results.find(
          (result): result is PromiseRejectedResult => result.status === "rejected",
        );
        if (failed) throw failed.reason;
      },
    },
    async listOwners(_input: ListRepositoryOwnersInput, context) {
      return listOwners(context);
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

export const githubRepository = github;

async function completeAuthorization(
  runtime: GitHubRuntime,
  callbackUrl: string,
  context: IntegrationAuthorizationContext,
): Promise<IntegrationAuthorizationResult> {
  const callback = new URL(callbackUrl);
  const code = requiredQuery(callback, "code");
  const installationId = positiveInteger(requiredQuery(callback, "installation_id"), "installation_id");
  const user = await exchangeUserCode(runtime, code, callback.origin + callback.pathname, context.signal);
  const accessible = await userCanAccessInstallation(
    runtime,
    user.access_token,
    installationId,
    context.signal,
  );
  if (!accessible) {
    throw new GitHubRepositoryError(
      "GitHub did not confirm that the authorizing user can access this app installation.",
      { status: 403 },
    );
  }
  const appToken = createAppJwt(runtime);
  const installation = await githubRequest<{
    readonly id: number;
    readonly target_type: string;
    readonly account: GitHubAccount;
  }>(runtime, `/app/installations/${installationId}`, {
    token: appToken,
    signal: context.signal,
  });
  const token = await createInstallationToken(runtime, installationId, context.signal);
  const secret: GitHubCredentialData = {
    version: 1,
    installationId,
    installationToken: token.token,
    userToken: user.access_token,
    userExpiresAt: oauthExpiry(user.expires_in),
    userRefreshToken: user.refresh_token ?? null,
    userRefreshExpiresAt: oauthExpiry(user.refresh_token_expires_in),
  };
  return {
    account: {
      id: String(installation.id),
      name: installation.account.login,
      ...(installation.account.html_url ? { url: installation.account.html_url } : {}),
      metadata: {
        installationId: String(installationId),
        targetType: installation.target_type,
      },
    },
    credential: {
      secret: encodeCredential(secret),
      expiresAt: credentialExpiry(token.expires_at),
      scopes: permissionScopes(token.permissions),
    },
  };
}

async function exchangeUserCode(
  runtime: GitHubRuntime,
  code: string,
  redirectUri: string,
  signal?: AbortSignal,
) {
  const result = await githubWebRequest<{
    readonly access_token: string;
    readonly expires_in?: number;
    readonly refresh_token?: string;
    readonly refresh_token_expires_in?: number;
  }>(runtime, "/login/oauth/access_token", {
    body: {
      client_id: runtime.clientId,
      client_secret: runtime.clientSecret,
      code,
      redirect_uri: redirectUri,
    },
    signal,
  });
  if (!result.access_token) {
    throw new GitHubRepositoryError("GitHub returned no user access token.", { status: 401 });
  }
  return result;
}

async function userCanAccessInstallation(
  runtime: GitHubRuntime,
  token: string,
  installationId: number,
  signal?: AbortSignal,
): Promise<boolean> {
  for (let page = 1; page <= 10; page += 1) {
    const result = await githubRequest<{
      readonly total_count: number;
      readonly installations: readonly { readonly id: number }[];
    }>(runtime, `/user/installations?per_page=100&page=${page}`, { token, signal });
    if (result.installations.some((installation) => installation.id === installationId)) return true;
    if (page * 100 >= result.total_count) return false;
  }
  return false;
}

async function createInstallationToken(
  runtime: GitHubRuntime,
  installationId: number,
  signal?: AbortSignal,
) {
  const result = await githubRequest<{
    readonly token: string;
    readonly expires_at: string;
    readonly permissions?: Readonly<Record<string, string>>;
  }>(runtime, `/app/installations/${installationId}/access_tokens`, {
    method: "POST",
    token: createAppJwt(runtime),
    body: {},
    signal,
    expected: [201],
  });
  if (!result.token) {
    throw new GitHubRepositoryError("GitHub returned no installation access token.", {
      status: 401,
    });
  }
  return result;
}

async function refreshUserToken(
  runtime: GitHubRuntime,
  credential: GitHubCredentialData,
  signal?: AbortSignal,
): Promise<GitHubCredentialData> {
  if (!credential.userExpiresAt
    || new Date(credential.userExpiresAt).getTime() > Date.now() + TOKEN_EXPIRY_LEEWAY_MS) {
    return credential;
  }
  if (!credential.userRefreshToken
    || (credential.userRefreshExpiresAt
      && new Date(credential.userRefreshExpiresAt).getTime() <= Date.now())) {
    throw new GitHubRepositoryError("The GitHub user authorization must be renewed.", { status: 401 });
  }
  const refreshed = await githubWebRequest<{
    readonly access_token: string;
    readonly expires_in?: number;
    readonly refresh_token?: string;
    readonly refresh_token_expires_in?: number;
  }>(runtime, "/login/oauth/access_token", {
    body: {
      client_id: runtime.clientId,
      client_secret: runtime.clientSecret,
      grant_type: "refresh_token",
      refresh_token: credential.userRefreshToken,
    },
    signal,
  });
  if (!refreshed.access_token) {
    throw new GitHubRepositoryError("GitHub returned no refreshed user access token.", {
      status: 401,
    });
  }
  return {
    ...credential,
    userToken: refreshed.access_token,
    userExpiresAt: oauthExpiry(refreshed.expires_in),
    userRefreshToken: refreshed.refresh_token ?? credential.userRefreshToken,
    userRefreshExpiresAt: oauthExpiry(refreshed.refresh_token_expires_in)
      ?? credential.userRefreshExpiresAt,
  };
}

function listOwners(context: IntegrationOperationContext): IntegrationPage<RepositoryOwnerData> {
  const targetType = context.externalAccount.metadata?.targetType;
  return {
    items: [{
      id: context.externalAccount.id,
      name: context.externalAccount.name,
      kind: targetType === "Organization" ? "organization" : "user",
      avatarUrl: null,
    }],
    nextCursor: null,
  };
}

async function listRepositories(
  runtime: GitHubRuntime,
  input: ListRepositoriesInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryData>> {
  const credential = decodeCredential(context.credential);
  const { page, limit } = pagination(input.cursor, input.limit);
  const response = await githubRequest<{
    readonly total_count: number;
    readonly repositories: readonly GitHubRepositoryData[];
  }>(runtime, `/installation/repositories?per_page=${limit}&page=${page}`, {
    token: credential.installationToken,
    signal: context.signal,
  });
  const search = input.search?.trim().toLowerCase();
  const items = response.repositories
    .filter((repository) => !input.owner || repository.owner.login === input.owner)
    .filter((repository) => !search || repository.name.toLowerCase().includes(search))
    .map(mapRepository);
  return {
    items,
    nextCursor: page * limit < response.total_count ? encodePage(page + 1) : null,
  };
}

async function getRepository(
  runtime: GitHubRuntime,
  input: RepositoryReference,
  context: IntegrationOperationContext,
): Promise<RepositoryData | null> {
  const credential = decodeCredential(context.credential);
  const response = await githubRequestOrNull<GitHubRepositoryData>(
    runtime,
    repositoryPath(input),
    { token: credential.installationToken, signal: context.signal },
  );
  return response ? mapRepository(response) : null;
}

async function createRepository(
  runtime: GitHubRuntime,
  input: CreateRepositoryInput,
  context: IntegrationOperationContext,
): Promise<RepositoryData> {
  const credential = decodeCredential(context.credential);
  const targetType = context.externalAccount.metadata?.targetType;
  if (input.owner !== context.externalAccount.name) {
    throw new GitHubRepositoryError(
      "A GitHub App installation can create repositories only in its connected account.",
      { status: 403 },
    );
  }
  const path = targetType === "Organization"
    ? `/orgs/${segment(input.owner)}/repos`
    : "/user/repos";
  const token = targetType === "Organization"
    ? credential.installationToken
    : credential.userToken;
  const response = await githubRequest<GitHubRepositoryData>(runtime, path, {
    method: "POST",
    token,
    body: {
      name: input.name,
      ...(input.description !== undefined ? { description: input.description } : {}),
      private: input.visibility !== "public",
      ...(input.visibility === "internal" ? { visibility: "internal" } : {}),
    },
    signal: context.signal,
    expected: [201],
  });
  return mapRepository(response);
}

async function listBranches(
  runtime: GitHubRuntime,
  input: ListRepositoryBranchesInput,
  context: IntegrationOperationContext,
): Promise<IntegrationPage<RepositoryBranchData>> {
  const credential = decodeCredential(context.credential);
  const { page, limit } = pagination(input.cursor, input.limit);
  const response = await githubRequest<readonly {
    readonly name: string;
    readonly protected: boolean;
    readonly commit: { readonly sha: string };
  }[]>(runtime, `${repositoryPath(input.repository)}/branches?per_page=${limit}&page=${page}`, {
    token: credential.installationToken,
    signal: context.signal,
  });
  return {
    items: response.map((branch) => ({
      name: branch.name,
      head: branch.commit.sha,
      protected: branch.protected,
    })),
    nextCursor: response.length === limit ? encodePage(page + 1) : null,
  };
}

async function getBranch(
  runtime: GitHubRuntime,
  input: GetRepositoryBranchInput,
  context: IntegrationOperationContext,
): Promise<RepositoryBranchData | null> {
  const credential = decodeCredential(context.credential);
  const response = await githubRequestOrNull<{
    readonly name: string;
    readonly protected: boolean;
    readonly commit: { readonly sha: string };
  }>(runtime, `${repositoryPath(input.repository)}/branches/${segment(input.name)}`, {
    token: credential.installationToken,
    signal: context.signal,
  });
  return response ? {
    name: response.name,
    head: response.commit.sha,
    protected: response.protected,
  } : null;
}

async function createBranch(
  runtime: GitHubRuntime,
  input: CreateRepositoryBranchInput,
  context: IntegrationOperationContext,
): Promise<RepositoryBranchData> {
  const credential = decodeCredential(context.credential);
  const source = await resolveCommit(runtime, input.repository, input.from, credential, context.signal);
  await githubRequest(runtime, `${repositoryPath(input.repository)}/git/refs`, {
    method: "POST",
    token: credential.installationToken,
    body: { ref: `refs/heads/${input.name}`, sha: source.sha },
    signal: context.signal,
    expected: [201],
  });
  return { name: input.name, head: source.sha, protected: false };
}

async function readSource(
  runtime: GitHubRuntime,
  input: ReadRepositorySourceInput,
  context: IntegrationOperationContext,
): Promise<RepositorySourceData> {
  const credential = decodeCredential(context.credential);
  const repository = await githubRequest<GitHubRepositoryData>(
    runtime,
    repositoryPath(input.repository),
    { token: credential.installationToken, signal: context.signal },
  );
  const ref = "branch" in input.ref
    ? input.ref.branch
    : "tag" in input.ref ? input.ref.tag : input.ref.commit;
  const commit = await resolveCommit(runtime, input.repository, ref, credential, context.signal);
  const tree = await readTree(runtime, input.repository, commit.tree, credential, context.signal);
  if (tree.truncated) {
    throw new GitHubRepositoryError(
      "The GitHub source tree is too large for a recursive read; use a smaller repository.",
      { status: 422 },
    );
  }
  const blobs = tree.tree.filter((entry) => entry.type === "blob");
  if (blobs.some((entry) => entry.mode === "120000")) {
    throw new GitHubRepositoryError("GitHub source imports do not allow symbolic links.", {
      status: 422,
    });
  }
  if (tree.tree.some((entry) => entry.type === "commit" || entry.mode === "160000")) {
    throw new GitHubRepositoryError("GitHub source imports do not allow submodules.", {
      status: 422,
    });
  }
  if (blobs.length > runtime.maxFiles) {
    throw new GitHubRepositoryError(`GitHub source exceeds the ${runtime.maxFiles} file limit.`, {
      status: 422,
    });
  }
  const declaredBytes = blobs.reduce((total, entry) => total + (entry.size ?? 0), 0);
  if (declaredBytes > runtime.maxBytes) {
    throw new GitHubRepositoryError(`GitHub source exceeds the ${runtime.maxBytes} byte limit.`, {
      status: 422,
    });
  }
  let downloadedBytes = 0;
  const files = await mapConcurrent(blobs, runtime.concurrency, async (entry) => {
    const blob = await githubRequest<{ readonly content: string; readonly encoding: string }>(
      runtime,
      `${repositoryPath(input.repository)}/git/blobs/${segment(entry.sha)}`,
      { token: credential.installationToken, signal: context.signal },
    );
    if (blob.encoding !== "base64") {
      throw new GitHubRepositoryError("GitHub returned an unsupported blob encoding.");
    }
    const content = new Uint8Array(Buffer.from(blob.content.replaceAll(/\s/g, ""), "base64"));
    downloadedBytes += content.byteLength;
    if (downloadedBytes > runtime.maxBytes) {
      throw new GitHubRepositoryError(`GitHub source exceeds the ${runtime.maxBytes} byte limit.`, {
        status: 422,
      });
    }
    return {
      path: normalizeProjectPath(entry.path),
      content,
      ...(entry.mode === "100755" ? { executable: true } : {}),
    } satisfies IntegrationSourceFile;
  });
  return {
    repository: mapRepository(repository),
    ref: input.ref,
    commit: commit.sha,
    files,
  };
}

async function pushVersion(
  runtime: GitHubRuntime,
  input: PushRepositoryVersionInput<GitHubPushOptions>,
  context: IntegrationOperationContext,
): Promise<PushRepositoryVersionResult> {
  validateSourceFiles(runtime, input.files);
  const credential = decodeCredential(context.credential);
  let target = await getReference(
    runtime,
    input.repository,
    `heads/${input.branch}`,
    credential,
    context.signal,
  );
  let createReference = target === null;
  if (!target && !input.createBranch) {
    throw new GitHubRepositoryError(`GitHub branch ${input.branch} does not exist.`, { status: 404 });
  }
  let currentHead = target?.object.sha ?? null;
  if (!currentHead && input.baseBranch) {
    const base = await getReference(
      runtime,
      input.repository,
      `heads/${input.baseBranch}`,
      credential,
      context.signal,
    );
    if (base) {
      currentHead = base.object.sha;
    } else {
      const repositoryDefault = await defaultBranch(
        runtime,
        input.repository,
        credential,
        context.signal,
      );
      if (input.baseBranch !== repositoryDefault) {
        throw new GitHubRepositoryError(`GitHub base branch ${input.baseBranch} does not exist.`, {
          status: 404,
        });
      }
      currentHead = await initializeEmptyRepository(
        runtime,
        input,
        credential,
        "placeholder",
        context.signal,
      );
    }
  }
  if (!currentHead) {
    const repositoryDefault = await defaultBranch(
      runtime,
      input.repository,
      credential,
      context.signal,
    );
    currentHead = await initializeEmptyRepository(
      runtime,
      input,
      credential,
      input.branch === repositoryDefault ? "source" : "placeholder",
      context.signal,
    );
    if (input.branch === repositoryDefault) {
      createReference = false;
      target = { object: { sha: currentHead } };
    }
  }
  if (input.expectedHead !== undefined && input.expectedHead !== currentHead) {
    return { status: "conflict", expectedHead: input.expectedHead, actualHead: currentHead };
  }

  const blobs = await mapConcurrent(input.files, runtime.concurrency, async (file) => {
    const blob = await githubRequest<{ readonly sha: string }>(
      runtime,
      `${repositoryPath(input.repository)}/git/blobs`,
      {
        method: "POST",
        token: credential.installationToken,
        body: { content: Buffer.from(file.content).toString("base64"), encoding: "base64" },
        signal: context.signal,
        expected: [201],
      },
    );
    return {
      path: file.path,
      mode: file.executable ? "100755" : "100644",
      type: "blob",
      sha: blob.sha,
    };
  });
  const previousTree = await commitTree(runtime, input.repository, currentHead, credential, context.signal);
  if (previousTree.truncated) {
    throw new GitHubRepositoryError(
      "The existing GitHub tree is too large for a safe complete-snapshot push.",
      { status: 422 },
    );
  }
  const tree = await githubRequest<{ readonly sha: string }>(
    runtime,
    `${repositoryPath(input.repository)}/git/trees`,
    {
      method: "POST",
      token: credential.installationToken,
      body: { tree: blobs },
      signal: context.signal,
      expected: [201],
    },
  );
  const commit = await githubRequest<{ readonly sha: string; readonly html_url?: string }>(
    runtime,
    `${repositoryPath(input.repository)}/git/commits`,
    {
      method: "POST",
      token: credential.installationToken,
      body: {
        message: input.message,
        tree: tree.sha,
        parents: currentHead ? [currentHead] : [],
        ...(input.providerOptions?.author
          ? { author: commitIdentity(input.providerOptions.author) }
          : {}),
        ...(input.providerOptions?.committer
          ? { committer: commitIdentity(input.providerOptions.committer) }
          : {}),
      },
      signal: context.signal,
      expected: [201],
    },
  );
  try {
    if (createReference) {
      await githubRequest(runtime, `${repositoryPath(input.repository)}/git/refs`, {
        method: "POST",
        token: credential.installationToken,
        body: { ref: `refs/heads/${input.branch}`, sha: commit.sha },
        signal: context.signal,
        expected: [201],
      });
    } else {
      await githubRequest(runtime, `${repositoryPath(input.repository)}/git/refs/heads/${refPath(input.branch)}`, {
        method: "PATCH",
        token: credential.installationToken,
        body: { sha: commit.sha, force: false },
        signal: context.signal,
        expected: [200],
      });
    }
  } catch (error) {
    if (!(error instanceof GitHubRepositoryError) || ![409, 422].includes(error.status ?? 0)) {
      throw error;
    }
    const actual = await getReference(
      runtime,
      input.repository,
      `heads/${input.branch}`,
      credential,
      context.signal,
    );
    if (!actual || actual.object.sha === currentHead) throw error;
    return {
      status: "conflict",
      expectedHead: input.expectedHead ?? currentHead,
      actualHead: actual.object.sha,
    };
  }
  return {
    status: "pushed",
    commit: {
      id: commit.sha,
      message: input.message,
      branch: input.branch,
      url: commit.html_url ?? null,
    },
    changedFiles: changedFileCount(previousTree.tree, blobs),
  };
}

async function createPullRequest(
  runtime: GitHubRuntime,
  input: CreateRepositoryPullRequestInput<GitHubPullRequestOptions>,
  context: IntegrationOperationContext,
): Promise<RepositoryPullRequestData> {
  const credential = decodeCredential(context.credential);
  const response = await githubRequest<GitHubPullRequestData>(
    runtime,
    `${repositoryPath(input.repository)}/pulls`,
    {
      method: "POST",
      token: credential.installationToken,
      body: {
        title: input.title,
        head: input.head,
        base: input.base,
        ...(input.body !== undefined ? { body: input.body } : {}),
        ...(input.draft !== undefined ? { draft: input.draft } : {}),
        ...(input.providerOptions?.maintainerCanModify !== undefined
          ? { maintainer_can_modify: input.providerOptions.maintainerCanModify }
          : {}),
      },
      signal: context.signal,
      expected: [201],
    },
  );
  return mapPullRequest(response);
}

async function mergePullRequest(
  runtime: GitHubRuntime,
  input: MergeRepositoryPullRequestInput<GitHubMergeOptions>,
  context: IntegrationOperationContext,
): Promise<RepositoryPullRequestData> {
  const credential = decodeCredential(context.credential);
  const path = `${repositoryPath(input.repository)}/pulls/${input.number}`;
  const current = await githubRequest<GitHubPullRequestData>(runtime, path, {
    token: credential.installationToken,
    signal: context.signal,
  });
  if (current.merged || current.merged_at) return mapPullRequest(current);
  if (input.expectedHead && input.expectedHead !== current.head.sha) {
    throw new GitHubRepositoryError("The GitHub pull request head changed before merge.", {
      status: 409,
    });
  }
  await githubRequest(runtime, `${path}/merge`, {
    method: "PUT",
    token: credential.installationToken,
    body: {
      merge_method: input.method ?? "merge",
      ...(input.expectedHead ? { sha: input.expectedHead } : {}),
      ...(input.providerOptions?.commitTitle
        ? { commit_title: input.providerOptions.commitTitle }
        : {}),
      ...(input.providerOptions?.commitMessage
        ? { commit_message: input.providerOptions.commitMessage }
        : {}),
    },
    signal: context.signal,
    expected: [200],
  });
  return mapPullRequest(await githubRequest<GitHubPullRequestData>(runtime, path, {
    token: credential.installationToken,
    signal: context.signal,
  }));
}

async function initializeEmptyRepository(
  runtime: GitHubRuntime,
  input: PushRepositoryVersionInput<GitHubPushOptions>,
  credential: GitHubCredentialData,
  strategy: "source" | "placeholder",
  signal?: AbortSignal,
): Promise<string> {
  const first = input.files[0];
  if (!first) {
    throw new GitHubRepositoryError("GitHub cannot initialize an empty repository without a file.", {
      status: 422,
    });
  }
  const path = strategy === "source" ? first.path : ".gitkeep";
  const content = strategy === "source" ? first.content : new Uint8Array();
  const response = await githubRequest<{ readonly commit: { readonly sha: string } }>(
    runtime,
    `${repositoryPath(input.repository)}/contents/${sourcePath(path)}`,
    {
      method: "PUT",
      token: credential.installationToken,
      body: {
        message: "chore: initialize repository",
        content: Buffer.from(content).toString("base64"),
      },
      signal,
      expected: [201],
    },
  );
  return response.commit.sha;
}

async function defaultBranch(
  runtime: GitHubRuntime,
  repository: RepositoryReference,
  credential: GitHubCredentialData,
  signal?: AbortSignal,
): Promise<string> {
  const response = await githubRequest<GitHubRepositoryData>(runtime, repositoryPath(repository), {
    token: credential.installationToken,
    signal,
  });
  return response.default_branch;
}

async function resolveCommit(
  runtime: GitHubRuntime,
  repository: RepositoryReference,
  ref: string,
  credential: GitHubCredentialData,
  signal?: AbortSignal,
): Promise<{ readonly sha: string; readonly tree: string }> {
  const response = await githubRequest<{
    readonly sha: string;
    readonly commit: { readonly tree: { readonly sha: string } };
  }>(runtime, `${repositoryPath(repository)}/commits/${segment(ref)}`, {
    token: credential.installationToken,
    signal,
  });
  return { sha: response.sha, tree: response.commit.tree.sha };
}

async function commitTree(
  runtime: GitHubRuntime,
  repository: RepositoryReference,
  commit: string,
  credential: GitHubCredentialData,
  signal?: AbortSignal,
) {
  const resolved = await resolveCommit(runtime, repository, commit, credential, signal);
  return readTree(runtime, repository, resolved.tree, credential, signal);
}

async function readTree(
  runtime: GitHubRuntime,
  repository: RepositoryReference,
  tree: string,
  credential: GitHubCredentialData,
  signal?: AbortSignal,
) {
  return githubRequest<{
    readonly truncated: boolean;
    readonly tree: readonly {
      readonly path: string;
      readonly mode: string;
      readonly type: string;
      readonly sha: string;
      readonly size?: number;
    }[];
  }>(runtime, `${repositoryPath(repository)}/git/trees/${segment(tree)}?recursive=1`, {
    token: credential.installationToken,
    signal,
  });
}

async function getReference(
  runtime: GitHubRuntime,
  repository: RepositoryReference,
  ref: string,
  credential: GitHubCredentialData,
  signal?: AbortSignal,
): Promise<{ readonly object: { readonly sha: string } } | null> {
  try {
    return await githubRequest(runtime, `${repositoryPath(repository)}/git/ref/${refPath(ref)}`, {
      token: credential.installationToken,
      signal,
    });
  } catch (error) {
    if (error instanceof GitHubRepositoryError && (error.status === 404 || error.status === 409)) {
      return null;
    }
    throw error;
  }
}

function mapRepository(repository: GitHubRepositoryData): RepositoryData {
  const visibility = repository.visibility === "internal"
    ? "internal"
    : repository.private ? "private" : "public";
  return {
    id: String(repository.id),
    owner: repository.owner.login,
    name: repository.name,
    defaultBranch: repository.default_branch,
    visibility,
    url: repository.html_url,
  };
}

function mapPullRequest(pullRequest: GitHubPullRequestData): RepositoryPullRequestData {
  const status = pullRequest.merged || pullRequest.merged_at
    ? "merged"
    : pullRequest.state === "closed"
      ? "closed"
      : pullRequest.draft ? "draft" : "open";
  return {
    id: String(pullRequest.id),
    number: pullRequest.number,
    title: pullRequest.title,
    head: pullRequest.head.ref,
    base: pullRequest.base.ref,
    status,
    url: pullRequest.html_url,
  };
}

function normalizeOptions(options: GitHubRepositoryOptions): GitHubRuntime {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("GitHub repository integration options are required.");
  }
  const appId = requiredString(String(options.appId ?? ""), "GitHub appId");
  const clientId = requiredString(options.clientId, "GitHub clientId");
  const clientSecret = requiredString(options.clientSecret, "GitHub clientSecret");
  const slug = requiredString(options.slug, "GitHub app slug");
  if (!/^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/i.test(slug)) {
    throw new ConfigurationError("GitHub app slug contains unsupported characters.");
  }
  const fetchImplementation = options.fetch ?? globalThis.fetch;
  if (typeof fetchImplementation !== "function") {
    throw new ConfigurationError("GitHub repository integration requires a fetch implementation.");
  }
  let privateKey: KeyObject;
  try {
    const key = typeof options.privateKey === "string"
      ? options.privateKey.replaceAll("\\n", "\n")
      : options.privateKey;
    privateKey = createPrivateKey(key);
  } catch (error) {
    throw new ConfigurationError("GitHub privateKey must be a valid private key.", { cause: error });
  }
  const apiUrl = absoluteUrl(options.apiUrl ?? DEFAULT_API_URL, "GitHub apiUrl");
  const webUrl = absoluteUrl(options.webUrl ?? DEFAULT_WEB_URL, "GitHub webUrl");
  const installationUrl = absoluteUrl(
    options.installationUrl
      ?? `${webUrl}/apps/${encodeURIComponent(slug)}/installations/new`,
    "GitHub installationUrl",
  );
  return {
    appId,
    clientId,
    clientSecret,
    slug,
    apiUrl,
    webUrl,
    installationUrl,
    apiVersion: requiredString(options.apiVersion ?? DEFAULT_API_VERSION, "GitHub apiVersion"),
    fetch: fetchImplementation,
    privateKey,
    maxFiles: boundedInteger(options.source?.maxFiles, DEFAULT_SOURCE_FILES, 1, 100_000, "maxFiles"),
    maxBytes: boundedInteger(options.source?.maxBytes, DEFAULT_SOURCE_BYTES, 1, 1_000_000_000, "maxBytes"),
    concurrency: boundedInteger(options.source?.concurrency, DEFAULT_CONCURRENCY, 1, 32, "concurrency"),
  };
}

async function githubRequest<Result = unknown>(
  runtime: GitHubRuntime,
  path: string,
  options: GitHubRequestOptions = {},
): Promise<Result> {
  const response = await request(runtime, new URL(`${runtime.apiUrl}${path}`), options);
  if (response.status === 204) return undefined as Result;
  return parseJson<Result>(response);
}

async function githubRequestOrNull<Result>(
  runtime: GitHubRuntime,
  path: string,
  options: GitHubRequestOptions,
): Promise<Result | null> {
  try {
    return await githubRequest<Result>(runtime, path, options);
  } catch (error) {
    if (error instanceof GitHubRepositoryError && error.status === 404) return null;
    throw error;
  }
}

async function githubWebRequest<Result>(
  runtime: GitHubRuntime,
  path: string,
  options: { readonly body: unknown; readonly signal?: AbortSignal | undefined },
): Promise<Result> {
  const response = await request(runtime, new URL(`${runtime.webUrl}${path}`), {
    method: "POST",
    body: options.body,
    signal: options.signal,
  });
  return parseJson<Result>(response);
}

async function request(
  runtime: GitHubRuntime,
  url: URL,
  options: GitHubRequestOptions,
): Promise<Response> {
  options.signal?.throwIfAborted();
  const headers = new Headers({
    accept: "application/vnd.github+json",
    "x-github-api-version": runtime.apiVersion,
    "user-agent": "viby-sdk",
  });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.basic) {
    headers.set("authorization", `Basic ${Buffer.from(options.basic).toString("base64")}`);
  }
  if (options.body !== undefined) headers.set("content-type", "application/json");
  let response: Response;
  try {
    response = await runtime.fetch(url, {
      method: options.method ?? (options.body === undefined ? "GET" : "POST"),
      headers,
      ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
      ...(options.signal ? { signal: options.signal } : {}),
      redirect: "error",
    });
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason;
    throw new GitHubRepositoryError("Could not reach the GitHub API.", { cause: error });
  }
  const expected = options.expected ?? [200];
  if (!expected.includes(response.status)) {
    const details = await safeErrorDetails(response);
    throw new GitHubRepositoryError(
      `GitHub API request failed with status ${response.status}${details.message ? `: ${details.message}` : "."}`,
      {
        status: response.status,
        ...(details.documentationUrl ? { documentationUrl: details.documentationUrl } : {}),
      },
    );
  }
  return response;
}

async function safeErrorDetails(response: Response): Promise<{
  readonly message: string;
  readonly documentationUrl?: string;
}> {
  try {
    const body = await response.json() as {
      readonly message?: unknown;
      readonly documentation_url?: unknown;
    };
    const message = typeof body.message === "string" ? body.message.slice(0, 500) : "";
    const documentationUrl = typeof body.documentation_url === "string"
      && body.documentation_url.startsWith("https://docs.github.com/")
      ? body.documentation_url
      : undefined;
    return { message, ...(documentationUrl ? { documentationUrl } : {}) };
  } catch {
    return { message: "" };
  }
}

async function parseJson<Result>(response: Response): Promise<Result> {
  try {
    return await response.json() as Result;
  } catch (error) {
    throw new GitHubRepositoryError("GitHub returned an invalid JSON response.", {
      status: response.status,
      cause: error,
    });
  }
}

function createAppJwt(runtime: GitHubRuntime): string {
  const now = Math.floor(Date.now() / 1_000);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: now - 60, exp: now + 9 * 60, iss: runtime.appId });
  const signingInput = `${header}.${payload}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  return `${signingInput}.${signer.sign(runtime.privateKey).toString("base64url")}`;
}

function encodeCredential(credential: GitHubCredentialData): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(credential));
}

function decodeCredential(value: Uint8Array): GitHubCredentialData {
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(value)) as Partial<GitHubCredentialData>;
    if (parsed.version !== 1 || !Number.isSafeInteger(parsed.installationId)
      || typeof parsed.installationToken !== "string" || !parsed.installationToken
      || typeof parsed.userToken !== "string" || !parsed.userToken) {
      throw new Error("Invalid credential shape");
    }
    return parsed as GitHubCredentialData;
  } catch (error) {
    throw new GitHubRepositoryError("The stored GitHub credential is invalid.", {
      status: 401,
      cause: error,
    });
  }
}

function permissionScopes(permissions: Readonly<Record<string, string>> | undefined): string[] {
  return Object.entries(permissions ?? {})
    .map(([name, access]) => `${name}:${access}`)
    .sort();
}

function credentialExpiry(value: string): Date {
  const expires = new Date(value);
  if (Number.isNaN(expires.getTime())) {
    throw new GitHubRepositoryError("GitHub returned an invalid installation token expiry.");
  }
  return new Date(expires.getTime() - TOKEN_EXPIRY_LEEWAY_MS);
}

function oauthExpiry(seconds: number | undefined): string | null {
  if (seconds === undefined) return null;
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new GitHubRepositoryError("GitHub returned an invalid OAuth token expiry.");
  }
  return new Date(Date.now() + seconds * 1_000 - TOKEN_EXPIRY_LEEWAY_MS).toISOString();
}

function validateSourceFiles(runtime: GitHubRuntime, files: readonly IntegrationSourceFile[]): void {
  if (!Array.isArray(files) || files.length === 0 || files.length > runtime.maxFiles) {
    throw new ConfigurationError(`GitHub pushes require 1-${runtime.maxFiles} source files.`);
  }
  let bytes = 0;
  const paths = new Set<string>();
  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (path !== file.path) {
      throw new ConfigurationError(`GitHub source path must already be normalized: ${file.path}`);
    }
    if (paths.has(path)) throw new ConfigurationError(`Duplicate GitHub source path: ${path}`);
    paths.add(path);
    if (!(file.content instanceof Uint8Array)) {
      throw new ConfigurationError(`GitHub source file ${path} must contain Uint8Array bytes.`);
    }
    bytes += file.content.byteLength;
    if (bytes > runtime.maxBytes) {
      throw new ConfigurationError(`GitHub source exceeds the ${runtime.maxBytes} byte limit.`);
    }
  }
}

function changedFileCount(
  previous: readonly { readonly path: string; readonly sha: string; readonly mode: string; readonly type: string }[],
  next: readonly { readonly path: string; readonly sha: string; readonly mode: string }[],
): number {
  const before = new Map(previous.filter((entry) => entry.type === "blob")
    .map((entry) => [entry.path, `${entry.mode}:${entry.sha}`]));
  const after = new Map(next.map((entry) => [entry.path, `${entry.mode}:${entry.sha}`]));
  return new Set([...before.keys(), ...after.keys()]).size
    - [...before.keys()].filter((path) => before.get(path) === after.get(path)).length;
}

function commitIdentity(value: GitHubCommitIdentity) {
  const name = requiredString(value.name, "GitHub commit identity name");
  const email = requiredString(value.email, "GitHub commit identity email");
  const date = value.date instanceof Date ? value.date.toISOString() : value.date;
  return { name, email, ...(date ? { date: new Date(date).toISOString() } : {}) };
}

function pagination(cursor: string | undefined, limitValue: number | undefined) {
  const limit = boundedInteger(limitValue, 30, 1, 100, "repository page limit");
  if (!cursor) return { page: 1, limit };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { page?: unknown };
    return { page: positiveInteger(parsed.page, "repository page cursor"), limit };
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Repository page cursor is invalid.", { cause: error });
  }
}

function encodePage(page: number): string {
  return Buffer.from(JSON.stringify({ page })).toString("base64url");
}

function repositoryPath(reference: RepositoryReference): string {
  return `/repos/${segment(reference.owner)}/${segment(reference.name)}`;
}

function segment(value: string): string {
  return encodeURIComponent(requiredString(value, "GitHub path value"));
}

function refPath(value: string): string {
  return requiredString(value, "GitHub ref").split("/").map(encodeURIComponent).join("/");
}

function sourcePath(value: string): string {
  return normalizeProjectPath(value).split("/").map(encodeURIComponent).join("/");
}

function requiredQuery(url: URL, name: string): string {
  const value = url.searchParams.get(name)?.trim();
  if (!value) throw new GitHubRepositoryError(`GitHub callback is missing ${name}.`, { status: 400 });
  return value;
}

function requiredString(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ConfigurationError(`${label} is required.`);
  return normalized;
}

function positiveInteger(value: unknown, label: string): number {
  const number = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(number) || (number as number) <= 0) {
    throw new ConfigurationError(`${label} must be a positive integer.`);
  }
  return number as number;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const result = value ?? fallback;
  if (!Number.isSafeInteger(result) || result < minimum || result > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function absoluteUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigurationError(`${label} must be an absolute HTTP(S) URL.`, { cause: error });
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.hash || url.search) {
    throw new ConfigurationError(`${label} must be an absolute HTTP(S) URL without credentials.`);
  }
  return url.href.replace(/\/$/, "");
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  callback: (value: Input, index: number) => Promise<Output>,
): Promise<Output[]> {
  const output = new Array<Output>(values.length);
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, async () => {
    while (index < values.length) {
      const current = index;
      index += 1;
      output[current] = await callback(values[current]!, current);
    }
  }));
  return output;
}
