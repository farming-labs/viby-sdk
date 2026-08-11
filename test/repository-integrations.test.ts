import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { createViby } from "../src/client.js";
import type {
  IntegrationOperationContext,
  IntegrationSourceFile,
  RepositoryData,
  RepositoryIntegration,
  RepositoryPullRequestData,
} from "../src/integrations.js";
import { verifyRepositoryIntegration } from "../src/repository-integration-conformance.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import {
  MemoryIntegrationConnectionStore,
  MemorySecretStore,
} from "./helpers/memory-integration-store.js";

interface FixtureRepository {
  readonly data: RepositoryData;
  readonly branches: Map<string, string>;
  readonly snapshots: Map<string, readonly IntegrationSourceFile[]>;
}

function repositoryFixture() {
  const repositories = new Map<string, FixtureRepository>();
  const pullRequests = new Map<number, RepositoryPullRequestData>();
  let commitNumber = 0;
  let pullRequestNumber = 0;
  const key = (owner: string, name: string) => `${owner}/${name}`;
  const get = (owner: string, name: string) => repositories.get(key(owner, name));
  const cloneFiles = (files: readonly IntegrationSourceFile[]) => files.map((file) => ({
    ...file,
    content: new Uint8Array(file.content),
  }));

  const adapter: RepositoryIntegration = {
    provider: "fixture-git",
    displayName: "Fixture Git",
    connection: {
      async startAuthorization(input) {
        const url = new URL("https://git.example/authorize");
        url.searchParams.set("state", input.state);
        return { url: url.href, expiresAt: null };
      },
      async completeAuthorization() {
        return {
          account: { id: "workspace-1", name: "acme" },
          credential: {
            secret: new TextEncoder().encode("fixture-token"),
            expiresAt: null,
            scopes: ["repository:write"],
          },
        };
      },
    },
    async listOwners(_input, context) {
      assertCredential(context);
      return {
        items: [{ id: "acme", name: "acme", kind: "organization", avatarUrl: null }],
        nextCursor: null,
      };
    },
    async listRepositories(input, context) {
      assertCredential(context);
      const items = [...repositories.values()].map((repository) => repository.data)
        .filter((repository) => !input.owner || repository.owner === input.owner)
        .filter((repository) => !input.search || repository.name.includes(input.search));
      return { items, nextCursor: null };
    },
    async getRepository(input, context) {
      assertCredential(context);
      return get(input.owner, input.name)?.data ?? null;
    },
    async createRepository(input, context) {
      assertCredential(context);
      if (get(input.owner, input.name)) throw new Error("Repository already exists");
      const data: RepositoryData = {
        id: `repository-${repositories.size + 1}`,
        owner: input.owner,
        name: input.name,
        defaultBranch: "main",
        visibility: input.visibility ?? "private",
        url: `https://git.example/${input.owner}/${input.name}`,
      };
      repositories.set(key(input.owner, input.name), {
        data,
        branches: new Map(),
        snapshots: new Map(),
      });
      return data;
    },
    async listBranches(input, context) {
      assertCredential(context);
      const repository = requiredRepository(get(input.repository.owner, input.repository.name));
      return {
        items: [...repository.branches].map(([name, head]) => ({
          name,
          head,
          protected: name === repository.data.defaultBranch,
        })),
        nextCursor: null,
      };
    },
    async getBranch(input, context) {
      assertCredential(context);
      const repository = requiredRepository(get(input.repository.owner, input.repository.name));
      const head = repository.branches.get(input.name);
      return head ? { name: input.name, head, protected: input.name === "main" } : null;
    },
    async createBranch(input, context) {
      assertCredential(context);
      const repository = requiredRepository(get(input.repository.owner, input.repository.name));
      const head = repository.branches.get(input.from) ?? (
        repository.snapshots.has(input.from) ? input.from : null
      );
      if (!head) throw new Error("Branch base does not exist");
      repository.branches.set(input.name, head);
      return { name: input.name, head, protected: false };
    },
    async readSource(input, context) {
      assertCredential(context);
      const repository = requiredRepository(get(input.repository.owner, input.repository.name));
      const commit = "branch" in input.ref
        ? repository.branches.get(input.ref.branch)
        : "commit" in input.ref
          ? input.ref.commit
          : repository.branches.get(input.ref.tag);
      if (!commit) throw new Error("Source ref does not exist");
      const files = repository.snapshots.get(commit);
      if (!files) throw new Error("Source snapshot does not exist");
      return {
        repository: repository.data,
        ref: input.ref,
        commit,
        files: cloneFiles(files),
      };
    },
    async pushVersion(input, context) {
      assertCredential(context);
      const repository = requiredRepository(get(input.repository.owner, input.repository.name));
      let currentHead = repository.branches.get(input.branch) ?? null;
      if (!currentHead && input.createBranch) {
        currentHead = input.baseBranch
          ? repository.branches.get(input.baseBranch) ?? null
          : null;
      } else if (!currentHead) {
        throw new Error("Branch does not exist");
      }
      if (input.expectedHead !== undefined && input.expectedHead !== currentHead) {
        return {
          status: "conflict",
          expectedHead: input.expectedHead,
          actualHead: currentHead ?? "",
        };
      }
      const commit = `commit-${++commitNumber}`;
      repository.branches.set(input.branch, commit);
      repository.snapshots.set(commit, cloneFiles(input.files));
      return {
        status: "pushed",
        commit: {
          id: commit,
          message: input.message,
          branch: input.branch,
          url: `${repository.data.url}/commit/${commit}`,
        },
        changedFiles: input.files.length,
      };
    },
    async createPullRequest(input, context) {
      assertCredential(context);
      const repository = requiredRepository(get(input.repository.owner, input.repository.name));
      if (!repository.branches.has(input.head) || !repository.branches.has(input.base)) {
        throw new Error("Pull request branch does not exist");
      }
      const number = ++pullRequestNumber;
      const pullRequest: RepositoryPullRequestData = {
        id: `pull-request-${number}`,
        number,
        title: input.title,
        head: input.head,
        base: input.base,
        status: input.draft ? "draft" : "open",
        url: `${repository.data.url}/pull/${number}`,
      };
      pullRequests.set(number, pullRequest);
      return pullRequest;
    },
    async mergePullRequest(input, context) {
      assertCredential(context);
      const pullRequest = pullRequests.get(input.number);
      if (!pullRequest) throw new Error("Pull request does not exist");
      const merged = { ...pullRequest, status: "merged" as const };
      pullRequests.set(input.number, merged);
      return merged;
    },
  };

  return { adapter, repositories, pullRequests };
}

test("imports, iterates, pushes immutable versions, opens pull requests, and reports conflicts", async () => {
  const fixture = repositoryFixture();
  const viby = createViby({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    persistence: new MemoryRepository(),
    connectionStore: new MemoryIntegrationConnectionStore(),
    secretStore: new MemorySecretStore(),
    integrations: { repository: { company: fixture.adapter } },
  });
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const repository = user.integrations.repository.use("company");
  const authorization = await repository.connect({
    callbackUrl: "https://app.example/api/integrations/callback",
    returnTo: "/projects/new",
  });
  assert.equal(authorization.status, "authorization-required");
  const state = new URL(authorization.url).searchParams.get("state");
  assert.ok(state);
  await viby.integrations.callback(
    `https://app.example/api/integrations/callback?state=${state}&code=accepted`,
  );

  assert.equal((await user.integrations.repository.list())[0]?.connected, true);
  assert.equal((await repository.owners.list()).items[0]?.name, "acme");

  const seed = await repository.repositories.create({ owner: "acme", name: "seed" });
  await repository.pushSource({
    repository: seed,
    branch: "main",
    createBranch: true,
    message: "feat: seed imported app",
    files: [
      {
        path: "src/index.ts",
        content: new TextEncoder().encode("export const version = 1;\n"),
        mediaType: "text/typescript",
      },
      {
        path: "public/logo.bin",
        content: new Uint8Array([0, 1, 2, 255]),
        mediaType: "application/octet-stream",
      },
    ],
  });
  const imported = await user.chats.import({
    source: repository.source({ repository: seed, ref: { branch: "main" } }),
  });
  const first = await imported.latestVersion();
  assert.ok(first);
  assert.deepEqual((await first.entries()).map((entry) => [entry.path, entry.type]), [
    ["public/logo.bin", "artifact"],
    ["src/index.ts", "text"],
  ]);

  const initialPush = await first.push({
    using: repository,
    repository: { owner: "acme", name: "generated", createIfMissing: true },
    branch: { name: "main", createIfMissing: true },
    commit: { message: "feat: publish generated app" },
  });
  assert.equal(initialPush.status, "pushed");
  assert.equal(initialPush.status === "pushed" && initialPush.changedFiles, 2);

  const second = await first.apply({
    changes: [{
      type: "write",
      path: "src/index.ts",
      content: "export const version = 2;\n",
    }],
  });
  const iterationPush = await second.push({
    using: repository,
    repository: { owner: "acme", name: "generated" },
    branch: { name: "feat/version-two", from: "main", createIfMissing: true },
    commit: { message: "feat: iterate generated app" },
    pullRequest: {
      base: "main",
      title: "feat: iterate generated app",
      draft: true,
    },
  });
  assert.equal(iterationPush.status, "pushed");
  assert.equal(iterationPush.status === "pushed" && iterationPush.pullRequest?.status, "draft");

  const conflict = await second.push({
    using: repository,
    repository: { owner: "acme", name: "generated" },
    branch: "feat/version-two",
    commit: { message: "feat: stale retry", expectedHead: "commit-stale" },
  });
  assert.equal(conflict.status, "conflict");
  assert.notEqual(conflict.status === "conflict" && conflict.actualHead, "commit-stale");
  await viby.close();
});

test("passes the reusable repository adapter conformance suite", async () => {
  const fixture = repositoryFixture();
  const report = await verifyRepositoryIntegration({
    adapter: fixture.adapter,
    context: {
      tenantId: "tenant-conformance",
      userId: "user-conformance",
      connectionId: "connection-conformance",
      externalAccount: { id: "workspace-1", name: "acme" },
      credential: new TextEncoder().encode("fixture-token"),
    },
    owner: "acme",
    repositoryName: "repository-conformance",
  });
  assert.equal(report.provider, "fixture-git");
  assert.deepEqual(report.checks, [
    "list-owners",
    "list-repositories",
    "create-repository",
    "get-repository",
    "initial-push",
    "get-branch",
    "create-branch",
    "list-branches",
    "push-version",
    "read-source",
    "optimistic-conflict",
    "create-pull-request",
    "merge-pull-request",
  ]);
});

function assertCredential(context: IntegrationOperationContext): void {
  assert.equal(new TextDecoder().decode(context.credential), "fixture-token");
  assert.equal(context.externalAccount.id, "workspace-1");
}

function requiredRepository(value: FixtureRepository | undefined): FixtureRepository {
  if (!value) throw new Error("Repository does not exist");
  return value;
}
