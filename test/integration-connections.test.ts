import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { createViby } from "../src/client.js";
import {
  IntegrationClient,
} from "../src/integration-client.js";
import type {
  IntegrationConnectionAdapter,
  RepositoryIntegration,
} from "../src/integrations.js";
import {
  ConfigurationError,
  IntegrationAuthorizationError,
} from "../src/errors.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import {
  MemoryIntegrationConnectionStore,
  MemorySecretStore,
} from "./helpers/memory-integration-store.js";
import { verifyIntegrationStores } from "../src/integration-store-conformance.js";

function fakeGitHub(options: { readonly expired?: boolean } = {}) {
  const calls = {
    start: 0,
    complete: 0,
    refresh: 0,
    revoke: 0,
  };
  const connection: IntegrationConnectionAdapter = {
    async startAuthorization(input) {
      calls.start += 1;
      const url = new URL("https://github.example/authorize");
      url.searchParams.set("state", input.state);
      return {
        url: url.href,
        expiresAt: null,
        session: new TextEncoder().encode("pkce-verifier"),
      };
    },
    async completeAuthorization(input) {
      calls.complete += 1;
      assert.equal(new TextDecoder().decode(input.session), "pkce-verifier");
      assert.equal(new URL(input.callbackUrl).searchParams.get("code"), "accepted");
      return {
        account: {
          id: "github-installation-42",
          name: "farming-labs",
          url: "https://github.example/farming-labs",
          metadata: { installationId: "42" },
        },
        credential: {
          secret: new TextEncoder().encode("access-token-1"),
          expiresAt: options.expired ? new Date(Date.now() - 1_000) : null,
          scopes: ["contents:write", "pull_requests:write"],
        },
      };
    },
    async refreshCredential() {
      calls.refresh += 1;
      return {
        secret: new TextEncoder().encode("access-token-2"),
        expiresAt: new Date(Date.now() + 60_000),
        scopes: ["contents:write", "pull_requests:write"],
      };
    },
    async revokeCredential() {
      calls.revoke += 1;
    },
  };
  const adapter: RepositoryIntegration = {
    provider: "github",
    displayName: "GitHub",
    connection,
    async listOwners() { return { items: [], nextCursor: null }; },
    async listRepositories() { return { items: [], nextCursor: null }; },
    async getRepository() { return null; },
    async createRepository(input) {
      return {
        id: "repository",
        owner: input.owner,
        name: input.name,
        defaultBranch: "main",
        visibility: input.visibility ?? "private",
        url: `https://github.example/${input.owner}/${input.name}`,
      };
    },
    async listBranches() { return { items: [], nextCursor: null }; },
    async createBranch(input) { return { name: input.name, head: input.from, protected: false }; },
    async pushVersion(input) {
      return {
        status: "pushed",
        commit: { id: "commit", message: input.message, branch: input.branch, url: null },
        changedFiles: input.files.length,
      };
    },
    async createPullRequest(input) {
      return {
        id: "pull-request",
        number: 1,
        title: input.title,
        head: input.head,
        base: input.base,
        status: input.draft ? "draft" : "open",
        url: "https://github.example/pull/1",
      };
    },
  };
  return { adapter, calls };
}

function setup(options: { readonly expired?: boolean } = {}) {
  const provider = fakeGitHub(options);
  const connectionStore = new MemoryIntegrationConnectionStore();
  const secretStore = new MemorySecretStore();
  const client = new IntegrationClient({
    repository: { github: provider.adapter },
  }, connectionStore, secretStore);
  const scope = { tenantId: "tenant-a", userId: "user-a" };
  return { client, connectionStore, secretStore, provider, scope };
}

async function authorize(setupResult: ReturnType<typeof setup>) {
  const user = setupResult.client.forUser(setupResult.scope);
  const started = await user.repository.connect("github", {
    callbackUrl: "https://app.example/api/integrations/callback",
    returnTo: "/projects/project-1",
  });
  assert.equal(started.status, "authorization-required");
  const state = new URL(started.url).searchParams.get("state");
  assert.ok(state);
  const completed = await setupResult.client.callback(
    `https://app.example/api/integrations/callback?state=${encodeURIComponent(state)}&code=accepted`,
  );
  return { user, started, state, completed };
}

test("completes a durable single-use authorization lifecycle without exposing credentials", async () => {
  const fixture = setup();
  const { user, state, completed } = await authorize(fixture);

  assert.equal(completed.category, "repository");
  assert.equal(completed.integrationId, "github");
  assert.equal(completed.returnTo, "/projects/project-1");
  assert.equal(completed.connection.account.name, "farming-labs");
  assert.equal("secretRef" in completed.connection, false);
  assert.equal("credential" in completed.connection, false);
  assert.equal(fixture.connectionStore.authorizationSessions.has(state), false);
  assert.equal(fixture.connectionStore.authorizationSessions.size, 1);

  const [status] = await user.repository.list();
  assert.equal(status?.connected, true);
  assert.equal(status?.connections.length, 1);
  assert.deepEqual(await fixture.client.forUser({
    tenantId: "tenant-b",
    userId: "user-a",
  }).repository.connections(), []);

  await assert.rejects(
    () => fixture.client.callback(
      `https://app.example/api/integrations/callback?state=${encodeURIComponent(state)}&code=accepted`,
    ),
    IntegrationAuthorizationError,
  );

  const connected = await user.repository.connect("github", {
    callbackUrl: "https://app.example/api/integrations/callback",
    returnTo: "/projects/project-1",
  });
  assert.equal(connected.status, "connected");
  assert.equal(fixture.provider.calls.start, 1);
});

test("refreshes expired credentials atomically before provider operations", async () => {
  const fixture = setup({ expired: true });
  const { completed } = await authorize(fixture);
  const context = await fixture.client.operationContext(
    fixture.scope,
    "repository",
    "github",
    completed.connection.id,
  );

  assert.equal(new TextDecoder().decode(context.credential), "access-token-2");
  assert.equal(fixture.provider.calls.refresh, 1);
  assert.equal(fixture.secretStore.secrets.size, 1);
});

test("disconnects locally even when provider revocation is unavailable", async () => {
  const fixture = setup();
  const { user, completed } = await authorize(fixture);
  const result = await user.repository.disconnect("github", {
    connectionId: completed.connection.id,
  });

  assert.equal(result.connection.status, "revoked");
  assert.equal(result.providerRevoked, true);
  assert.equal(fixture.provider.calls.revoke, 1);
  assert.equal(fixture.secretStore.secrets.size, 0);
});

test("rejects callback substitution and cross-origin return paths", async () => {
  const fixture = setup();
  const user = fixture.client.forUser(fixture.scope);
  await assert.rejects(
    () => user.repository.connect("github", {
      callbackUrl: "https://app.example/api/integrations/callback",
      returnTo: "https://attacker.example/steal",
    }),
    ConfigurationError,
  );

  const started = await user.repository.connect("github", {
    callbackUrl: "https://app.example/api/integrations/callback",
    returnTo: "/projects/project-1",
  });
  assert.equal(started.status, "authorization-required");
  const state = new URL(started.url).searchParams.get("state");
  assert.ok(state);
  await assert.rejects(
    () => fixture.client.callback(
      `https://other.example/api/integrations/callback?state=${encodeURIComponent(state)}&code=accepted`,
    ),
    IntegrationAuthorizationError,
  );
  assert.equal((await fixture.client.callback(
    `https://app.example/api/integrations/callback?state=${encodeURIComponent(state)}&code=accepted`,
  )).connection.status, "active");
});

test("exposes categorized connection operations through the existing Viby client", async () => {
  const provider = fakeGitHub();
  const connectionStore = new MemoryIntegrationConnectionStore();
  const secretStore = new MemorySecretStore();
  const viby = createViby({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    persistence: new MemoryRepository(),
    connectionStore,
    secretStore,
    integrations: {
      repository: { github: provider.adapter },
    },
  });

  const configured = await viby.forUser({
    tenantId: "tenant",
    userId: "user",
  }).integrations.repository.list();
  assert.equal(configured[0]?.id, "github");
  assert.equal(configured[0]?.connected, false);
  await viby.close();
});

test("passes the reusable integration store conformance suite", async () => {
  const report = await verifyIntegrationStores({
    create: () => ({
      connectionStore: new MemoryIntegrationConnectionStore(),
      secretStore: new MemorySecretStore(),
    }),
  });
  assert.deepEqual(report.checks, [
    "secret-roundtrip",
    "secret-defensive-read",
    "secret-isolation",
    "authorization-read",
    "authorization-consume",
    "authorization-single-use",
    "connection-upsert",
    "connection-list",
    "connection-isolation",
    "connection-update",
    "secret-delete",
  ]);
});
