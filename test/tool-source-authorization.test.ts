import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import { ToolSourceConnectionRequiredError } from "../src/errors.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { defineToolSourceAdapter } from "../src/tool-source-registry.js";
import type { FrameworkId } from "../src/types.js";
import { MemoryIntegrationConnectionStore, MemorySecretStore } from "./helpers/memory-integration-store.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

class UnusedGenerator<Framework extends FrameworkId> implements ProjectGenerator<Framework> {
  async generate(_input: GeneratorInput<Framework>): Promise<GeneratorOutput> {
    throw new Error("Tool-source authorization tests do not invoke generation.");
  }
}

const scope = { tenantId: "tool-oauth-tenant", userId: "tool-oauth-user" };

test("authorizes durable tool sources without exposing credentials", async () => {
  const repository = new MemoryRepository();
  const secrets = new MemorySecretStore();
  const adapterEvents: string[] = [];
  let revoked = "";
  const adapter = defineToolSourceAdapter<"farm">({
    type: "oauth-fixture",
    authorization: {
      provider: "fixture-oauth",
      async startAuthorization(input) {
        return {
          url: `https://provider.example.test/oauth?state=${encodeURIComponent(input.state)}`,
          expiresAt: new Date(Date.now() + 60_000),
          session: new TextEncoder().encode("pkce-verifier"),
        };
      },
      async completeAuthorization(input) {
        assert.equal(new TextDecoder().decode(input.session), "pkce-verifier");
        assert.equal(new URL(input.callbackUrl).searchParams.get("code"), "approved");
        return {
          account: { id: "account-1", name: "Fixture account" },
          credential: {
            secret: new TextEncoder().encode("expired-access-token"),
            scopes: ["tools:read"],
            expiresAt: new Date(Date.now() - 1_000),
          },
        };
      },
      async refreshCredential(credential) {
        assert.equal(new TextDecoder().decode(credential.secret), "expired-access-token");
        adapterEvents.push("refresh");
        return {
          secret: new TextEncoder().encode("fresh-access-token"),
          scopes: credential.scopes,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      async revokeCredential(credential) {
        revoked = new TextDecoder().decode(credential.secret);
      },
    },
    open({ source, credential }) {
      assert.ok(credential);
      return {
        id: source.id,
        async list({ signal }) {
          const authorized = await credential(signal);
          adapterEvents.push(`list:${new TextDecoder().decode(authorized.credential)}`);
          return [{
            name: "lookup",
            description: "Read an authorized fixture.",
            inputSchema: { type: "object" },
            effect: "read",
          }];
        },
        async call(_call, { signal }) {
          const authorized = await credential(signal);
          adapterEvents.push(`call:${new TextDecoder().decode(authorized.credential)}`);
          return { ok: true };
        },
      };
    },
  });
  const viby = createVibyWithDependencies({
    framework: "farm",
    model: "test/unused" as LanguageModel,
    storage: {
      connections: new MemoryIntegrationConnectionStore(),
      secrets,
    },
    tools: { adapters: { "oauth-fixture": adapter } },
  }, {
    repository,
    generator: new UnusedGenerator<"farm">(),
    skillResolver: new SkillResolver({}),
  });

  try {
    const user = viby.forUser(scope);
    const chat = await user.chats.create({ title: "Authorized tools" });
    const source = await user.toolSources.create({
      type: "oauth-fixture",
      name: "Authorized fixture",
      configuration: { endpoint: "https://tools.example.test" },
    });
    const started = await source.connect({
      callbackUrl: "https://app.example.test/tool-sources/callback",
      returnTo: "/settings/tools",
    });
    assert.equal(started.status, "authorization-required");
    if (started.status !== "authorization-required") return;
    const state = new URL(started.url).searchParams.get("state");
    assert.ok(state);
    const storedSession = [...repository.toolSourceAuthorizationSessions.values()][0];
    assert.ok(storedSession);
    assert.notEqual(storedSession.stateHash, state);
    await assert.rejects(
      () => viby.toolSources.callback(
        `https://attacker.example.test/tool-sources/callback?state=${encodeURIComponent(state)}&code=approved`,
      ),
      /does not match the authorization session/,
    );

    const completed = await viby.toolSources.callback(
      `https://app.example.test/tool-sources/callback?state=${encodeURIComponent(state)}&code=approved`,
    );
    assert.equal(completed.toolSourceId, source.id);
    assert.equal(completed.returnTo, "/settings/tools");
    assert.equal(completed.connection.status, "active");
    assert.equal(JSON.stringify(completed).includes("secretRef"), false);
    assert.equal(JSON.stringify(completed).includes("access-token"), false);
    await assert.rejects(
      () => viby.toolSources.callback(
        `https://app.example.test/tool-sources/callback?state=${encodeURIComponent(state)}&code=replay`,
      ),
      /missing, expired, or already consumed/,
    );

    await chat.toolSources.set([source.id]);
    const generationContext = {
      ...scope,
      chatId: chat.id,
      generationId: crypto.randomUUID(),
      attemptId: crypto.randomUUID(),
      framework: "farm" as const,
      metadata: {},
    };
    // Exercise the registry wrapper, which enforces authorization before adapter methods.
    const registry = new (await import("../src/tool-source-registry.js")).ToolSourceRegistry(
      repository,
      { "oauth-fixture": adapter },
      secrets,
    );
    const [guarded] = await registry.resolve(generationContext);
    assert.ok(guarded);
    await guarded.list(generationContext);
    await guarded.call({ name: "lookup", arguments: {}, idempotencyKey: "call-1" }, generationContext);
    assert.deepEqual(adapterEvents, [
      "refresh",
      "list:fresh-access-token",
      "call:fresh-access-token",
    ]);

    const disconnected = await source.disconnect();
    assert.equal(disconnected.connection.status, "revoked");
    assert.equal(disconnected.providerRevoked, true);
    assert.equal(revoked, "fresh-access-token");
    await assert.rejects(
      () => guarded.list(generationContext),
      ToolSourceConnectionRequiredError,
    );
    await registry.close();
  } finally {
    await viby.close();
  }
});

test("rejects connection attempts for adapters without authorization", async () => {
  const repository = new MemoryRepository();
  const secrets = new MemorySecretStore();
  const adapter = defineToolSourceAdapter({
    type: "plain",
    open: ({ source }) => ({ id: source.id, list: async () => [], call: async () => null }),
  });
  const registry = new (await import("../src/tool-source-registry.js")).ToolSourceRegistry(
    repository,
    { plain: adapter },
    secrets,
  );
  const source = await registry.create(scope, { type: "plain", name: "Plain" });
  await assert.rejects(
    () => registry.connect(scope, source.id, {
      callbackUrl: "https://app.example.test/tool-sources/callback",
      returnTo: "/tools",
    }),
    /does not require authorization/,
  );
  await registry.close();
});
