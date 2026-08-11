import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import {
  VercelDeploymentError,
  vercel,
  vercelDeployment,
  type VercelDeploymentOptions,
} from "../src/integration-vercel.js";
import type { IntegrationOperationContext } from "../src/integrations.js";

interface Route {
  readonly method: string;
  readonly path: string;
  readonly status?: number;
  readonly body?: unknown;
  readonly inspect?: (request: Request) => void | Promise<void>;
}

class VercelFetchFixture {
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
      return Response.json({ error: { message: `Unexpected ${request.method} ${path}` } }, {
        status: 500,
      });
    }
    const [route] = this.routes.splice(index, 1);
    await route!.inspect?.(request);
    const status = route!.status ?? 200;
    return status === 204 ? new Response(null, { status }) : Response.json(route!.body ?? {}, { status });
  };
}

function options(fetch: typeof globalThis.fetch): VercelDeploymentOptions {
  return {
    clientId: "vercel-client",
    clientSecret: "vercel-secret",
    slug: "viby-test",
    apiUrl: "https://api.vercel.test",
    webUrl: "https://vercel.test",
    fetch,
    source: { concurrency: 1 },
  };
}

function authorizeRoute(fixture: VercelFetchFixture): void {
  fixture.add({
    method: "POST",
    path: "/v2/oauth/access_token",
    body: {
      access_token: "vercel-access-token",
      token_type: "Bearer",
      team_id: "team_1",
      user_id: "user_1",
    },
    async inspect(request) {
      assert.equal(request.headers.get("content-type"), "application/x-www-form-urlencoded");
      const body = new URLSearchParams(await request.text());
      assert.equal(body.get("client_id"), "vercel-client");
      assert.equal(body.get("client_secret"), "vercel-secret");
      assert.equal(body.get("code"), "oauth-code");
      assert.equal(body.get("redirect_uri"), "https://app.example/integrations/callback");
    },
  });
}

async function authorize(fixture: VercelFetchFixture) {
  authorizeRoute(fixture);
  const adapter = vercel(options(fixture.fetch));
  const started = await adapter.connection.startAuthorization({
    callbackUrl: "https://app.example/integrations/callback",
    state: "state-123",
  }, { tenantId: "tenant", userId: "user" });
  assert.equal(started.url, "https://vercel.test/integrations/viby-test/new?state=state-123");
  const authorization = await adapter.connection.completeAuthorization({
    callbackUrl: "https://app.example/integrations/callback?code=oauth-code&teamId=team_1&configurationId=icfg_1&state=state-123",
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

test("authorizes and revokes a team-scoped Vercel external integration", async () => {
  const fixture = new VercelFetchFixture();
  const { adapter, authorization } = await authorize(fixture);
  assert.equal(vercelDeployment, vercel);
  assert.equal(authorization.account.id, "team_1");
  assert.equal(authorization.account.name, "Vercel team team_1");
  assert.deepEqual(authorization.account.metadata, {
    teamId: "team_1",
    userId: "user_1",
    configurationId: "icfg_1",
  });
  assert.deepEqual(authorization.credential.scopes, [
    "project:read-write",
    "deployment:read-write",
  ]);
  assert.equal(authorization.credential.expiresAt, null);

  fixture.add({
    method: "POST",
    path: "/login/oauth/token/revoke",
    status: 204,
    async inspect(request) {
      assert.equal(
        request.headers.get("authorization"),
        `Basic ${Buffer.from("vercel-client:vercel-secret").toString("base64")}`,
      );
      assert.equal(new URLSearchParams(await request.text()).get("token"), "vercel-access-token");
    },
  });
  await adapter.connection.revokeCredential!(authorization.credential, {
    tenantId: "tenant",
    userId: "user",
  });
  assert.equal(fixture.routes.length, 0);
});

test("rejects mismatched Vercel team callbacks and provider authorization errors", async () => {
  const mismatch = new VercelFetchFixture();
  authorizeRoute(mismatch);
  const adapter = vercel(options(mismatch.fetch));
  await assert.rejects(
    () => adapter.connection.completeAuthorization({
      callbackUrl: "https://app.example/integrations/callback?code=oauth-code&teamId=team_2",
    }, { tenantId: "tenant", userId: "user" }),
    (error: unknown) => error instanceof VercelDeploymentError
      && error.code === "team_mismatch",
  );
  await assert.rejects(
    () => adapter.connection.completeAuthorization({
      callbackUrl: "https://app.example/integrations/callback?error=access_denied&error_description=Nope",
    }, { tenantId: "tenant", userId: "user" }),
    (error: unknown) => error instanceof VercelDeploymentError
      && error.code === "access_denied",
  );
});

test("lists, gets, and creates Vercel projects with team scoping", async () => {
  const fixture = new VercelFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture.add({
    method: "GET",
    path: "/v9/projects?teamId=team_1&limit=2&from=cursor-1&search=dash",
    body: {
      projects: [{
        id: "prj_1",
        name: "dashboard",
        latestDeployments: [{ url: "dashboard-123.vercel.app" }],
      }],
      pagination: { next: 1723456789 },
    },
    inspect(request) {
      assert.equal(request.headers.get("authorization"), "Bearer vercel-access-token");
    },
  });
  const page = await adapter.listProjects({ search: "dash", cursor: "cursor-1", limit: 2 }, context);
  assert.deepEqual(page, {
    items: [{ id: "prj_1", name: "dashboard", url: "https://dashboard-123.vercel.app" }],
    nextCursor: "1723456789",
  });

  fixture
    .add({
      method: "GET",
      path: "/v9/projects/dashboard?teamId=team_1",
      body: { id: "prj_1", name: "dashboard" },
    })
    .add({
      method: "GET",
      path: "/v9/projects/missing?teamId=team_1",
      status: 404,
      body: { error: { code: "not_found", message: "Missing" } },
    });
  assert.equal((await adapter.getProject({ name: "dashboard" }, context))?.id, "prj_1");
  assert.equal(await adapter.getProject({ id: "missing" }, context), null);

  fixture.add({
    method: "POST",
    path: "/v9/projects?teamId=team_1",
    body: { id: "prj_2", name: "farm-dashboard" },
    async inspect(request) {
      assert.deepEqual(await request.json(), {
        name: "farm-dashboard",
        framework: "vite",
        buildCommand: "pnpm build",
        outputDirectory: "dist",
      });
    },
  });
  const created = await adapter.createProject({
    name: "farm-dashboard",
    providerOptions: {
      framework: "vite",
      buildCommand: "pnpm build",
      outputDirectory: "dist",
    },
  }, context);
  assert.equal(created.id, "prj_2");
  assert.equal(fixture.routes.length, 0);
});

test("uploads immutable source and reuses Vercel deployments by durable metadata", async () => {
  const fixture = new VercelFetchFixture();
  const { adapter, context } = await authorize(fixture);
  const html = new TextEncoder().encode("<!doctype html><title>Viby</title>");
  const binary = new Uint8Array([0, 1, 2, 255]);
  fixture
    .add({
      method: "GET",
      path: "/v6/deployments?teamId=team_1&projectId=prj_1&limit=1&meta-vibyIdempotencyKey=deploy-1",
      body: { deployments: [] },
    })
    .add({
      method: "GET",
      path: "/v9/projects/prj_1?teamId=team_1",
      body: { id: "prj_1", name: "farm-dashboard" },
    })
    .add(uploadRoute("index.html", html))
    .add(uploadRoute("public/logo.bin", binary))
    .add({
      method: "POST",
      path: "/v13/deployments?teamId=team_1&skipAutoDetectionConfirmation=1",
      body: {
        id: "dpl_1",
        projectId: "prj_1",
        target: null,
        readyState: "QUEUED",
        url: "farm-dashboard-abc.vercel.app",
        createdAt: 1_723_456_789_000,
      },
      async inspect(request) {
        assert.deepEqual(await request.json(), {
          name: "farm-dashboard",
          project: "prj_1",
          files: [
            { file: "index.html", sha: sha1(html), size: html.byteLength },
            { file: "public/logo.bin", sha: sha1(binary), size: binary.byteLength },
          ],
          meta: { feature: "analytics", vibyIdempotencyKey: "deploy-1" },
          projectSettings: { buildCommand: "pnpm build", outputDirectory: "dist" },
        });
      },
    });
  const input = {
    project: "prj_1",
    environment: "preview" as const,
    idempotencyKey: "deploy-1",
    files: [
      { path: "index.html", content: html },
      { path: "public/logo.bin", content: binary },
    ],
    providerOptions: {
      meta: { feature: "analytics" },
      skipAutoDetectionConfirmation: true,
      projectSettings: { buildCommand: "pnpm build", outputDirectory: "dist" },
    },
  };
  const first = await adapter.deployVersion(input, context);
  assert.deepEqual(first, {
    id: "dpl_1",
    projectId: "prj_1",
    environment: "preview",
    status: "queued",
    url: "https://farm-dashboard-abc.vercel.app",
    createdAt: new Date(1_723_456_789_000),
  });

  fixture
    .add({
      method: "GET",
      path: "/v6/deployments?teamId=team_1&projectId=prj_1&limit=1&meta-vibyIdempotencyKey=deploy-1",
      body: { deployments: [{ uid: "dpl_1" }] },
    })
    .add({
      method: "GET",
      path: "/v13/deployments/dpl_1?teamId=team_1",
      body: {
        id: "dpl_1",
        projectId: "prj_1",
        readyState: "BUILDING",
        url: "farm-dashboard-abc.vercel.app",
        createdAt: 1_723_456_789_000,
        meta: { vibyIdempotencyKey: "deploy-1" },
      },
    });
  const repeated = await adapter.deployVersion(input, context);
  assert.equal(repeated.id, first.id);
  assert.equal(repeated.status, "building");
  assert.equal(fixture.calls.filter((call) => new URL(call.url).pathname === "/v2/files").length, 2);

  fixture
    .add({
      method: "GET",
      path: "/v13/deployments/dpl_1?teamId=team_1",
      body: {
        id: "dpl_1",
        projectId: "prj_1",
        target: "production",
        readyState: "READY",
        url: "farm-dashboard.vercel.app",
        createdAt: 1_723_456_789_000,
      },
    })
    .add({
      method: "PATCH",
      path: "/v12/deployments/dpl_1/cancel?teamId=team_1",
      body: {
        id: "dpl_1",
        projectId: "prj_1",
        target: "production",
        readyState: "CANCELED",
        createdAt: 1_723_456_789_000,
      },
    });
  assert.equal((await adapter.getDeployment({ id: "dpl_1" }, context))?.status, "ready");
  fixture.routes.splice(1, 0, {
    method: "GET",
    path: "/v13/deployments/dpl_1?teamId=team_1",
    body: {
      id: "dpl_1",
      projectId: "prj_1",
      target: "production",
      readyState: "BUILDING",
      createdAt: 1_723_456_789_000,
    },
  });
  const cancelled = await adapter.cancelDeployment!({
    id: "dpl_1",
    idempotencyKey: "cancel-1",
  }, context);
  assert.equal(cancelled.status, "cancelled");
  fixture.add({
    method: "GET",
    path: "/v13/deployments/dpl_1?teamId=team_1",
    body: {
      id: "dpl_1",
      projectId: "prj_1",
      target: "production",
      readyState: "CANCELED",
      createdAt: 1_723_456_789_000,
    },
  });
  assert.equal((await adapter.cancelDeployment!({
    id: "dpl_1",
    idempotencyKey: "cancel-1",
  }, context)).id, "dpl_1");
  assert.equal(fixture.routes.length, 0);
});

test("maps custom environments and validates project and source boundaries", async () => {
  const fixture = new VercelFetchFixture();
  const { adapter, context } = await authorize(fixture);
  fixture
    .add({
      method: "GET",
      path: "/v6/deployments?teamId=team_1&projectId=prj_1&limit=1&meta-vibyIdempotencyKey=deploy-stage",
      body: { deployments: [] },
    })
    .add({
      method: "GET",
      path: "/v9/projects/prj_1?teamId=team_1",
      body: { id: "prj_1", name: "farm-dashboard" },
    })
    .add(uploadRoute("index.html", new Uint8Array([1])))
    .add({
      method: "POST",
      path: "/v13/deployments?teamId=team_1",
      body: {
        id: "dpl_stage",
        projectId: "prj_1",
        readyState: "INITIALIZING",
        customEnvironment: { slug: "qa" },
        created: 1_723_456_789_000,
      },
      async inspect(request) {
        const body = await request.json() as Record<string, unknown>;
        assert.equal(body.customEnvironmentSlugOrId, "qa");
        assert.equal(body.target, undefined);
      },
    });
  const deployment = await adapter.deployVersion({
    project: "prj_1",
    environment: "qa",
    idempotencyKey: "deploy-stage",
    files: [{ path: "index.html", content: new Uint8Array([1]) }],
  }, context);
  assert.equal(deployment.environment, "qa");
  assert.equal(deployment.status, "building");

  await assert.rejects(
    () => adapter.getProject({}, context),
    ConfigurationError,
  );
  await assert.rejects(
    () => adapter.createProject({ name: "Invalid Project" }, context),
    ConfigurationError,
  );
  await assert.rejects(
    () => adapter.deployVersion({
      project: "prj_1",
      environment: "preview",
      idempotencyKey: "unsafe",
      files: [{ path: "../secret", content: new Uint8Array([1]) }],
    }, context),
    ConfigurationError,
  );
  assert.equal(fixture.routes.length, 0);
});

function uploadRoute(path: string, bytes: Uint8Array): Route {
  return {
    method: "POST",
    path: "/v2/files?teamId=team_1",
    status: 200,
    async inspect(request) {
      assert.equal(request.headers.get("authorization"), "Bearer vercel-access-token");
      assert.equal(request.headers.get("content-type"), "application/octet-stream");
      assert.equal(request.headers.get("content-length"), String(bytes.byteLength));
      assert.equal(request.headers.get("x-vercel-digest"), sha1(bytes), path);
      assert.deepEqual(new Uint8Array(await request.arrayBuffer()), bytes, path);
    },
  };
}

function sha1(bytes: Uint8Array): string {
  return createHash("sha1").update(bytes).digest("hex");
}
