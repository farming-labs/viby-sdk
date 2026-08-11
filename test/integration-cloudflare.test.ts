import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import {
  CloudflareDeploymentError,
  cloudflare,
  cloudflareAccounts,
  cloudflareDeployment,
  type CloudflareDeploymentOptions,
} from "../src/integration-cloudflare.js";
import type { IntegrationOperationContext } from "../src/integrations.js";

interface Route {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly raw?: boolean;
  readonly resultInfo?: Readonly<Record<string, unknown>>;
  readonly inspect?: (request: Request) => void | Promise<void>;
}

class CloudflareFetchFixture {
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
      return Response.json({
        success: false,
        errors: [{ code: 9999, message: `Unexpected ${request.method} ${path}` }],
      }, { status: 500 });
    }
    const [route] = this.routes.splice(index, 1);
    await route!.inspect?.(request);
    const status = route!.status ?? 200;
    if (status === 204) return new Response(null, { status });
    const body = route!.raw
      ? route!.body ?? {}
      : status >= 400
        ? route!.body ?? { success: false, errors: [{ code: 1000, message: "Failed" }] }
        : {
            success: true,
            result: route!.body ?? {},
            errors: [],
            messages: [],
            ...(route!.resultInfo ? { result_info: route!.resultInfo } : {}),
          };
    return Response.json(body, { status });
  };
}

function options(fetch: typeof globalThis.fetch): CloudflareDeploymentOptions {
  return {
    clientId: "cloudflare-client",
    clientSecret: "cloudflare-secret",
    apiUrl: "https://api.cloudflare.test/client/v4",
    authorizationUrl: "https://dash.cloudflare.test/oauth2/auth",
    tokenUrl: "https://dash.cloudflare.test/oauth2/token",
    revokeUrl: "https://dash.cloudflare.test/oauth2/revoke",
    userInfoUrl: "https://dash.cloudflare.test/oauth2/userinfo",
    scopes: ["pages.write"],
    fetch,
    source: { concurrency: 1 },
  };
}

function authorizationRoutes(fixture: CloudflareFetchFixture): void {
  fixture
    .add({
      method: "POST",
      path: "/oauth2/token",
      raw: true,
      body: {
        access_token: "cloudflare-access-token",
        refresh_token: "cloudflare-refresh-token",
        token_type: "Bearer",
        expires_in: 3600,
        scope: "pages.write account.read",
      },
      async inspect(request) {
        assert.equal(
          request.headers.get("authorization"),
          `Basic ${Buffer.from("cloudflare-client:cloudflare-secret").toString("base64")}`,
        );
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("grant_type"), "authorization_code");
        assert.equal(body.get("code"), "oauth-code");
        assert.equal(body.get("redirect_uri"), "https://app.example/integrations/callback");
        assert.equal(body.has("client_secret"), false);
      },
    })
    .add({
      method: "GET",
      path: "/oauth2/userinfo",
      raw: true,
      body: {
        sub: "user_1",
        name: "Ada Lovelace",
        email: "ada@example.com",
      },
      inspect(request) {
        assert.equal(request.headers.get("authorization"), "Bearer cloudflare-access-token");
      },
    })
    .add({
      method: "GET",
      path: "/client/v4/accounts?page=1&per_page=50",
      body: [{ id: "account-a", name: "Acme" }],
      resultInfo: { page: 1, total_pages: 1 },
    });
}

async function authorize(fixture: CloudflareFetchFixture) {
  authorizationRoutes(fixture);
  const adapter = cloudflare(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-123",
  }, { tenantId: "tenant", userId: "user" });
  const authorizationUrl = new URL(started.url);
  assert.equal(authorizationUrl.origin + authorizationUrl.pathname, "https://dash.cloudflare.test/oauth2/auth");
  assert.equal(authorizationUrl.searchParams.get("response_type"), "code");
  assert.equal(authorizationUrl.searchParams.get("client_id"), "cloudflare-client");
  assert.equal(authorizationUrl.searchParams.get("redirect_uri"), "https://app.example/integrations/callback");
  assert.equal(authorizationUrl.searchParams.get("state"), "state-123");
  assert.equal(authorizationUrl.searchParams.get("scope"), "pages.write");

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

function accountsRoute(
  fixture: CloudflareFetchFixture,
  accounts = [{ id: "account-a", name: "Acme" }],
): void {
  fixture.add({
    method: "GET",
    path: "/client/v4/accounts?page=1&per_page=50",
    body: accounts,
    resultInfo: { page: 1, total_pages: 1 },
    inspect(request) {
      assert.equal(request.headers.get("authorization"), "Bearer cloudflare-access-token");
    },
  });
}

function projectLookupRoutes(fixture: CloudflareFetchFixture): void {
  accountsRoute(fixture);
  fixture.add({
    method: "GET",
    path: "/client/v4/accounts/account-a/pages/projects?page=1&per_page=100",
    body: [{
      id: "project-1",
      name: "farm-dashboard",
      subdomain: "farm-dashboard.pages.dev",
      production_branch: "main",
    }],
    resultInfo: { page: 1, total_pages: 1 },
  });
}

test("authorizes, refreshes, and revokes a Cloudflare OAuth connection", async () => {
  const fixture = new CloudflareFetchFixture();
  const before = Date.now();
  const { adapter, authorization } = await authorize(fixture);
  assert.equal(cloudflareDeployment, cloudflare);
  assert.deepEqual(authorization.account, {
    id: "user_1",
    name: "Ada Lovelace",
    metadata: {
      email: "ada@example.com",
      accounts: [{ id: "account-a", name: "Acme" }],
    },
  });
  assert.deepEqual(cloudflareAccounts(authorization.account), [{ id: "account-a", name: "Acme" }]);
  assert.deepEqual(authorization.credential.scopes, ["pages.write", "account.read"]);
  assert.ok(authorization.credential.expiresAt!.getTime() >= before + 3_599_000);

  fixture.add({
    method: "POST",
    path: "/oauth2/token",
    raw: true,
    body: {
      access_token: "refreshed-access-token",
      refresh_token: "rotated-refresh-token",
      expires_in: 7200,
      scope: "pages.write",
    },
    async inspect(request) {
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("grant_type"), "refresh_token");
      assert.equal(body.get("refresh_token"), "cloudflare-refresh-token");
    },
  });
  const refreshed = await adapter.connection.refreshCredential!(authorization.credential, {
    tenantId: "tenant",
    userId: "user",
  });
  assert.deepEqual(refreshed.scopes, ["pages.write"]);

  fixture.add({
    method: "POST",
    path: "/oauth2/revoke",
    raw: true,
    status: 204,
    async inspect(request) {
      assert.equal(
        request.headers.get("authorization"),
        `Basic ${Buffer.from("cloudflare-client:cloudflare-secret").toString("base64")}`,
      );
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("token"), "rotated-refresh-token");
      assert.equal(body.get("token_type_hint"), "refresh_token");
    },
  });
  await adapter.connection.revokeCredential!(refreshed, {
    tenantId: "tenant",
    userId: "user",
  });
  assert.equal(fixture.routes.length, 0);
});

test("surfaces Cloudflare OAuth errors and supports client-secret-post", async () => {
  const fixture = new CloudflareFetchFixture();
  const adapter = cloudflare({
    ...options(fixture.fetch),
    tokenEndpointAuthMethod: "client_secret_post",
  });
  await assert.rejects(
    () => adapter.connection.completeAuthorization({
      callbackUrl: "https://app.example/callback?error=access_denied&error_description=Nope",
    }, { tenantId: "tenant", userId: "user" }),
    (error: unknown) => error instanceof CloudflareDeploymentError
      && error.code === "access_denied",
  );
  fixture
    .add({
      method: "POST",
      path: "/oauth2/token",
      raw: true,
      body: { access_token: "token" },
      async inspect(request) {
        assert.equal(request.headers.get("authorization"), null);
        const body = new URLSearchParams(await request.text());
        assert.equal(body.get("client_id"), "cloudflare-client");
        assert.equal(body.get("client_secret"), "cloudflare-secret");
      },
    })
    .add({
      method: "GET",
      path: "/oauth2/userinfo",
      raw: true,
      body: { sub: "user_1" },
    })
    .add({
      method: "GET",
      path: "/client/v4/accounts?page=1&per_page=50",
      body: [{ id: "account-a", name: "Acme" }],
      resultInfo: { total_pages: 1 },
    });
  await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/callback?code=code",
  }, { tenantId: "tenant", userId: "user" });
  assert.equal(fixture.routes.length, 0);
});

test("paginates projects across accounts and requires explicit account selection", async () => {
  const fixture = new CloudflareFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const accounts = [{ id: "account-a", name: "Acme" }, { id: "account-b", name: "Labs" }];
  accountsRoute(fixture, accounts);
  fixture.add({
    method: "GET",
    path: "/client/v4/accounts/account-a/pages/projects?page=1&per_page=100",
    body: [
      { id: "project-1", name: "dashboard", subdomain: "dashboard.pages.dev" },
      { id: "project-2", name: "docs", subdomain: "docs.pages.dev" },
    ],
    resultInfo: { total_pages: 1 },
  });
  const first = await adapter.listProjects({ limit: 1 }, context);
  assert.deepEqual(first.items, [{
    id: "project-1",
    name: "dashboard",
    url: "https://dashboard.pages.dev",
  }]);
  assert.ok(first.nextCursor);

  accountsRoute(fixture, accounts);
  fixture.add({
    method: "GET",
    path: "/client/v4/accounts/account-a/pages/projects?page=1&per_page=100",
    body: [
      { id: "project-1", name: "dashboard", subdomain: "dashboard.pages.dev" },
      { id: "project-2", name: "docs", subdomain: "docs.pages.dev" },
    ],
    resultInfo: { total_pages: 1 },
  });
  const second = await adapter.listProjects({ cursor: first.nextCursor!, limit: 1 }, context);
  assert.equal(second.items[0]?.id, "project-2");

  accountsRoute(fixture, accounts);
  await assert.rejects(
    () => adapter.createProject({ name: "viby-app" }, context),
    (error: unknown) => error instanceof ConfigurationError
      && error.message.includes("providerOptions.accountId"),
  );

  accountsRoute(fixture, accounts);
  fixture.add({
    method: "POST",
    path: "/client/v4/accounts/account-b/pages/projects",
    body: { id: "project-3", name: "viby-app", subdomain: "viby-app.pages.dev" },
    async inspect(request) {
      assert.deepEqual(await request.json(), { name: "viby-app", production_branch: "trunk" });
    },
  });
  const created = await adapter.createProject({
    name: "viby-app",
    providerOptions: { accountId: "account-b", productionBranch: "trunk" },
  }, context);
  assert.equal(created.id, "project-3");

  accountsRoute(fixture, accounts);
  fixture
    .add({
      method: "GET",
      path: "/client/v4/accounts/account-a/pages/projects/viby-app",
      status: 404,
    })
    .add({
      method: "GET",
      path: "/client/v4/accounts/account-b/pages/projects/viby-app",
      body: { id: "project-3", name: "viby-app", subdomain: "viby-app.pages.dev" },
    });
  assert.equal((await adapter.getProject({ name: "viby-app" }, context))?.id, "project-3");
  assert.equal(fixture.routes.length, 0);
});

test("uploads prebuilt immutable assets and resumes deployments by idempotency key", async () => {
  const fixture = new CloudflareFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const html = new TextEncoder().encode("<!doctype html><title>Viby</title>");
  const css = new TextEncoder().encode("body{color:red}");
  const htmlHash = "76ddf1774f5a10b57f83031c3a8ea77a";
  const cssHash = "a1e60d295449511896a3679447c6cae3";
  const idempotencyKey = "deploy-1";
  const commitHash = "244cf825d65c1c4e8ee725c6b95546126c6221db";
  const deploymentResponse = {
    id: "deployment-1",
    project_id: "project-1",
    project_name: "farm-dashboard",
    environment: "preview",
    url: "https://deployment-1.farm-dashboard.pages.dev",
    created_on: "2026-08-11T10:00:00.000Z",
    latest_stage: { status: "active" },
    deployment_trigger: { metadata: { commit_hash: commitHash } },
  };

  projectLookupRoutes(fixture);
  fixture
    .add({
      method: "GET",
      path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/deployments?page=1&per_page=100",
      body: [],
      resultInfo: { total_pages: 1 },
    })
    .add({
      method: "GET",
      path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/upload-token",
      body: { jwt: "upload-jwt" },
    })
    .add({
      method: "POST",
      path: "/client/v4/pages/assets/check-missing",
      body: [htmlHash, cssHash],
      async inspect(request) {
        assert.equal(request.headers.get("authorization"), "Bearer upload-jwt");
        assert.deepEqual(await request.json(), { hashes: [htmlHash, cssHash] });
      },
    })
    .add({
      method: "POST",
      path: "/client/v4/pages/assets/upload",
      body: null,
      async inspect(request) {
        const body = await request.json() as Array<Record<string, unknown>>;
        assert.deepEqual(body.map((item) => item.key), [htmlHash, cssHash]);
        assert.deepEqual(body.map((item) => item.metadata), [
          { contentType: "text/html; charset=utf-8" },
          { contentType: "text/css; charset=utf-8" },
        ]);
        assert.equal(body.every((item) => item.base64 === true), true);
      },
    })
    .add({
      method: "POST",
      path: "/client/v4/pages/assets/upsert-hashes",
      body: null,
    })
    .add({
      method: "POST",
      path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/deployments",
      body: deploymentResponse,
      async inspect(request) {
        assert.match(request.headers.get("content-type") ?? "", /^multipart\/form-data; boundary=/);
        const form = await request.formData();
        assert.deepEqual(JSON.parse(String(form.get("manifest"))), {
          "/index.html": htmlHash,
          "/assets/app.css": cssHash,
        });
        assert.equal(form.get("branch"), "feature/analytics");
        assert.equal(form.get("commit_hash"), commitHash);
        assert.equal(form.get("commit_message"), "Ship analytics");
        assert.equal(form.get("commit_dirty"), "false");
        assert.equal(form.get("pages_build_output_dir"), "dist");
        assert.equal(
          await (form.get("_headers") as File).text(),
          "/*\n  X-Frame-Options: DENY",
        );
      },
    });

  const input = {
    project: "project-1",
    environment: "preview" as const,
    idempotencyKey,
    files: [
      { path: "src/index.ts", content: new Uint8Array([1]) },
      { path: "dist/index.html", content: html },
      { path: "dist/assets/app.css", content: css },
      { path: "dist/_headers", content: new TextEncoder().encode("/*\n  X-Frame-Options: DENY") },
    ],
    providerOptions: { branch: "feature/analytics", commitMessage: "Ship analytics" },
  };
  const first = await adapter.deployVersion(input, context);
  assert.equal(first.projectId, "project-1");
  assert.equal(first.environment, "preview");
  assert.equal(first.status, "building");
  assert.equal(first.url, "https://deployment-1.farm-dashboard.pages.dev");
  assert.match(first.id, /^cfp\./);

  fixture.add({
    method: "GET",
    path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/deployments/deployment-1",
    body: { ...deploymentResponse, latest_stage: { status: "success" } },
  });
  const ready = await adapter.getDeployment({ id: first.id }, context);
  assert.equal(ready?.status, "ready");

  projectLookupRoutes(fixture);
  fixture.add({
    method: "GET",
    path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/deployments?page=1&per_page=100",
    body: [{ ...deploymentResponse, latest_stage: { status: "success" } }],
    resultInfo: { total_pages: 1 },
  });
  const repeated = await adapter.deployVersion(input, context);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, "ready");
  assert.equal(fixture.calls.filter((call) => new URL(call.url).pathname.endsWith("/assets/upload")).length, 1);

  projectLookupRoutes(fixture);
  fixture
    .add({
      method: "GET",
      path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/deployments?page=1&per_page=100",
      body: [],
      resultInfo: { total_pages: 1 },
    })
    .add({
      method: "GET",
      path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/upload-token",
      body: { jwt: "upload-jwt" },
    })
    .add({
      method: "POST",
      path: "/client/v4/pages/assets/check-missing",
      body: [],
    })
    .add({
      method: "POST",
      path: "/client/v4/pages/assets/upsert-hashes",
      body: null,
    })
    .add({
      method: "POST",
      path: "/client/v4/accounts/account-a/pages/projects/farm-dashboard/deployments",
      body: { ...deploymentResponse, id: "deployment-production", environment: "production" },
      async inspect(request) {
        const form = await request.formData();
        assert.equal(form.get("branch"), null);
      },
    });
  const production = await adapter.deployVersion({
    ...input,
    environment: "production",
    idempotencyKey: "deploy-production",
  }, context);
  assert.equal(production.environment, "production");
  assert.equal(fixture.calls.filter((call) => new URL(call.url).pathname.endsWith("/assets/upload")).length, 1);
  assert.equal(fixture.routes.length, 0);
});

test("requires built output and validates Cloudflare-specific boundaries before network access", async () => {
  const fixture = new CloudflareFetchFixture();
  const { adapter, context } = await authorize(fixture);
  await assert.rejects(
    () => adapter.deployVersion({
      project: "project-1",
      environment: "preview",
      idempotencyKey: "missing-build",
      files: [{ path: "src/index.ts", content: new Uint8Array([1]) }],
    }, context),
    (error: unknown) => error instanceof ConfigurationError
      && error.message.includes("prebuilt assets in dist"),
  );
  await assert.rejects(
    () => adapter.deployVersion({
      project: "project-1",
      environment: "preview",
      idempotencyKey: "unsafe",
      files: [{ path: "../dist/index.html", content: new Uint8Array([1]) }],
    }, context),
    ConfigurationError,
  );
  await assert.rejects(
    () => adapter.getDeployment({ id: "deployment-1" }, context),
    (error: unknown) => error instanceof ConfigurationError
      && error.message.includes("deployment id is invalid"),
  );
  assert.equal(fixture.routes.length, 0);
});
