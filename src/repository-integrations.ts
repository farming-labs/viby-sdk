import {
  ConfigurationError,
  IntegrationOperationError,
  NotFoundError,
} from "./errors.js";
import type {
  ConnectIntegrationInput,
  ConnectIntegrationResult,
  DisconnectIntegrationResult,
  IntegrationClient,
} from "./integration-client.js";
import type {
  CreateRepositoryBranchInput,
  CreateRepositoryInput,
  CreateRepositoryPullRequestInput,
  GetRepositoryBranchInput,
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
} from "./integrations.js";
import type { AdapterProjectImportInput, SourceImportAdapter } from "./source-import.js";
import type { ImportProjectSource, SourceEntryInput, UserScope } from "./types.js";
import { assertIdentifier } from "./utils.js";

export interface RepositoryIntegrationHandleOptions {
  readonly connectionId?: string;
}

export interface RepositoryImportInput extends ReadRepositorySourceInput {}

export type RepositoryImportSource = AdapterProjectImportInput<RepositoryImportInput>["source"];

export interface PushVersionRepositoryInput<PushOptions = never, PullRequestOptions = never> {
  readonly using: RepositoryIntegrationHandle<PushOptions, PullRequestOptions, any>;
  readonly repository: RepositoryReference & {
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
    readonly providerOptions?: PullRequestOptions;
  };
  readonly providerOptions?: PushOptions;
  readonly signal?: AbortSignal;
}

export type PushVersionRepositoryResult =
  | {
      readonly status: "conflict";
      readonly repository: RepositoryData;
      readonly expectedHead: string | null;
      readonly actualHead: string;
    }
  | {
      readonly status: "pushed";
      readonly repository: RepositoryData;
      readonly commit: RepositoryCommitData;
      readonly changedFiles: number;
      readonly pullRequest: RepositoryPullRequestData | null;
    };

export class ScopedRepositoryIntegrations {
  readonly #client: IntegrationClient;
  readonly #scope: UserScope;

  constructor(client: IntegrationClient, scope: UserScope) {
    this.#client = client;
    this.#scope = scope;
  }

  list() {
    return this.#client.statuses(this.#scope, "repository");
  }

  connections(integrationId?: string) {
    return this.#client.connections(this.#scope, "repository", integrationId);
  }

  connect(integrationId: string, input: ConnectIntegrationInput): Promise<ConnectIntegrationResult> {
    return this.#client.connect(this.#scope, "repository", integrationId, input);
  }

  disconnect(
    integrationId: string,
    options: { readonly connectionId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<DisconnectIntegrationResult> {
    return this.#client.disconnect(
      this.#scope,
      "repository",
      integrationId,
      options.connectionId,
      options.signal,
    );
  }

  use(
    integrationId: string,
    options: RepositoryIntegrationHandleOptions = {},
  ): RepositoryIntegrationHandle<any, any, any> {
    return new RepositoryIntegrationHandle(
      this.#client,
      this.#scope,
      assertIdentifier(integrationId, "Repository integration id"),
      options.connectionId,
    );
  }
}

export class RepositoryIntegrationHandle<
  PushOptions = never,
  PullRequestOptions = never,
  MergeOptions = never,
> {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly owners: RepositoryOwnerOperations;
  readonly repositories: RepositoryOperations;
  readonly branches: RepositoryBranchOperations;
  readonly pullRequests: RepositoryPullRequestOperations<PullRequestOptions, MergeOptions>;
  readonly #client: IntegrationClient;
  readonly #scope: UserScope;
  readonly #adapter: RepositoryIntegration<PushOptions, PullRequestOptions, MergeOptions>;
  readonly #connectionId: string | undefined;

  constructor(
    client: IntegrationClient,
    scope: UserScope,
    integrationId: string,
    connectionId?: string,
  ) {
    this.#client = client;
    this.#scope = scope;
    this.id = integrationId;
    this.#adapter = client.repositoryAdapter(integrationId) as RepositoryIntegration<
      PushOptions,
      PullRequestOptions,
      MergeOptions
    >;
    this.provider = this.#adapter.provider;
    this.displayName = this.#adapter.displayName;
    this.#connectionId = connectionId;
    this.owners = new RepositoryOwnerOperations(this);
    this.repositories = new RepositoryOperations(this);
    this.branches = new RepositoryBranchOperations(this);
    this.pullRequests = new RepositoryPullRequestOperations(this);
  }

  connect(input: ConnectIntegrationInput): Promise<ConnectIntegrationResult> {
    return this.#client.connect(this.#scope, "repository", this.id, input);
  }

  disconnect(options: { readonly signal?: AbortSignal } = {}): Promise<DisconnectIntegrationResult> {
    return this.#client.disconnect(
      this.#scope,
      "repository",
      this.id,
      this.#connectionId,
      options.signal,
    );
  }

  source(input: RepositoryImportInput): RepositoryImportSource {
    const adapter: SourceImportAdapter<RepositoryImportInput> = {
      name: `repository-${this.id}`,
      import: async (sourceInput, context) => {
        if (context.tenantId !== this.#scope.tenantId || context.userId !== this.#scope.userId) {
          throw new ConfigurationError("Repository import handle belongs to another user scope.");
        }
        const source = await this.readSource(sourceInput, context.signal);
        return {
          title: source.repository.name,
          summary: `Imported ${source.repository.owner}/${source.repository.name} at ${source.commit}.`,
          source: repositoryImportSource(source.files),
        };
      },
    };
    return { type: "adapter", adapter, input };
  }

  async readSource(
    input: ReadRepositorySourceInput,
    signal?: AbortSignal,
  ): Promise<RepositorySourceData> {
    return this.#run("read source", signal, (context) => this.#adapter.readSource(input, context));
  }

  async pushSource(
    input: PushRepositoryVersionInput<PushOptions>,
    signal?: AbortSignal,
  ): Promise<PushRepositoryVersionResult> {
    return this.#run("push version", signal, (context) => this.#adapter.pushVersion(input, context));
  }

  async operationContext(signal?: AbortSignal): Promise<IntegrationOperationContext> {
    return this.#client.operationContext(
      this.#scope,
      "repository",
      this.id,
      this.#connectionId,
      signal,
    );
  }

  async run<Result>(
    operation: string,
    signal: AbortSignal | undefined,
    callback: (adapter: RepositoryIntegration<PushOptions, PullRequestOptions, MergeOptions>, context: IntegrationOperationContext) => Promise<Result>,
  ): Promise<Result> {
    return this.#run(operation, signal, (context) => callback(this.#adapter, context));
  }

  async #run<Result>(
    operation: string,
    signal: AbortSignal | undefined,
    callback: (context: IntegrationOperationContext) => Promise<Result>,
  ): Promise<Result> {
    signal?.throwIfAborted();
    const context = await this.operationContext(signal);
    try {
      const result = await callback(context);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ConfigurationError || error instanceof NotFoundError) throw error;
      throw new IntegrationOperationError("repository", this.provider, operation, { cause: error });
    }
  }
}

export class RepositoryOwnerOperations {
  readonly #handle: RepositoryIntegrationHandle<any, any, any>;
  constructor(handle: RepositoryIntegrationHandle<any, any, any>) { this.#handle = handle; }

  list(input: ListRepositoryOwnersInput = {}, signal?: AbortSignal): Promise<IntegrationPage<RepositoryOwnerData>> {
    return this.#handle.run("list owners", signal, (adapter, context) => adapter.listOwners(input, context));
  }
}

export class RepositoryOperations {
  readonly #handle: RepositoryIntegrationHandle<any, any, any>;
  constructor(handle: RepositoryIntegrationHandle<any, any, any>) { this.#handle = handle; }

  list(input: ListRepositoriesInput = {}, signal?: AbortSignal): Promise<IntegrationPage<RepositoryData>> {
    return this.#handle.run("list repositories", signal, (adapter, context) => adapter.listRepositories(input, context));
  }

  get(input: RepositoryReference, signal?: AbortSignal): Promise<RepositoryData | null> {
    return this.#handle.run("get repository", signal, (adapter, context) => adapter.getRepository(input, context));
  }

  create(input: CreateRepositoryInput, signal?: AbortSignal): Promise<RepositoryData> {
    return this.#handle.run("create repository", signal, (adapter, context) => adapter.createRepository(input, context));
  }
}

export class RepositoryBranchOperations {
  readonly #handle: RepositoryIntegrationHandle<any, any, any>;
  constructor(handle: RepositoryIntegrationHandle<any, any, any>) { this.#handle = handle; }

  list(input: ListRepositoryBranchesInput, signal?: AbortSignal): Promise<IntegrationPage<RepositoryBranchData>> {
    return this.#handle.run("list branches", signal, (adapter, context) => adapter.listBranches(input, context));
  }

  get(input: GetRepositoryBranchInput, signal?: AbortSignal): Promise<RepositoryBranchData | null> {
    return this.#handle.run("get branch", signal, (adapter, context) => adapter.getBranch(input, context));
  }

  create(input: CreateRepositoryBranchInput, signal?: AbortSignal): Promise<RepositoryBranchData> {
    return this.#handle.run("create branch", signal, (adapter, context) => adapter.createBranch(input, context));
  }
}

export class RepositoryPullRequestOperations<PullRequestOptions = never, MergeOptions = never> {
  readonly #handle: RepositoryIntegrationHandle<any, PullRequestOptions, MergeOptions>;
  constructor(handle: RepositoryIntegrationHandle<any, PullRequestOptions, MergeOptions>) {
    this.#handle = handle;
  }

  create(
    input: CreateRepositoryPullRequestInput<PullRequestOptions>,
    signal?: AbortSignal,
  ): Promise<RepositoryPullRequestData> {
    return this.#handle.run("create pull request", signal, (adapter, context) => (
      adapter.createPullRequest(input, context)
    ));
  }

  merge(
    input: MergeRepositoryPullRequestInput<MergeOptions>,
    signal?: AbortSignal,
  ): Promise<RepositoryPullRequestData> {
    return this.#handle.run("merge pull request", signal, (adapter, context) => {
      if (!adapter.mergePullRequest) {
        throw new ConfigurationError(`${adapter.displayName} does not support pull-request merging.`);
      }
      return adapter.mergePullRequest(input, context);
    });
  }
}

export async function pushVersionSource<PushOptions, PullRequestOptions>(
  files: readonly IntegrationSourceFile[],
  input: PushVersionRepositoryInput<PushOptions, PullRequestOptions>,
): Promise<PushVersionRepositoryResult> {
  const repository = await ensureRepository(input);
  const branch = typeof input.branch === "string" ? { name: input.branch } : input.branch;
  const pushed = await input.using.pushSource({
    repository,
    branch: branch.name,
    ...(branch.from ? { baseBranch: branch.from } : {}),
    ...(branch.createIfMissing !== undefined ? { createBranch: branch.createIfMissing } : {}),
    ...(input.commit.expectedHead ? { expectedHead: input.commit.expectedHead } : {}),
    message: normalizeCommitMessage(input.commit.message),
    files,
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
  }, input.signal);
  if (pushed.status === "conflict") return { ...pushed, repository };
  const pullRequest = input.pullRequest
    ? await input.using.pullRequests.create({
        repository,
        head: branch.name,
        base: input.pullRequest.base,
        title: input.pullRequest.title,
        ...(input.pullRequest.body !== undefined ? { body: input.pullRequest.body } : {}),
        ...(input.pullRequest.draft !== undefined ? { draft: input.pullRequest.draft } : {}),
        ...(input.pullRequest.providerOptions !== undefined
          ? { providerOptions: input.pullRequest.providerOptions }
          : {}),
      }, input.signal)
    : null;
  return {
    status: "pushed",
    repository,
    commit: pushed.commit,
    changedFiles: pushed.changedFiles,
    pullRequest,
  };
}

async function ensureRepository<PushOptions, PullRequestOptions>(
  input: PushVersionRepositoryInput<PushOptions, PullRequestOptions>,
): Promise<RepositoryData> {
  const existing = await input.using.repositories.get(input.repository, input.signal);
  if (existing) return existing;
  if (!input.repository.createIfMissing) throw new NotFoundError("Remote repository");
  return input.using.repositories.create({
    owner: input.repository.owner,
    name: input.repository.name,
    ...(input.repository.description !== undefined ? { description: input.repository.description } : {}),
    ...(input.repository.visibility !== undefined ? { visibility: input.repository.visibility } : {}),
  }, input.signal);
}

function repositoryImportSource(files: readonly IntegrationSourceFile[]): ImportProjectSource {
  const entries: SourceEntryInput[] = files.map((file) => {
    const bytes = new Uint8Array(file.content);
    const text = decodeTextFile(bytes, file.mediaType);
    return text === null
      ? {
          type: "artifact" as const,
          path: file.path,
          bytes,
          ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        }
      : {
          type: "text" as const,
          path: file.path,
          content: text,
          ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        };
  });
  return { type: "files", files: entries };
}

function decodeTextFile(bytes: Uint8Array, mediaType: string | undefined): string | null {
  if (mediaType && !mediaType.startsWith("text/")
    && !/^(application\/(json|javascript|typescript|xml|yaml|toml))\b/.test(mediaType)) {
    return null;
  }
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.includes("\0") ? null : text;
  } catch {
    return null;
  }
}

function normalizeCommitMessage(value: string): string {
  const message = typeof value === "string" ? value.trim() : "";
  if (message.length === 0 || message.length > 10_000) {
    throw new ConfigurationError("Repository commit message must contain 1-10,000 characters.");
  }
  return message;
}
