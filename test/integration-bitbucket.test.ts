import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import {
  BitbucketRepositoryError,
  bitbucket,
  type BitbucketRepositoryOptions,
} from "../src/integration-bitbucket.js";
import type { IntegrationOperationContext, RepositoryReference } from "../src/integrations.js";

interface Route {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly bytes?: Uint8Array;
  readonly inspect?: (request: Request) => void | Promise<void>;
}

class BitbucketFetchFixture {
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
      return Response.json({ error: { message: `Unexpected ${request.method} ${path}` } }, { status: 500 });
    }
    const [route] = this.routes.splice(index, 1);
    await route!.inspect?.(request);
    const status = route!.status ?? 200;
    if (route!.bytes) return new Response(new Uint8Array(route!.bytes).buffer, {
      status,
      headers: { "content-type": "application/octet-stream" },
    });
    if (status === 204) return new Response(null, { status });
    return Response.json(route!.body ?? {}, { status });
  };
}

function options(fetch: typeof globalThis.fetch): BitbucketRepositoryOptions {
  return {
    clientId: "oauth-client",
    clientSecret: "oauth-secret",
    apiUrl: "https://bitbucket.test/2.0",
    authorizationUrl: "https://bitbucket.test/site/oauth2/authorize",
    tokenUrl: "https://bitbucket.test/site/oauth2/access_token",
    fetch,
  };
}

function repository(owner = "acme", name = "dashboard", id = "repo-1") {
  return {
    uuid: `{${id}}`,
    slug: name,
    name,
    full_name: `${owner}/${name}`,
    is_private: true,
    mainbranch: { name: "main" },
    workspace: { uuid: "{workspace-1}", slug: owner, name: "Acme" },
    links: { html: { href: `https://bitbucket.test/${owner}/${name}` } },
  };
}

function branch(name: string, hash: string) {
  return { name, target: { hash, message: `commit on ${name}` } };
}

function pullRequest(state = "OPEN") {
  return {
    id: 7,
    title: "feat: dashboard",
    state,
    draft: false,
    source: { branch: { name: "feat/dashboard" }, commit: { hash: "head-2" } },
    destination: { branch: { name: "main" } },
    links: { html: { href: "https://bitbucket.test/acme/dashboard/pull-requests/7" } },
  };
}

function authorizeRoutes(fixture: BitbucketFetchFixture): void {
  fixture
    .add({
      method: "POST",
      path: "/site/oauth2/access_token",
      body: {
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 7200,
        scopes: "account repository repository:write pullrequest:write",
      },
      async inspect(request) {
        assert.equal(
          request.headers.get("authorization"),
          `Basic ${Buffer.from("oauth-client:oauth-secret").toString("base64")}`,
        );
        assert.equal(await request.text(), "grant_type=authorization_code&code=oauth-code");
      },
    })
    .add({
      method: "GET",
      path: "/2.0/user",
      body: {
        uuid: "{user-1}",
        nickname: "ada",
        display_name: "Ada",
        links: {
          html: { href: "https://bitbucket.test/ada" },
          avatar: { href: "https://bitbucket.test/ada/avatar" },
        },
      },
    });
}

async function authorize(fixture: BitbucketFetchFixture) {
  authorizeRoutes(fixture);
  const adapter = bitbucket(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-123",
  }, { tenantId: "tenant", userId: "user" });
  const authorization = await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/integrations/callback?code=oauth-code&state=state-123",
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

test("authorizes and refreshes a Bitbucket OAuth consumer connection", async () => {
  const fixture = new BitbucketFetchFixture();
  const { adapter, started, authorization } = await authorize(fixture);
  const authorizationUrl = new URL(started.url);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, "https://bitbucket.test/site/oauth2/authorize");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "oauth-client");
  assert.equal(authorizationUrl.searchParams.get("state"), "state-123");
  assert.match(authorizationUrl.searchParams.get("scope") ?? "", /repository:write/);
  assert.deepEqual(authorization.account, {
    id: "{user-1}",
    name: "Ada",
    url: "https://bitbucket.test/ada",
    metadata: { nickname: "ada", avatarUrl: "https://bitbucket.test/ada/avatar" },
  });
  assert.deepEqual(authorization.credential.scopes, [
    "account", "repository", "repository:write", "pullrequest:write",
  ]);
  assert.ok(authorization.credential.expiresAt instanceof Date);
  assert.equal(adapter.connection.revokeCredential, undefined);

  fixture.add({
    method: "POST",
    path: "/site/oauth2/access_token",
    body: { access_token: "access-2", refresh_token: "refresh-2", expires_in: 7200 },
    async inspect(request) {
      assert.equal(await request.text(), "grant_type=refresh_token&refresh_token=refresh-1");
    },
  });
  const refreshed = await adapter.connection.refreshCredential!(authorization.credential, {
    tenantId: "tenant",
    userId: "user",
  });
  assert.notDeepEqual(refreshed.secret, authorization.credential.secret);
  assert.equal(fixture.routes.length, 0);
});

test("discovers Bitbucket workspaces, repositories, and branches with opaque cursors", async () => {
  const fixture = new BitbucketFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture
    .add({
      method: "GET",
      path: "/2.0/user/workspaces?pagelen=1",
      body: {
        values: [{ workspace: { uuid: "{workspace-1}", slug: "acme", name: "Acme" } }],
        next: "https://bitbucket.test/2.0/user/workspaces?pagelen=1&page=2",
      },
    });
  const firstOwners = await adapter.listOwners({ limit: 1 }, context);
  assert.equal(firstOwners.items[0]?.name, "acme");
  assert.equal(firstOwners.items[0]?.kind, "workspace");
  assert.ok(firstOwners.nextCursor);
  fixture.add({
    method: "GET",
    path: "/2.0/user/workspaces?pagelen=1&page=2",
    body: { values: [] },
  });
  assert.equal((await adapter.listOwners({ cursor: firstOwners.nextCursor! }, context)).items.length, 0);

  fixture
    .add({
      method: "GET",
      path: "/2.0/user/workspaces?pagelen=100",
      body: { values: [{ workspace: { uuid: "{workspace-1}", slug: "acme", name: "Acme" } }] },
    })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme?pagelen=100",
      body: { values: [repository(), repository("acme", "second", "repo-2")] },
    })
    .add({
      method: "GET",
      path: "/2.0/user/workspaces?pagelen=100",
      body: { values: [{ workspace: { uuid: "{workspace-1}", slug: "acme", name: "Acme" } }] },
    })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme?pagelen=100",
      body: { values: [repository(), repository("acme", "second", "repo-2")] },
    })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard", body: repository() })
    .add({
      method: "POST",
      path: "/2.0/repositories/acme/generated",
      status: 201,
      body: repository("acme", "generated", "repo-2"),
      async inspect(request) {
        assert.deepEqual(await request.json(), {
          scm: "git",
          name: "generated",
          is_private: true,
          description: "Generated by Viby",
          mainbranch: { name: "main" },
        });
      },
    })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme/dashboard/refs/branches?pagelen=1",
      body: { values: [branch("main", "head-1")] },
    })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme/dashboard/refs/branches/main",
      body: branch("main", "head-1"),
    })
    .add({
      method: "POST",
      path: "/2.0/repositories/acme/dashboard/refs/branches",
      status: 201,
      body: branch("feat/dashboard", "head-1"),
      async inspect(request) {
        assert.deepEqual(await request.json(), { name: "feat/dashboard", target: { hash: "head-1" } });
      },
    });

  const firstRepositories = await adapter.listRepositories({ owner: "acme", limit: 1 }, context);
  assert.equal(firstRepositories.items[0]?.name, "dashboard");
  assert.ok(firstRepositories.nextCursor);
  const secondRepositories = await adapter.listRepositories({
    owner: "acme",
    limit: 1,
    cursor: firstRepositories.nextCursor!,
  }, context);
  assert.equal(secondRepositories.items[0]?.name, "second");
  assert.equal((await adapter.getRepository({ owner: "acme", name: "dashboard" }, context))?.defaultBranch, "main");
  assert.equal((await adapter.createRepository({
    owner: "acme", name: "generated", description: "Generated by Viby", visibility: "private",
  }, context)).name, "generated");
  const target: RepositoryReference = { owner: "acme", name: "dashboard" };
  assert.equal((await adapter.listBranches({ repository: target, limit: 1 }, context)).items[0]?.head, "head-1");
  assert.equal((await adapter.getBranch({ repository: target, name: "main" }, context))?.head, "head-1");
  assert.equal((await adapter.createBranch({ repository: target, name: "feat/dashboard", from: "head-1" }, context)).name, "feat/dashboard");
  assert.equal(fixture.routes.length, 0);
});

test("reads source and pushes exact binary-safe snapshots through Bitbucket's source API", async () => {
  const fixture = new BitbucketFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const target: RepositoryReference = { owner: "acme", name: "dashboard" };
  const binary = new Uint8Array([0, 1, 2, 255]);
  fixture
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard", body: repository() })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/refs/branches/main", body: branch("main", "head-1") })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme/dashboard/src/head-1/?pagelen=100",
      body: {
        values: [
          { type: "commit_directory", path: "src", size: 0, attributes: [] },
          { type: "commit_file", path: "old.txt", size: 3, attributes: [] },
          { type: "commit_file", path: "bin/tool", size: 4, attributes: ["executable"] },
        ],
      },
    })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme/dashboard/src/head-1/src/?pagelen=100",
      body: { values: [{ type: "commit_file", path: "src/index.ts", size: 23, attributes: [] }] },
    })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/src/head-1/old.txt", bytes: Buffer.from("old") })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/src/head-1/bin/tool", bytes: binary })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/src/head-1/src/index.ts", bytes: Buffer.from("export const app = true;\n") });

  const source = await adapter.readSource({ repository: target, ref: { branch: "main" } }, context);
  assert.equal(source.commit, "head-1");
  assert.deepEqual(source.files.map((file) => [file.path, file.executable ?? false]), [
    ["old.txt", false], ["bin/tool", true], ["src/index.ts", false],
  ]);
  assert.deepEqual(source.files.find((file) => file.path === "bin/tool")?.content, binary);
  const updatedBinary = new Uint8Array([0, 1, 3, 255]);

  fixture
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/refs/branches/main", body: branch("main", "head-1") })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme/dashboard/src/head-1/?pagelen=100",
      body: {
        values: [
          { type: "commit_file", path: "old.txt", size: 3, attributes: [] },
          { type: "commit_file", path: "bin/tool", size: 4, attributes: ["executable"] },
        ],
      },
    })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/src/head-1/old.txt", bytes: Buffer.from("old") })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/src/head-1/bin/tool", bytes: binary })
    .add({
      method: "POST",
      path: "/2.0/repositories/acme/dashboard/src",
      status: 201,
      body: {
        hash: "head-2",
        message: "feat: update dashboard",
        links: { html: { href: "https://bitbucket.test/acme/dashboard/commits/head-2" } },
      },
      async inspect(request) {
        const contentType = request.headers.get("content-type") ?? "";
        assert.match(contentType, /^multipart\/form-data; boundary=viby-/);
        const raw = Buffer.from(await request.arrayBuffer());
        const text = raw.toString("latin1");
        assert.match(text, /name="branch"\r\n\r\nmain/);
        assert.match(text, /name="parents"\r\n\r\nhead-1/);
        assert.match(text, /name="files"\r\n\r\nold\.txt/);
        assert.match(text, /name="\/bin\/tool"; filename="tool"; x-attributes="executable"/);
        assert.match(text, /name="\/src\/index\.ts"; filename="index\.ts"/);
        assert.ok(raw.includes(Buffer.from(updatedBinary)));
      },
    });
  const pushed = await adapter.pushVersion({
    repository: target,
    branch: "main",
    expectedHead: "head-1",
    message: "feat: update dashboard",
    files: [
      { path: "bin/tool", content: updatedBinary, executable: true },
      { path: "src/index.ts", content: Buffer.from("export const app = true;\n") },
    ],
  }, context);
  assert.equal(pushed.status, "pushed");
  if (pushed.status === "pushed") {
    assert.equal(pushed.commit.id, "head-2");
    assert.equal(pushed.changedFiles, 3);
  }
  assert.equal(fixture.routes.length, 0);
});

test("returns typed push conflicts and creates and idempotently merges pull requests", async () => {
  const fixture = new BitbucketFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const target: RepositoryReference = { owner: "acme", name: "dashboard" };
  fixture.add({
    method: "GET",
    path: "/2.0/repositories/acme/dashboard/refs/branches/main",
    body: branch("main", "actual-head"),
  });
  assert.deepEqual(await adapter.pushVersion({
    repository: target,
    branch: "main",
    expectedHead: "expected-head",
    message: "feat: stale",
    files: [{ path: "index.ts", content: Buffer.from("export {}") }],
  }, context), {
    status: "conflict",
    expectedHead: "expected-head",
    actualHead: "actual-head",
  });

  fixture
    .add({
      method: "POST",
      path: "/2.0/repositories/acme/dashboard/pullrequests",
      status: 201,
      body: pullRequest(),
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.title, "feat: dashboard");
        assert.deepEqual(body.reviewers, [{ uuid: "{reviewer-1}" }]);
      },
    })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/pullrequests/7", body: pullRequest() })
    .add({
      method: "POST",
      path: "/2.0/repositories/acme/dashboard/pullrequests/7/merge?async=false",
      status: 202,
      body: {},
      async inspect(request) {
        assert.equal(request.headers.get("x-viby-idempotency-key"), "merge-7");
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.merge_strategy, "squash");
      },
    })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/pullrequests/7", body: pullRequest("MERGED") })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/pullrequests/7", body: pullRequest("MERGED") });

  const created = await adapter.createPullRequest({
    repository: target,
    head: "feat/dashboard",
    base: "main",
    title: "feat: dashboard",
    providerOptions: { reviewers: ["{reviewer-1}"] },
  }, context);
  assert.equal(created.number, 7);
  const merged = await adapter.mergePullRequest!({
    repository: target,
    number: 7,
    method: "squash",
    expectedHead: "head-2",
    idempotencyKey: "merge-7",
  }, context);
  assert.equal(merged.status, "merged");
  const retried = await adapter.mergePullRequest!({
    repository: target,
    number: 7,
    idempotencyKey: "merge-7",
  }, context);
  assert.equal(retried.status, "merged");
  assert.equal(fixture.routes.length, 0);
});

test("rejects unsupported visibility, unsafe cursors, links, and subrepositories", async () => {
  const fixture = new BitbucketFetchFixture();
  const { adapter, context } = await authorize(fixture);
  await assert.rejects(
    () => adapter.createRepository({ owner: "acme", name: "internal", visibility: "internal" }, context),
    ConfigurationError,
  );
  const cursor = Buffer.from(JSON.stringify({
    version: 1,
    url: "https://attacker.example/2.0/user/workspaces?page=2",
  })).toString("base64url");
  await assert.rejects(() => adapter.listOwners({ cursor }, context), ConfigurationError);

  const target: RepositoryReference = { owner: "acme", name: "dashboard" };
  fixture
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard", body: repository() })
    .add({ method: "GET", path: "/2.0/repositories/acme/dashboard/refs/branches/main", body: branch("main", "head-1") })
    .add({
      method: "GET",
      path: "/2.0/repositories/acme/dashboard/src/head-1/?pagelen=100",
      body: { values: [{ type: "commit_file", path: "link", size: 3, attributes: ["link"] }] },
    });
  await assert.rejects(
    () => adapter.readSource({ repository: target, ref: { branch: "main" } }, context),
    (error: unknown) => error instanceof BitbucketRepositoryError && /symbolic links/.test(error.message),
  );
  assert.equal(fixture.routes.length, 0);
});
