import { randomUUID } from "node:crypto";
import { ConfigurationError } from "./errors.js";
import type {
  IntegrationOperationContext,
  IntegrationSourceFile,
  RepositoryIntegration,
  RepositoryReference,
} from "./integrations.js";

export interface VerifyRepositoryIntegrationInput {
  readonly adapter: RepositoryIntegration<any, any, any>;
  readonly context: IntegrationOperationContext;
  /** Provider owner or workspace where the disposable conformance repository is created. */
  readonly owner: string;
  readonly repositoryName?: string;
  readonly branchName?: string;
  readonly files?: readonly IntegrationSourceFile[];
}

export interface RepositoryIntegrationConformanceReport {
  readonly provider: string;
  readonly repository: RepositoryReference;
  readonly checks: readonly string[];
}

export class RepositoryIntegrationConformanceError extends Error {
  readonly check: string;

  constructor(check: string, message: string, options?: ErrorOptions) {
    super(`Repository integration conformance failed at ${check}: ${message}`, options);
    this.name = "RepositoryIntegrationConformanceError";
    this.check = check;
  }
}

/**
 * Exercises the provider-neutral repository contract against a disposable repository.
 * The caller owns provider credentials and cleanup of the created repository.
 */
export async function verifyRepositoryIntegration(
  input: VerifyRepositoryIntegrationInput,
): Promise<RepositoryIntegrationConformanceReport> {
  if (!input || typeof input !== "object" || !input.adapter) {
    throw new ConfigurationError("Repository integration conformance input is required.");
  }
  const adapter = input.adapter;
  const owner = requiredValue(input.owner, "Repository conformance owner");
  const repositoryName = input.repositoryName?.trim()
    || `viby-conformance-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const featureBranch = input.branchName?.trim() || "viby/conformance";
  const files = input.files ?? [{
    path: "README.md",
    content: new TextEncoder().encode("# Viby repository integration conformance\n"),
    mediaType: "text/markdown",
  }];
  if (files.length === 0) {
    throw new ConfigurationError("Repository integration conformance requires at least one file.");
  }
  const iterationFiles = [...files, {
    path: `.viby/conformance-${randomUUID().slice(0, 8)}.txt`,
    content: new TextEncoder().encode("Repository iteration conformance fixture.\n"),
    mediaType: "text/plain",
  }];
  const checks: string[] = [];

  const owners = await run("list-owners", () => adapter.listOwners({}, input.context));
  assertPage(owners, "list-owners");
  checks.push("list-owners");

  const repositories = await run("list-repositories", () => (
    adapter.listRepositories({ owner }, input.context)
  ));
  assertPage(repositories, "list-repositories");
  checks.push("list-repositories");

  const created = await run("create-repository", () => adapter.createRepository({
    owner,
    name: repositoryName,
    visibility: "private",
  }, input.context));
  assert(created.owner === owner && created.name === repositoryName,
    "create-repository", "the created repository identity changed");
  const repository = { owner: created.owner, name: created.name };
  checks.push("create-repository");

  const loaded = await run("get-repository", () => adapter.getRepository(repository, input.context));
  assert(loaded?.id === created.id, "get-repository", "the created repository was not readable");
  checks.push("get-repository");

  const initial = await run("initial-push", () => adapter.pushVersion({
    repository,
    branch: created.defaultBranch,
    createBranch: true,
    message: "test: initialize repository conformance fixture",
    files,
  }, input.context));
  assert(initial.status === "pushed", "initial-push", "the initial source snapshot conflicted");
  if (initial.status !== "pushed") throw new RepositoryIntegrationConformanceError(
    "initial-push",
    "the initial source snapshot conflicted",
  );
  checks.push("initial-push");

  const defaultBranch = await run("get-branch", () => adapter.getBranch({
    repository,
    name: created.defaultBranch,
  }, input.context));
  assert(defaultBranch?.head === initial.commit.id,
    "get-branch", "the default branch does not point to the initial commit");
  checks.push("get-branch");

  const branch = await run("create-branch", () => adapter.createBranch({
    repository,
    name: featureBranch,
    from: initial.commit.id,
  }, input.context));
  assert(branch.name === featureBranch && branch.head === initial.commit.id,
    "create-branch", "the feature branch does not point to its requested base");
  checks.push("create-branch");

  const branches = await run("list-branches", () => adapter.listBranches({ repository }, input.context));
  assertPage(branches, "list-branches");
  assert(branches.items.some((item) => item.name === featureBranch),
    "list-branches", "the feature branch was not listed");
  checks.push("list-branches");

  const pushed = await run("push-version", () => adapter.pushVersion({
    repository,
    branch: featureBranch,
    expectedHead: initial.commit.id,
    message: "feat: verify immutable source pushes",
    files: iterationFiles,
  }, input.context));
  assert(pushed.status === "pushed", "push-version", "the feature source snapshot conflicted");
  if (pushed.status !== "pushed") throw new RepositoryIntegrationConformanceError(
    "push-version",
    "the feature source snapshot conflicted",
  );
  checks.push("push-version");

  const source = await run("read-source", () => adapter.readSource({
    repository,
    ref: { branch: featureBranch },
  }, input.context));
  assert(source.commit === pushed.commit.id, "read-source", "source resolved to the wrong commit");
  assert(source.files.length === iterationFiles.length,
    "read-source", "source snapshot changed its file count");
  checks.push("read-source");

  const conflict = await run("optimistic-conflict", () => adapter.pushVersion({
    repository,
    branch: featureBranch,
    expectedHead: initial.commit.id,
    message: "test: reject a stale repository write",
    files: iterationFiles,
  }, input.context));
  assert(conflict.status === "conflict" && conflict.actualHead === pushed.commit.id,
    "optimistic-conflict", "a stale expected head did not produce a conflict");
  checks.push("optimistic-conflict");

  const pullRequest = await run("create-pull-request", () => adapter.createPullRequest({
    repository,
    head: featureBranch,
    base: created.defaultBranch,
    title: "test: repository integration conformance",
    draft: true,
  }, input.context));
  assert(pullRequest.head === featureBranch && pullRequest.base === created.defaultBranch,
    "create-pull-request", "the pull request changed its head or base");
  checks.push("create-pull-request");

  if (adapter.mergePullRequest) {
    const merged = await run("merge-pull-request", () => adapter.mergePullRequest!({
      repository,
      number: pullRequest.number,
      expectedHead: pushed.commit.id,
      idempotencyKey: randomUUID(),
    }, input.context));
    assert(merged.status === "merged", "merge-pull-request", "the pull request was not merged");
    checks.push("merge-pull-request");
  }

  return Object.freeze({
    provider: adapter.provider,
    repository: Object.freeze(repository),
    checks: Object.freeze(checks),
  });
}

async function run<Result>(check: string, operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof RepositoryIntegrationConformanceError) throw error;
    throw new RepositoryIntegrationConformanceError(check, "the provider operation failed", {
      cause: error,
    });
  }
}

function assertPage(value: unknown, check: string): asserts value is {
  readonly items: readonly unknown[];
  readonly nextCursor: string | null;
} {
  assert(Boolean(value) && Array.isArray((value as { items?: unknown }).items)
    && ((value as { nextCursor?: unknown }).nextCursor === null
      || typeof (value as { nextCursor?: unknown }).nextCursor === "string"),
  check, "the provider returned an invalid page");
}

function assert(condition: boolean, check: string, message: string): asserts condition {
  if (!condition) throw new RepositoryIntegrationConformanceError(check, message);
}

function requiredValue(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new ConfigurationError(`${label} is required.`);
  return normalized;
}
