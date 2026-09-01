import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import {
  GitLabRepositoryError,
  gitlab,
  type GitLabRepositoryOptions,
} from "../src/integration-gitlab.js";
import { verifyRepositoryIntegration } from "../src/repository-integration-conformance.js";
import type { IntegrationOperationContext } from "../src/integrations.js";

interface Route {
  readonly method: string;
  readonly path: string | RegExp;
  readonly status?: number;
  readonly body?: unknown | (() => unknown);
  readonly bytes?: Uint8Array | (() => Uint8Array);
  readonly headers?: Readonly<Record<string, string>>;
  readonly inspect?: (request: Request) => void | Promise<void>;
}

class GitLabFetchFixture {
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
      route.method === request.method && (
        typeof route.path === "string" ? route.path === path : route.path.test(path)
      )
    ));
    if (index === -1) {
      return Response.json({ message: `Unexpected ${request.method} ${path}` }, { status: 500 });
    }
    const [route] = this.routes.splice(index, 1);
    await route!.inspect?.(request);
    const status = route!.status ?? 200;
    const headers = new Headers(route!.headers);
    if (route!.bytes) {
      const bytes = typeof route!.bytes === "function" ? route!.bytes() : route!.bytes;
      headers.set("content-type", "application/octet-stream");
      return new Response(new Uint8Array(bytes).buffer, { status, headers });
    }
    if (status === 204) return new Response(null, { status, headers });
    const body = typeof route!.body === "function" ? route!.body() : route!.body;
    return Response.json(body ?? {}, { status, headers });
  };
}

function options(fetch: typeof globalThis.fetch): GitLabRepositoryOptions {
  return {
    clientId: "oauth-client",
    clientSecret: "oauth-secret",
    baseUrl: "https://gitlab.test",
    fetch,
  };
}

function project(name = "repository-conformance") {
  return {
    id: 17,
    path: name,
    name,
    path_with_namespace: `acme/${name}`,
    default_branch: "main",
    visibility: "private",
    web_url: `https://gitlab.test/acme/${name}`,
    namespace: { id: 8, full_path: "acme", kind: "group" },
  };
}

function branch(name: string, head: string) {
  return {
    name,
    protected: name === "main",
    commit: { id: head, message: `commit on ${name}`, web_url: `https://gitlab.test/commit/${head}` },
  };
}

function mergeRequest(state = "opened", sha = "commit-2") {
  return {
    id: 70,
    iid: 7,
    title: "Draft: test: repository integration conformance",
    source_branch: "viby/conformance",
    target_branch: "main",
    state,
    draft: state === "opened",
    sha,
    merged_at: state === "merged" ? "2026-09-02T00:00:00Z" : null,
    web_url: "https://gitlab.test/acme/repository-conformance/-/merge_requests/7",
  };
}

function authorizationRoutes(fixture: GitLabFetchFixture): void {
  fixture
    .add({
      method: "POST",
      path: "/oauth/token",
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 7200,
        scope: "api",
      },
      async inspect(request) {
        const form = new URLSearchParams(await request.text());
        assert.equal(form.get("client_id"), "oauth-client");
        assert.equal(form.get("client_secret"), "oauth-secret");
        assert.equal(form.get("code"), "oauth-code");
        assert.equal(form.get("redirect_uri"), "https://app.example/integrations/callback");
      },
    })
    .add({
      method: "GET",
      path: "/api/v4/user",
      body: {
        id: 42,
        username: "ada",
        name: "Ada Lovelace",
        web_url: "https://gitlab.test/ada",
        avatar_url: "https://gitlab.test/ada/avatar.png",
      },
    });
}

async function authorize(fixture: GitLabFetchFixture) {
  authorizationRoutes(fixture);
  const adapter = gitlab(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-123",
  }, { tenantId: "tenant", userId: "user" });
  assert.ok(started.session);
  const authorization = await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/integrations/callback?code=oauth-code&state=state-123",
    session: started.session,
  }, { tenantId: "tenant", userId: "user" });
  const context: IntegrationOperationContext = {
    tenantId: "tenant",
    userId: "user",
    connectionId: "connection",
    externalAccount: authorization.account,
    credential: authorization.credential.secret,
  };
  return { adapter, started, authorization, context };
}

test("authorizes, refreshes, and revokes a GitLab OAuth connection", async () => {
  const fixture = new GitLabFetchFixture();
  const { adapter, started, authorization } = await authorize(fixture);
  const url = new URL(started.url);
  assert.equal(url.origin + url.pathname, "https://gitlab.test/oauth/authorize");
  assert.equal(url.searchParams.get("client_id"), "oauth-client");
  assert.equal(url.searchParams.get("redirect_uri"), "https://app.example/integrations/callback");
  assert.equal(url.searchParams.get("scope"), "api");
  assert.deepEqual(authorization.account, {
    id: "42",
    name: "Ada Lovelace",
    url: "https://gitlab.test/ada",
    metadata: {
      username: "ada",
      avatarUrl: "https://gitlab.test/ada/avatar.png",
      instance: "https://gitlab.test",
    },
  });
  assert.ok(authorization.credential.expiresAt instanceof Date);

  fixture.add({
    method: "POST",
    path: "/oauth/token",
    body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 },
    async inspect(request) {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("grant_type"), "refresh_token");
      assert.equal(form.get("refresh_token"), "refresh-1");
    },
  });
  const refreshed = await adapter.connection.refreshCredential!(authorization.credential, {
    tenantId: "tenant",
    userId: "user",
  });
  assert.notDeepEqual(refreshed.secret, authorization.credential.secret);

  fixture.add({
    method: "POST",
    path: "/oauth/revoke",
    body: {},
    async inspect(request) {
      const form = new URLSearchParams(await request.text());
      assert.equal(form.get("token"), "access-2");
      assert.equal(form.get("client_secret"), "oauth-secret");
    },
  });
  await adapter.connection.revokeCredential!(refreshed, { tenantId: "tenant", userId: "user" });
  assert.equal(fixture.routes.length, 0);
});

test("passes the reusable repository conformance suite through GitLab", async () => {
  const fixture = new GitLabFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const readme = new TextEncoder().encode("# Viby repository integration conformance\n");
  const iteration = new TextEncoder().encode("Repository iteration conformance fixture.\n");
  let iterationPath = "";

  fixture
    .add({
      method: "GET",
      path: "/api/v4/namespaces?owned_only=true&per_page=20&page=1",
      body: [{ id: 8, name: "Acme", path: "acme", full_path: "acme", kind: "group" }],
    })
    .add({
      method: "GET",
      path: "/api/v4/projects?membership=true&simple=true&order_by=id&sort=asc&per_page=20&page=1",
      body: [],
    })
    .add({
      method: "GET",
      path: "/api/v4/namespaces/acme",
      body: { id: 8, full_path: "acme", kind: "group" },
    })
    .add({
      method: "POST",
      path: "/api/v4/projects",
      status: 201,
      body: project(),
      async inspect(request) {
        assert.deepEqual(await request.json(), {
          name: "repository-conformance",
          path: "repository-conformance",
          namespace_id: 8,
          visibility: "private",
        });
      },
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance",
      body: project(),
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches/main",
      status: 404,
      body: { message: "404 Branch Not Found" },
    })
    .add({
      method: "POST",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/commits",
      status: 201,
      body: { id: "commit-1", message: "test: initialize repository conformance fixture" },
      async inspect(request) {
        const body = await request.json() as { branch: string; actions: Array<Record<string, unknown>> };
        assert.equal(body.branch, "main");
        assert.equal(body.actions[0]?.action, "create");
        assert.equal(body.actions[0]?.content, Buffer.from(readme).toString("base64"));
      },
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches/main",
      body: branch("main", "commit-1"),
    })
    .add({
      method: "POST",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches",
      status: 201,
      body: branch("viby/conformance", "commit-1"),
      async inspect(request) {
        assert.deepEqual(await request.json(), { branch: "viby/conformance", ref: "commit-1" });
      },
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches?per_page=20&page=1",
      body: [branch("main", "commit-1"), branch("viby/conformance", "commit-1")],
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches/viby%2Fconformance",
      body: branch("viby/conformance", "commit-1"),
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/tree?recursive=true&ref=commit-1&per_page=100&page=1",
      body: [{ id: "blob-readme-1", path: "README.md", type: "blob", mode: "100644" }],
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/blobs/blob-readme-1/raw",
      bytes: readme,
    })
    .add({
      method: "POST",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/commits",
      status: 201,
      body: { id: "commit-2", message: "feat: verify immutable source pushes" },
      async inspect(request) {
        const body = await request.json() as { branch: string; actions: Array<Record<string, unknown>> };
        assert.equal(body.branch, "viby/conformance");
        const created = body.actions.find((action) => action.action === "create");
        iterationPath = String(created?.file_path ?? "");
        assert.match(iterationPath, /^\.viby\/conformance-/);
        assert.equal(created?.content, Buffer.from(iteration).toString("base64"));
      },
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance",
      body: project(),
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches/viby%2Fconformance",
      body: branch("viby/conformance", "commit-2"),
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/tree?recursive=true&ref=commit-2&per_page=100&page=1",
      body: () => [
        { id: "blob-readme-2", path: "README.md", type: "blob", mode: "100644" },
        { id: "blob-iteration", path: iterationPath, type: "blob", mode: "100644" },
      ],
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/blobs/blob-readme-2/raw",
      bytes: readme,
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/blobs/blob-iteration/raw",
      bytes: iteration,
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/repository/branches/viby%2Fconformance",
      body: branch("viby/conformance", "commit-2"),
    })
    .add({
      method: "POST",
      path: "/api/v4/projects/acme%2Frepository-conformance/merge_requests",
      status: 201,
      body: mergeRequest(),
    })
    .add({
      method: "GET",
      path: "/api/v4/projects/acme%2Frepository-conformance/merge_requests/7",
      body: mergeRequest(),
    })
    .add({
      method: "PUT",
      path: "/api/v4/projects/acme%2Frepository-conformance/merge_requests/7/merge",
      body: mergeRequest("merged"),
      async inspect(request) {
        assert.equal(request.headers.get("idempotency-key")?.length, 36);
        assert.equal((await request.json() as { sha: string }).sha, "commit-2");
      },
    });

  const report = await verifyRepositoryIntegration({
    adapter,
    context,
    owner: "acme",
    repositoryName: "repository-conformance",
  });
  assert.equal(report.provider, "gitlab");
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
  assert.equal(fixture.routes.length, 0);
});

test("enforces GitLab instance and source safety boundaries", async () => {
  assert.throws(
    () => gitlab({
      clientId: "client",
      clientSecret: "secret",
      baseUrl: "https://gitlab.test",
      apiUrl: "https://api.attacker.test/v4",
    }),
    /configured GitLab origin/,
  );
  assert.throws(
    () => gitlab({ clientId: "", clientSecret: "secret" }),
    ConfigurationError,
  );

  const fixture = new GitLabFetchFixture();
  const { adapter, context } = await authorize(fixture);
  await assert.rejects(
    () => adapter.listOwners({ cursor: Buffer.from("https://attacker.test/api/v4/namespaces").toString("base64url") }, context),
    /configured GitLab origin/,
  );
  await assert.rejects(
    () => adapter.pushVersion({
      repository: { owner: "acme", name: "dashboard" },
      branch: "main",
      createBranch: true,
      message: "unsafe",
      files: [{ path: "../secret", content: new Uint8Array([1]) }],
    }, context),
    /path is unsafe/,
  );
  assert.equal(fixture.routes.length, 0);
});

test("maps GitLab errors and rejects portable rebase merge requests", async () => {
  const fixture = new GitLabFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture.add({
    method: "GET",
    path: "/api/v4/projects/acme%2Fmissing",
    status: 404,
    body: { message: "404 Project Not Found" },
  });
  assert.equal(await adapter.getRepository({ owner: "acme", name: "missing" }, context), null);
  await assert.rejects(
    () => adapter.mergePullRequest!({
      repository: { owner: "acme", name: "dashboard" },
      number: 1,
      method: "rebase",
      idempotencyKey: "merge-1",
    }, context),
    ConfigurationError,
  );
  const error = new GitLabRepositoryError("failed", { status: 409, code: "conflict" });
  assert.equal(error.status, 409);
  assert.equal(error.code, "conflict");
  assert.equal(fixture.routes.length, 0);
});
