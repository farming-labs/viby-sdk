import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import {
  ConfigurationError,
  CredentialReauthorizationRequiredError,
} from "../src/errors.js";
import {
  GitHubRepositoryError,
  github,
  type GitHubRepositoryOptions,
} from "../src/integration-github.js";
import type { IntegrationOperationContext, RepositoryReference } from "../src/integrations.js";

const privateKey = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ format: "pem", type: "pkcs8" }).toString();

interface Route {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly inspect?: (request: Request) => void | Promise<void>;
}

class GitHubFetchFixture {
  readonly routes: Route[] = [];
  readonly calls: Request[] = [];

  add(route: Route): this {
    this.routes.push(route);
    return this;
  }

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    this.calls.push(request);
    const url = new URL(request.url);
    const path = `${url.pathname}${url.search}`;
    const index = this.routes.findIndex((route) => (
      route.method === request.method && route.path === path
    ));
    if (index === -1) {
      return Response.json({ message: `Unexpected ${request.method} ${path}` }, { status: 500 });
    }
    const [route] = this.routes.splice(index, 1);
    await route!.inspect?.(request);
    const status = route!.status ?? 200;
    return status === 204
      ? new Response(null, { status })
      : Response.json(route!.body ?? {}, { status });
  };
}

function options(fetch: typeof globalThis.fetch): GitHubRepositoryOptions {
  return {
    appId: 123,
    clientId: "Iv1.client",
    clientSecret: "client-secret",
    privateKey,
    slug: "viby-test",
    apiUrl: "https://api.github.test/api/v3",
    webUrl: "https://github.test",
    fetch,
  };
}

function repository(owner = "acme", name = "dashboard", id = 1) {
  return {
    id,
    name,
    owner: { id: 9, login: owner, type: "Organization" },
    default_branch: "main",
    visibility: "private",
    private: true,
    html_url: `https://github.test/${owner}/${name}`,
  };
}

function authorizeRoutes(fixture: GitHubFetchFixture, accessible = true): void {
  fixture
    .add({
      method: "POST",
      path: "/login/oauth/access_token",
      body: {
        access_token: "github-user-token",
        expires_in: 28_800,
        refresh_token: "github-refresh-token",
        refresh_token_expires_in: 158_112_000,
      },
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.client_id, "Iv1.client");
        assert.equal(body.client_secret, "client-secret");
        assert.equal(body.redirect_uri, "https://app.example/integrations/callback");
      },
    })
    .add({
      method: "GET",
      path: "/api/v3/user/installations?per_page=100&page=1",
      body: {
        total_count: accessible ? 1 : 0,
        installations: accessible ? [{ id: 42 }] : [],
      },
      inspect(request) {
        assert.equal(request.headers.get("authorization"), "Bearer github-user-token");
      },
    });
  if (!accessible) return;
  fixture
    .add({
      method: "GET",
      path: "/api/v3/app/installations/42",
      body: {
        id: 42,
        target_type: "Organization",
        account: {
          id: 9,
          login: "acme",
          type: "Organization",
          html_url: "https://github.test/acme",
        },
      },
      inspect(request) {
        assert.match(request.headers.get("authorization") ?? "", /^Bearer [^.]+\.[^.]+\.[^.]+$/);
      },
    })
    .add({
      method: "POST",
      path: "/api/v3/app/installations/42/access_tokens",
      status: 201,
      body: {
        token: "github-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: "write", pull_requests: "write" },
      },
    });
}

async function authorize(fixture: GitHubFetchFixture) {
  authorizeRoutes(fixture);
  const adapter = github(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-123",
  }, { tenantId: "tenant", userId: "user" });
  assert.equal(
    started.url,
    "https://github.test/apps/viby-test/installations/new?state=state-123",
  );
  const authorization = await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/integrations/callback?code=oauth-code&installation_id=42&state=state-123",
  }, { tenantId: "tenant", userId: "user" });
  const context: IntegrationOperationContext = {
    tenantId: "tenant",
    userId: "user",
    connectionId: "connection",
    externalAccount: authorization.account,
    credential: authorization.credential.secret,
  };
  return { adapter, authorization, context };
}

test("authorizes a GitHub App installation only after user-access verification", async () => {
  const fixture = new GitHubFetchFixture();
  const { authorization } = await authorize(fixture);
  assert.equal(authorization.account.name, "acme");
  assert.deepEqual(authorization.account.metadata, {
    installationId: "42",
    targetType: "Organization",
  });
  assert.deepEqual(authorization.credential.scopes, ["contents:write", "pull_requests:write"]);
  assert.ok(authorization.credential.expiresAt instanceof Date);
  assert.equal(fixture.routes.length, 0);

  const spoofed = new GitHubFetchFixture();
  authorizeRoutes(spoofed, false);
  const adapter = github(options(spoofed.fetch));
  await assert.rejects(
    () => adapter.connection.completeAuthorization({
      callbackUrl: "https://app.example/integrations/callback?code=oauth-code&installation_id=42",
    }, { tenantId: "tenant", userId: "user" }),
    (error: unknown) => error instanceof GitHubRepositoryError && error.status === 403,
  );
  assert.equal(spoofed.routes.length, 0);
});

test("connects an existing GitHub App installation without reinstalling it", async () => {
  const fixture = new GitHubFetchFixture();
  authorizeRoutes(fixture);
  const adapter = github(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-existing",
    authorization: { account: "existing" },
  }, { tenantId: "tenant", userId: "user" });

  assert.equal(
    started.url,
    "https://github.test/login/oauth/authorize?client_id=Iv1.client&redirect_uri=https%3A%2F%2Fapp.example%2Fintegrations%2Fcallback&state=state-existing",
  );
  const session = started.session;
  assert.ok(session instanceof Uint8Array);

  const authorization = await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/integrations/callback?code=oauth-code&state=state-existing",
    session,
  }, { tenantId: "tenant", userId: "user" });

  assert.equal(authorization.account.id, "42");
  assert.equal(authorization.account.name, "acme");
  assert.equal(fixture.routes.length, 0);
});

test("selects a requested existing GitHub installation after user verification", async () => {
  const fixture = new GitHubFetchFixture()
    .add({
      method: "POST",
      path: "/login/oauth/access_token",
      body: { access_token: "github-user-token" },
    })
    .add({
      method: "GET",
      path: "/api/v3/user/installations?per_page=100&page=1",
      body: { total_count: 2, installations: [{ id: 42 }, { id: 43 }] },
    })
    .add({
      method: "GET",
      path: "/api/v3/app/installations/43",
      body: {
        id: 43,
        target_type: "Organization",
        account: {
          id: 10,
          login: "farming-labs",
          type: "Organization",
          html_url: "https://github.test/farming-labs",
        },
      },
    })
    .add({
      method: "POST",
      path: "/api/v3/app/installations/43/access_tokens",
      status: 201,
      body: {
        token: "github-installation-token",
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        permissions: { contents: "write" },
      },
    });
  const adapter = github(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-selected",
    authorization: { account: "existing", externalAccountId: "43" },
  }, { tenantId: "tenant", userId: "user" });
  const session = started.session;
  assert.ok(session instanceof Uint8Array);
  const authorization = await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/integrations/callback?code=oauth-code&state=state-selected",
    session,
  }, { tenantId: "tenant", userId: "user" });

  assert.equal(authorization.account.id, "43");
  assert.equal(authorization.account.name, "farming-labs");
  assert.equal(fixture.routes.length, 0);
});

test("refreshes installation tokens and revokes both GitHub credentials", async () => {
  const fixture = new GitHubFetchFixture();
  const { adapter, authorization } = await authorize(fixture);
  fixture.add({
    method: "POST",
    path: "/api/v3/app/installations/42/access_tokens",
    status: 201,
    body: {
      token: "github-installation-token-2",
      expires_at: new Date(Date.now() + 3_600_000).toISOString(),
      permissions: { contents: "write" },
    },
  });
  const refreshed = await adapter.connection.refreshCredential!(
    authorization.credential,
    { tenantId: "tenant", userId: "user" },
  );
  assert.deepEqual(refreshed.scopes, ["contents:write"]);
  assert.notDeepEqual(refreshed.secret, authorization.credential.secret);

  fixture
    .add({
      method: "DELETE",
      path: "/api/v3/installation/token",
      status: 204,
    })
    .add({
      method: "DELETE",
      path: "/api/v3/applications/Iv1.client/token",
      status: 204,
      inspect(request) {
        assert.match(request.headers.get("authorization") ?? "", /^Basic /);
      },
    });
  await adapter.connection.revokeCredential!(refreshed, {
    tenantId: "tenant",
    userId: "user",
  });
  assert.equal(fixture.routes.length, 0);
});

test("requires reauthorization when a stored GitHub installation no longer exists", async () => {
  const fixture = new GitHubFetchFixture();
  const { adapter, authorization } = await authorize(fixture);
  fixture.add({
    method: "POST",
    path: "/api/v3/app/installations/42/access_tokens",
    status: 404,
    body: { message: "Not Found" },
  });

  await assert.rejects(
    () => adapter.connection.refreshCredential!(authorization.credential, {
      tenantId: "tenant",
      userId: "user",
    }),
    (error: unknown) => error instanceof CredentialReauthorizationRequiredError
      && error.provider === "github",
  );
  assert.equal(fixture.routes.length, 0);
});

test("maps GitHub repositories, source, Git Data pushes, and pull requests", async () => {
  const fixture = new GitHubFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const target: RepositoryReference = { owner: "acme", name: "dashboard" };

  fixture
    .add({
      method: "GET",
      path: "/api/v3/installation/repositories?per_page=1&page=1",
      body: { total_count: 2, repositories: [repository()] },
    })
    .add({ method: "GET", path: "/api/v3/repos/acme/dashboard", body: repository() })
    .add({
      method: "POST",
      path: "/api/v3/orgs/acme/repos",
      status: 201,
      body: repository("acme", "generated", 2),
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.name, "generated");
        assert.equal(body.private, true);
      },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/branches?per_page=30&page=1",
      body: [{ name: "main", protected: true, commit: { sha: "commit-main" } }],
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/branches/main",
      body: { name: "main", protected: true, commit: { sha: "commit-main" } },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/commits/main",
      body: { sha: "commit-main", commit: { tree: { sha: "tree-main" } } },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/dashboard/git/refs",
      status: 201,
      body: { ref: "refs/heads/feat/new", object: { sha: "commit-main" } },
    })
    .add({ method: "GET", path: "/api/v3/repos/acme/dashboard", body: repository() })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/commits/main",
      body: { sha: "commit-main", commit: { tree: { sha: "tree-main" } } },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/git/trees/tree-main?recursive=1",
      body: {
        truncated: false,
        tree: [
          { path: "src/index.ts", mode: "100644", type: "blob", sha: "blob-text", size: 23 },
          { path: "bin/tool", mode: "100755", type: "blob", sha: "blob-bin", size: 4 },
        ],
      },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/git/blobs/blob-text",
      body: { encoding: "base64", content: Buffer.from("export const app = true;\n").toString("base64") },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/git/blobs/blob-bin",
      body: { encoding: "base64", content: Buffer.from([0, 1, 2, 255]).toString("base64") },
    });

  const repositories = await adapter.listRepositories({ limit: 1 }, context);
  assert.equal(repositories.items[0]?.name, "dashboard");
  assert.ok(repositories.nextCursor);
  assert.equal((await adapter.getRepository(target, context))?.id, "1");
  assert.equal((await adapter.createRepository({
    owner: "acme",
    name: "generated",
    visibility: "private",
  }, context)).name, "generated");
  assert.equal((await adapter.listBranches({ repository: target }, context)).items[0]?.protected, true);
  assert.equal((await adapter.getBranch({ repository: target, name: "main" }, context))?.head, "commit-main");
  assert.equal((await adapter.createBranch({
    repository: target,
    name: "feat/new",
    from: "main",
  }, context)).name, "feat/new");
  const source = await adapter.readSource({ repository: target, ref: { branch: "main" } }, context);
  assert.equal(source.commit, "commit-main");
  assert.deepEqual(source.files.map((file) => [file.path, file.executable ?? false]), [
    ["src/index.ts", false],
    ["bin/tool", true],
  ]);
  assert.deepEqual(source.files[1]?.content, new Uint8Array([0, 1, 2, 255]));

  fixture
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/git/ref/heads/feat/new",
      body: { object: { sha: "commit-main" } },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/dashboard/git/blobs",
      status: 201,
      body: { sha: "blob-old-a" },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/dashboard/git/blobs",
      status: 201,
      body: { sha: "blob-new-b" },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/commits/commit-main",
      body: { sha: "commit-main", commit: { tree: { sha: "tree-old" } } },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/dashboard/git/trees/tree-old?recursive=1",
      body: {
        truncated: false,
        tree: [
          { path: "a.txt", mode: "100644", type: "blob", sha: "blob-old-a", size: 1 },
          { path: "deleted.txt", mode: "100644", type: "blob", sha: "blob-deleted", size: 1 },
        ],
      },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/dashboard/git/trees",
      status: 201,
      body: { sha: "tree-new" },
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal("base_tree" in body, false);
      },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/dashboard/git/commits",
      status: 201,
      body: { sha: "commit-new", html_url: "https://github.test/acme/dashboard/commit/commit-new" },
    })
    .add({
      method: "PATCH",
      path: "/api/v3/repos/acme/dashboard/git/refs/heads/feat/new",
      body: { object: { sha: "commit-new" } },
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.force, false);
      },
    });

  const pushed = await adapter.pushVersion({
    repository: target,
    branch: "feat/new",
    expectedHead: "commit-main",
    message: "feat: update dashboard",
    files: [
      { path: "a.txt", content: new TextEncoder().encode("a") },
      { path: "b.txt", content: new TextEncoder().encode("b") },
    ],
  }, context);
  assert.equal(pushed.status, "pushed");
  assert.equal(pushed.status === "pushed" && pushed.changedFiles, 2);

  fixture
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/dashboard/pulls",
      status: 201,
      body: pullRequest(false),
    })
    .add({ method: "GET", path: "/api/v3/repos/acme/dashboard/pulls/7", body: pullRequest(false) })
    .add({
      method: "PUT",
      path: "/api/v3/repos/acme/dashboard/pulls/7/merge",
      body: { merged: true },
    })
    .add({ method: "GET", path: "/api/v3/repos/acme/dashboard/pulls/7", body: pullRequest(true) });
  const createdPullRequest = await adapter.createPullRequest({
    repository: target,
    head: "feat/new",
    base: "main",
    title: "feat: update dashboard",
    draft: false,
  }, context);
  assert.equal(createdPullRequest.status, "open");
  const merged = await adapter.mergePullRequest!({
    repository: target,
    number: 7,
    expectedHead: "commit-new",
    idempotencyKey: "merge-7",
  }, context);
  assert.equal(merged.status, "merged");
  assert.equal(fixture.routes.length, 0);
});

test("returns conflicts without creating Git objects and validates configuration", async () => {
  const fixture = new GitHubFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture.add({
    method: "GET",
    path: "/api/v3/repos/acme/dashboard/git/ref/heads/main",
    body: { object: { sha: "actual-head" } },
  });
  const result = await adapter.pushVersion({
    repository: { owner: "acme", name: "dashboard" },
    branch: "main",
    expectedHead: "expected-head",
    message: "feat: stale push",
    files: [{ path: "index.ts", content: new TextEncoder().encode("export {};\n") }],
  }, context);
  assert.deepEqual(result, {
    status: "conflict",
    expectedHead: "expected-head",
    actualHead: "actual-head",
  });
  assert.equal(fixture.routes.length, 0);

  assert.throws(() => github({ ...options(fixture.fetch), privateKey: "invalid" }), ConfigurationError);
  assert.throws(() => github({ ...options(fixture.fetch), slug: "bad slug" }), ConfigurationError);
});

test("initializes an empty default branch before pushing a feature branch", async () => {
  const fixture = new GitHubFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/new-app/git/ref/heads/feat/initial",
      status: 409,
      body: { message: "Git Repository is empty." },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/new-app/git/ref/heads/main",
      status: 409,
      body: { message: "Git Repository is empty." },
    })
    .add({ method: "GET", path: "/api/v3/repos/acme/new-app", body: repository("acme", "new-app") })
    .add({
      method: "PUT",
      path: "/api/v3/repos/acme/new-app/contents/.gitkeep",
      status: 201,
      body: { commit: { sha: "bootstrap-commit" } },
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal("branch" in body, false);
        assert.equal(body.content, "");
      },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/new-app/git/blobs",
      status: 201,
      body: { sha: "source-blob" },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/new-app/commits/bootstrap-commit",
      body: { sha: "bootstrap-commit", commit: { tree: { sha: "bootstrap-tree" } } },
    })
    .add({
      method: "GET",
      path: "/api/v3/repos/acme/new-app/git/trees/bootstrap-tree?recursive=1",
      body: {
        truncated: false,
        tree: [{ path: ".gitkeep", mode: "100644", type: "blob", sha: "empty", size: 0 }],
      },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/new-app/git/trees",
      status: 201,
      body: { sha: "source-tree" },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/new-app/git/commits",
      status: 201,
      body: { sha: "source-commit" },
    })
    .add({
      method: "POST",
      path: "/api/v3/repos/acme/new-app/git/refs",
      status: 201,
      body: { ref: "refs/heads/feat/initial", object: { sha: "source-commit" } },
    });
  const result = await adapter.pushVersion({
    repository: { owner: "acme", name: "new-app" },
    branch: "feat/initial",
    baseBranch: "main",
    createBranch: true,
    message: "feat: initialize app",
    files: [{ path: "index.ts", content: new TextEncoder().encode("export {};\n") }],
  }, context);
  assert.equal(result.status, "pushed");
  assert.equal(result.status === "pushed" && result.changedFiles, 2);
  assert.equal(fixture.routes.length, 0);
});

function pullRequest(merged: boolean) {
  return {
    id: 70,
    number: 7,
    title: "feat: update dashboard",
    state: merged ? "closed" : "open",
    draft: false,
    merged,
    merged_at: merged ? new Date().toISOString() : null,
    html_url: "https://github.test/acme/dashboard/pull/7",
    head: { ref: "feat/new", sha: "commit-new" },
    base: { ref: "main" },
  };
}
