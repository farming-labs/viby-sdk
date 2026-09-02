import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { unzipSync } from "fflate";
import { ConfigurationError } from "../src/errors.js";
import { verifyDeploymentIntegration } from "../src/deployment-integration-conformance.js";
import {
  NetlifyDeploymentError,
  netlify,
  netlifyAccounts,
  netlifyDeployment,
  type NetlifyDeploymentOptions,
} from "../src/integration-netlify.js";
import type { IntegrationOperationContext } from "../src/integrations.js";

interface Route {
  readonly method: string;
  readonly path: string | RegExp;
  readonly status?: number;
  readonly body?: unknown;
  readonly inspect?: (request: Request) => void | Promise<void>;
}

class NetlifyFetchFixture {
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
    const index = this.routes.findIndex((route) => route.method === request.method
      && (typeof route.path === "string" ? route.path === path : route.path.test(path)));
    if (index === -1) {
      return Response.json({ message: `Unexpected ${request.method} ${path}` }, { status: 500 });
    }
    const [route] = this.routes.splice(index, 1);
    await route!.inspect?.(request);
    const status = route!.status ?? 200;
    return status === 204 ? new Response(null, { status }) : Response.json(route!.body ?? {}, { status });
  };
}

function options(fetch: typeof globalThis.fetch): NetlifyDeploymentOptions {
  return {
    clientId: "netlify-client",
    clientSecret: "netlify-secret",
    apiUrl: "https://api.netlify.test/api/v1",
    authorizationUrl: "https://app.netlify.test/authorize",
    tokenUrl: "https://api.netlify.test/oauth/token",
    fetch,
    source: { concurrency: 1 },
    pollIntervalMs: 1,
  };
}

function authorizationRoutes(fixture: NetlifyFetchFixture): void {
  fixture
    .add({
      method: "POST",
      path: "/oauth/token",
      body: { access_token: "netlify-access-token", token_type: "bearer" },
      async inspect(request) {
        assert.equal(request.headers.get("content-type"), "application/x-www-form-urlencoded");
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), "oauth-code");
        assert.equal(body.get("client_id"), "netlify-client");
        assert.equal(body.get("client_secret"), "netlify-secret");
        assert.equal(body.get("redirect_uri"), "https://app.example/integrations/callback");
      },
    })
    .add({
      method: "GET",
      path: "/api/v1/user",
      body: { id: "user-1", full_name: "Ada Lovelace", email: "ada@example.com" },
      inspect(request) {
        assert.equal(request.headers.get("authorization"), "Bearer netlify-access-token");
      },
    })
    .add({
      method: "GET",
      path: "/api/v1/accounts",
      body: [
        { id: "account-1", name: "Acme", slug: "acme" },
        { id: "account-2", name: "Labs", slug: "labs" },
      ],
    });
}

async function authorize(fixture: NetlifyFetchFixture) {
  authorizationRoutes(fixture);
  const adapter = netlify(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-123",
  }, { tenantId: "tenant", userId: "user" });
  const authorizationUrl = new URL(started.url);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, "https://app.netlify.test/authorize");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "netlify-client");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://app.example/integrations/callback");
  assert.equal(authorizationUrl.searchParams.get("state"), "state-123");

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
  return { adapter, authorization, context };
}

test("authorizes a Netlify user and persists only opaque account choices", async () => {
  const fixture = new NetlifyFetchFixture();
  const { adapter, authorization } = await authorize(fixture);
  assert.equal(netlifyDeployment, netlify);
  assert.deepEqual(authorization.account, {
    id: "user-1",
    name: "Ada Lovelace",
    metadata: {
      email: "ada@example.com",
      accounts: [
        { id: "account-1", name: "Acme", slug: "acme" },
        { id: "account-2", name: "Labs", slug: "labs" },
      ],
    },
  });
  assert.deepEqual(netlifyAccounts(authorization.account), [
    { id: "account-1", name: "Acme", slug: "acme" },
    { id: "account-2", name: "Labs", slug: "labs" },
  ]);
  assert.equal(authorization.credential.expiresAt, null);
  assert.deepEqual(authorization.credential.scopes, []);
  assert.equal(adapter.source?.mode, "prebuilt");
  assert.equal(fixture.routes.length, 0);
});

test("surfaces Netlify OAuth and provider errors without exposing credentials", async () => {
  const fixture = new NetlifyFetchFixture();
  const adapter = netlify(options(fixture.fetch));
  await assert.rejects(
    () => adapter.connection.completeAuthorization({
      callbackUrl: "https://app.example/callback?error=access_denied&error_description=Nope",
    }, { tenantId: "tenant", userId: "user" }),
    (error: unknown) => error instanceof NetlifyDeploymentError
      && error.code === "access_denied"
      && error.message === "Nope",
  );
  fixture.add({
    method: "GET",
    path: "/api/v1/sites/missing",
    status: 401,
    body: { code: "unauthorized", message: "Invalid bearer token" },
  });
  const context: IntegrationOperationContext = {
    tenantId: "tenant",
    userId: "user",
    connectionId: "connection",
    externalAccount: { id: "user", name: "User" },
    credential: new TextEncoder().encode(JSON.stringify({ version: 1, accessToken: "secret-token" })),
  };
  await assert.rejects(
    () => adapter.getProject({ id: "missing" }, context),
    (error: unknown) => error instanceof NetlifyDeploymentError
      && error.status === 401
      && error.code === "unauthorized"
      && !error.message.includes("secret-token"),
  );
});

test("lists, gets, and creates Netlify sites with explicit team selection", async () => {
  const fixture = new NetlifyFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture.add({
    method: "GET",
    path: "/api/v1/sites?name=dash&filter=all&page=2&per_page=1",
    body: [{ id: "site-1", name: "dashboard", ssl_url: "https://dashboard.netlify.app" }],
  });
  assert.deepEqual(await adapter.listProjects({ search: "dash", cursor: "2", limit: 1 }, context), {
    items: [{ id: "site-1", name: "dashboard", url: "https://dashboard.netlify.app" }],
    nextCursor: "3",
  });

  fixture
    .add({
      method: "GET",
      path: "/api/v1/sites/site-1",
      body: { id: "site-1", name: "dashboard", ssl_url: "https://dashboard.netlify.app" },
    })
    .add({
      method: "GET",
      path: "/api/v1/sites?name=missing&filter=all&page=1&per_page=100",
      body: [],
    });
  assert.equal((await adapter.getProject({ id: "site-1" }, context))?.name, "dashboard");
  assert.equal(await adapter.getProject({ name: "missing" }, context), null);

  await assert.rejects(
    () => adapter.createProject({ name: "farm-dashboard" }, context),
    /providerOptions\.accountSlug/,
  );
  fixture.add({
    method: "POST",
    path: "/api/v1/acme/sites",
    status: 201,
    body: { id: "site-2", name: "farm-dashboard", ssl_url: "https://farm-dashboard.netlify.app" },
    async inspect(request) {
      assert.deepEqual(await request.json(), { name: "farm-dashboard" });
    },
  });
  assert.equal((await adapter.createProject({
    name: "farm-dashboard",
    providerOptions: { accountSlug: "acme" },
  }, context)).id, "site-2");
  assert.equal(fixture.routes.length, 0);
});

test("deploys static assets and a Farm.js server bundle through Netlify digest uploads", async () => {
  const fixture = new NetlifyFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const html = new TextEncoder().encode("<!doctype html><title>Viby</title>");
  const server = new TextEncoder().encode("export default async () => new Response('ok')\n");
  const manifest = new TextEncoder().encode('{"type":"module"}\n');
  let marker = "";
  let functionHash = "";
  fixture.add({
    method: "GET",
    path: "/api/v1/sites/site-1/deploys?page=1&per_page=100",
    body: [],
  });
  fixture.routes.push({
    method: "POST",
    path: /^\/api\/v1\/sites\/site-1\/deploys\?title=viby%3A[a-f0-9]{32}$/,
    status: 201,
    get body() {
      return {
        id: "deploy-1",
        site_id: "site-1",
        state: "prepared",
        deploy_ssl_url: "https://deploy-1--dashboard.netlify.app",
        required: [sha1(html)],
        required_functions: [functionHash],
        created_at: "2026-09-02T12:00:00.000Z",
        title: marker,
      };
    },
    async inspect(request) {
      const url = new URL(request.url);
      marker = url.searchParams.get("title")!;
      assert.match(marker, /^viby:[a-f0-9]{32}$/);
      const body = await request.json() as Record<string, any>;
      functionHash = String(body.functions.server);
      assert.deepEqual(body.files, { "index.html": sha1(html) });
      assert.equal(body.draft, true);
      assert.equal(body.async, true);
      assert.equal(body.branch, "feat/dashboard");
      assert.equal(body.framework, "farmjs");
      assert.deepEqual(body.environment, [{
        key: "API_TOKEN",
        value: "runtime-secret",
        is_secret: true,
        scopes: ["functions"],
      }]);
      assert.deepEqual(body.functions_config.server, {
        display_name: "Farm.js server",
        generator: "farmjs",
        routes: [{ pattern: "/*", prefer_static: true }],
        excluded_routes: [{ pattern: "/.netlify/*" }],
      });
    },
  });
  fixture.add({
    method: "PUT",
    path: `/api/v1/deploys/deploy-1/files/index.html?size=${html.byteLength}`,
    status: 201,
    async inspect(request) {
      assert.equal(request.headers.get("content-type"), "application/octet-stream");
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), html);
    },
  });
  fixture.routes.push({
    method: "PUT",
    path: /^\/api\/v1\/deploys\/deploy-1\/functions\/server\?runtime=js&invocation_mode=stream&size=\d+$/,
    status: 201,
    async inspect(request) {
      const archive = new Uint8Array(await request.arrayBuffer());
      assert.equal(Number(new URL(request.url).searchParams.get("size")), archive.byteLength);
      assert.equal(sha1(archive), functionHash);
      const files = unzipSync(archive);
      assert.deepEqual(files["server.mjs"], server);
      assert.deepEqual(files["package.json"], manifest);
    },
  });

  const deployment = await adapter.deployVersion({
    project: "site-1",
    environment: "preview",
    idempotencyKey: "deploy-1",
    environmentVariables: { API_TOKEN: "runtime-secret" },
    files: [
      { path: ".output/public/index.html", content: html, mediaType: "text/html" },
      { path: ".output/server/server.mjs", content: server, mediaType: "application/javascript" },
      { path: ".output/server/package.json", content: manifest, mediaType: "application/json" },
    ],
    providerOptions: {
      publishDirectory: ".output/public",
      branch: "feat/dashboard",
      framework: "farmjs",
      functions: [{
        name: "server",
        directory: ".output/server",
        invocationMode: "stream",
        config: {
          displayName: "Farm.js server",
          generator: "farmjs",
          routes: [{ pattern: "/*", preferStatic: true }],
          excludedRoutes: [{ pattern: "/.netlify/*" }],
        },
      }],
    },
  }, context);
  assert.match(deployment.id, /^nfd\./);
  assert.equal(deployment.projectId, "site-1");
  assert.equal(deployment.environment, "preview");
  assert.equal(deployment.status, "building");
  assert.equal(deployment.url, "https://deploy-1--dashboard.netlify.app");
  assert.equal(fixture.routes.length, 0);
});

test("reuses deploys by a hashed idempotency marker, refreshes status, and cancels safely", async () => {
  const fixture = new NetlifyFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const marker = `viby:${createHash("sha256").update("same-effect").digest("hex").slice(0, 32)}`;
  const response = {
    id: "deploy-2",
    site_id: "site-1",
    state: "ready",
    deploy_ssl_url: "https://deploy-2--dashboard.netlify.app",
    created_at: "2026-09-02T12:00:00.000Z",
    title: marker,
  };
  fixture.add({
    method: "GET",
    path: "/api/v1/sites/site-1/deploys?page=1&per_page=100",
    body: [response],
  });
  const deployment = await adapter.deployVersion({
    project: "site-1",
    environment: "production",
    idempotencyKey: "same-effect",
    files: [{ path: "dist/index.html", content: new TextEncoder().encode("ok") }],
    providerOptions: { publishDirectory: "dist" },
  }, context);
  assert.equal(deployment.status, "ready");
  assert.equal(deployment.environment, "production");

  fixture
    .add({
      method: "GET",
      path: "/api/v1/sites/site-1/deploys/deploy-2",
      body: { ...response, state: "uploading" },
    })
    .add({
      method: "GET",
      path: "/api/v1/sites/site-1/deploys/deploy-2",
      body: { ...response, state: "uploading" },
    })
    .add({
      method: "POST",
      path: "/api/v1/deploys/deploy-2/cancel",
      status: 201,
      body: { ...response, state: "error" },
    });
  assert.equal((await adapter.getDeployment({ id: deployment.id }, context))?.status, "building");
  assert.equal((await adapter.cancelDeployment!({
    id: deployment.id,
    idempotencyKey: "cancel-1",
  }, context)).status, "cancelled");
  assert.equal(fixture.routes.length, 0);
});

test("passes the provider-neutral deployment integration conformance workflow", async () => {
  const fixture = new NetlifyFetchFixture();
  const adapter = netlify(options(fixture.fetch));
  const context: IntegrationOperationContext = {
    tenantId: "tenant",
    userId: "user",
    connectionId: "connection",
    externalAccount: {
      id: "user",
      name: "User",
      metadata: { accounts: [{ id: "account-1", name: "Acme", slug: "acme" }] },
    },
    credential: new TextEncoder().encode(JSON.stringify({ version: 1, accessToken: "token" })),
  };
  const html = new TextEncoder().encode("<!doctype html><title>Viby conformance</title>");
  const fileHash = sha1(html);
  let projectName = "";
  let marker = "";
  const deployResponse = (state: string) => ({
    id: "deploy-conformance",
    site_id: "site-conformance",
    state,
    deploy_ssl_url: "https://deploy-conformance--viby.netlify.app",
    created_at: "2026-09-02T12:00:00.000Z",
    title: marker,
  });
  fixture
    .add({
      method: "GET",
      path: "/api/v1/sites?filter=all&page=1&per_page=50",
      body: [],
    })
    .add({
      method: "POST",
      path: "/api/v1/acme/sites",
      status: 201,
      get body() {
        return { id: "site-conformance", name: projectName };
      },
      async inspect(request) {
        projectName = String((await request.json() as Record<string, unknown>).name);
      },
    })
    .add({
      method: "GET",
      path: "/api/v1/sites/site-conformance",
      get body() {
        return { id: "site-conformance", name: projectName };
      },
    })
    .add({
      method: "GET",
      path: "/api/v1/sites/site-conformance/deploys?page=1&per_page=100",
      body: [],
    });
  fixture.routes.push({
    method: "POST",
    path: /^\/api\/v1\/sites\/site-conformance\/deploys\?title=viby%3A[a-f0-9]{32}$/,
    status: 201,
    get body() {
      return { ...deployResponse("prepared"), required: [fileHash], required_functions: [] };
    },
    inspect(request) {
      marker = new URL(request.url).searchParams.get("title")!;
    },
  });
  fixture
    .add({
      method: "PUT",
      path: `/api/v1/deploys/deploy-conformance/files/index.html?size=${html.byteLength}`,
      status: 201,
    })
    .add({
      method: "GET",
      path: "/api/v1/sites/site-conformance/deploys?page=1&per_page=100",
      get body() {
        return [deployResponse("uploading")];
      },
    })
    .add({
      method: "GET",
      path: "/api/v1/sites/site-conformance/deploys/deploy-conformance",
      get body() {
        return deployResponse("uploading");
      },
    })
    .add({
      method: "GET",
      path: "/api/v1/sites/site-conformance/deploys/deploy-conformance",
      get body() {
        return deployResponse("uploading");
      },
    })
    .add({
      method: "POST",
      path: "/api/v1/deploys/deploy-conformance/cancel",
      status: 201,
      get body() {
        return deployResponse("error");
      },
    });

  const report = await verifyDeploymentIntegration({ adapter, context });
  assert.equal(report.provider, "netlify");
  assert.deepEqual(report.checks, [
    "list-projects",
    "create-project",
    "get-project",
    "deploy-version",
    "deployment-idempotency",
    "get-deployment",
    "cancel-deployment",
  ]);
  assert.equal(fixture.routes.length, 0);
});

test("rejects unsafe, empty, and oversized Netlify prepared output", async () => {
  const adapter = netlify({
    ...options(async () => Response.json([])),
    source: { maxFileBytes: 2 },
  });
  const context: IntegrationOperationContext = {
    tenantId: "tenant",
    userId: "user",
    connectionId: "connection",
    externalAccount: { id: "user", name: "User" },
    credential: new TextEncoder().encode(JSON.stringify({ version: 1, accessToken: "token" })),
  };
  await assert.rejects(
    () => adapter.deployVersion({
      project: "site",
      environment: "preview",
      idempotencyKey: "one",
      files: [{ path: "../index.html", content: new Uint8Array([1]) }],
    }, context),
    ConfigurationError,
  );
  await assert.rejects(
    () => adapter.deployVersion({
      project: "site",
      environment: "preview",
      idempotencyKey: "two",
      files: [{ path: "dist/index.html", content: new Uint8Array([1, 2, 3]) }],
      providerOptions: { publishDirectory: "dist" },
    }, context),
    /exceeds 2 bytes/,
  );
});

function sha1(value: Uint8Array): string {
  return createHash("sha1").update(value).digest("hex");
}
