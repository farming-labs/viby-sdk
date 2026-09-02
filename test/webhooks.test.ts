import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import { createVibyApi } from "../src/api-host.js";
import { createVibyWebClient } from "../src/web-client.js";
import type { GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { verifySignedOutboundEvent } from "../src/outbound-events.js";
import { SkillResolver } from "../src/skills.js";
import { sha256 } from "../src/utils.js";
import { ConfigurationError, OutboundEventDeliveryError } from "../src/errors.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import { MemorySecretStore } from "./helpers/memory-integration-store.js";

const usage: LanguageModelUsage = {
  inputTokens: 2,
  inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 3,
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  totalTokens: 5,
};

const generator: ProjectGenerator<"farm"> = {
  async generate(): Promise<GeneratorOutput> {
    const content = "export const ready = true;\n";
    return {
      kind: "project",
      title: "Webhook project",
      summary: "Generated for durable webhook tests.",
      files: [{
        path: "src/index.ts",
        content,
        mediaType: "text/typescript",
        size: new TextEncoder().encode(content).byteLength,
        checksum: sha256(content),
        locked: false,
      }],
      usage,
      finishReason: "stop",
    };
  },
};

function setup(fetch: typeof globalThis.fetch) {
  const repository = new MemoryRepository();
  const secrets = new MemorySecretStore();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/webhooks" as LanguageModel,
      storage: { secrets },
      events: { webhooks: { fetch, source: "viby://tests/webhooks" } },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  return { viby, repository, secrets };
}

test("creates tenant-scoped webhooks and returns signing secrets exactly once", async () => {
  const { viby, secrets } = setup(async () => new Response(null, { status: 204 }));
  const owner = viby.forUser({ tenantId: "tenant", userId: "owner" });
  const outsider = viby.forUser({ tenantId: "tenant", userId: "outsider" });
  const created = await owner.webhooks.create({
    name: "Product events",
    url: "https://hooks.example.test/viby",
  });

  assert.match(created.signingSecret, /^whsec_/);
  assert.equal("signingSecret" in created.webhook, false);
  assert.equal("secretRef" in created.webhook, false);
  assert.equal((await owner.webhooks.list()).length, 1);
  assert.equal((await outsider.webhooks.list()).length, 0);
  assert.equal(secrets.secrets.size, 1);

  const paused = await owner.webhooks.pause(created.webhook.id);
  assert.equal(paused.status, "paused");
  assert.equal((await owner.webhooks.resume(created.webhook.id)).status, "active");
  const rotated = await owner.webhooks.rotateSecret(created.webhook.id);
  assert.notEqual(rotated.signingSecret, created.signingSecret);
  assert.notEqual(rotated.webhook.keyId, created.webhook.keyId);
  assert.equal(secrets.secrets.size, 1);
  assert.equal(await owner.webhooks.delete(created.webhook.id), true);
  assert.equal(await owner.webhooks.delete(created.webhook.id), false);
  assert.equal(secrets.secrets.size, 0);
  await viby.close();
});

test("delivers selected generation events with durable cursors and valid signatures", async () => {
  const requests: Array<{ body: string; headers: Record<string, string> }> = [];
  const { viby } = setup(async (_input, init) => {
    requests.push({
      body: String(init?.body ?? ""),
      headers: Object.fromEntries(new Headers(init?.headers)),
    });
    return new Response(null, { status: 204 });
  });
  const user = viby.forUser({ tenantId: "tenant", userId: "user" });
  const created = await user.webhooks.create({
    name: "Terminal events",
    url: "https://hooks.example.test/generations",
    events: ["generation.succeeded"],
  });
  const chat = await user.chats.create();
  const generation = await chat.start({ prompt: "Build a small project" });
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");

  const first = await user.webhooks.deliver(created.webhook.id, generation.id);
  assert.equal(first.deliveries.length, 1);
  assert.equal(first.hasMore, false);
  assert.notEqual(first.cursor, "0");
  const second = await user.webhooks.deliver(created.webhook.id, generation.id);
  assert.equal(second.deliveries.length, 0);
  assert.equal(requests.length, 1);

  const envelope = verifySignedOutboundEvent(requests[0]!, {
    secret: created.signingSecret,
    keyId: created.webhook.keyId,
  });
  assert.equal(envelope.type, "dev.viby.generation.generation.succeeded");
  assert.equal(envelope.data.tenantId, "tenant");
  assert.equal(envelope.data.userId, "user");
  assert.equal(envelope.data.generationId, generation.id);
  const records = await user.webhooks.deliveries(created.webhook.id, generation.id);
  assert.equal(records.length, 1);
  assert.equal(records[0]?.status, "delivered");
  await viby.close();
});

test("persists webhook dead letters and redrives them explicitly", async () => {
  let fail = true;
  const { viby } = setup(async () => {
    if (fail) return new Response("unavailable", { status: 503 });
    return new Response(null, { status: 204 });
  });
  const user = viby.forUser({ tenantId: "tenant-retry", userId: "user-retry" });
  const created = await user.webhooks.create({
    name: "Retry events",
    url: "https://hooks.example.test/retry",
    events: ["generation.succeeded"],
  });
  const generation = await (await user.chats.create()).start({ prompt: "Build it" });
  await generation.wait({ pollIntervalMs: 10 });

  await assert.rejects(
    user.webhooks.deliver(created.webhook.id, generation.id, {
      retry: { maxAttempts: 1, initialDelayMs: 0 },
    }),
    OutboundEventDeliveryError,
  );
  const [deadLetter] = await user.webhooks.deliveries(created.webhook.id, generation.id, {
    status: "dead_lettered",
  });
  assert.ok(deadLetter);
  await user.webhooks.redrive(created.webhook.id, generation.id, deadLetter.eventCursor);
  fail = false;
  const delivered = await user.webhooks.deliver(created.webhook.id, generation.id);
  assert.equal(delivered.deliveries.length, 1);
  assert.equal((await user.webhooks.deliveries(created.webhook.id, generation.id))[0]?.status, "delivered");
  await viby.close();
});

test("rejects unsafe webhook endpoints and disabled webhook collections", async () => {
  const { viby } = setup(async () => new Response(null, { status: 204 }));
  const webhooks = viby.forUser({ tenantId: "tenant", userId: "user" }).webhooks;
  await assert.rejects(
    webhooks.create({ name: "Local", url: "https://127.0.0.1/hook" }),
    ConfigurationError,
  );
  await assert.rejects(
    webhooks.create({ name: "HTTP", url: "http://hooks.example.test/hook" }),
    ConfigurationError,
  );
  await viby.close();

  const disabled = createVibyWithDependencies(
    { framework: "farm", model: "test/disabled" as LanguageModel },
    {
      repository: new MemoryRepository(),
      generator,
      skillResolver: new SkillResolver({}),
    },
  );
  await assert.rejects(
    disabled.forUser({ tenantId: "tenant", userId: "user" }).webhooks.list(),
    ConfigurationError,
  );
  await disabled.close();
});

test("exposes durable webhooks through the Web API and portable client", async () => {
  const received: string[] = [];
  const { viby } = setup(async (_input, init) => {
    received.push(String(init?.body ?? ""));
    return new Response(null, { status: 204 });
  });
  const scope = { tenantId: "web-tenant", userId: "web-user" };
  const api = createVibyApi({ viby, authenticate: () => scope });
  const client = createVibyWebClient<"farm">({
    baseUrl: "https://app.example/api/viby",
    fetch: (input, init) => api.fetch(new Request(input, init)),
  });
  const created = await client.webhooks.create({
    name: "Browser events",
    url: "https://hooks.example.test/browser",
    events: ["generation.succeeded"],
  });
  assert.match(created.result.signingSecret, /^whsec_/);
  assert.equal((await client.webhooks.list()).webhooks.length, 1);
  assert.equal((await client.webhooks.pause(created.result.webhook.id)).webhook.status, "paused");
  await client.webhooks.resume(created.result.webhook.id);

  const direct = viby.forUser(scope);
  const generation = await (await direct.chats.create()).start({ prompt: "Build a web project" });
  await generation.wait({ pollIntervalMs: 10 });
  const delivered = await client.webhooks.deliver(created.result.webhook.id, generation.id);
  assert.equal(delivered.delivery.deliveries.length, 1);
  assert.equal(received.length, 1);
  assert.equal(
    (await client.webhooks.deliveries(created.result.webhook.id, generation.id)).deliveries[0]?.status,
    "delivered",
  );
  await viby.close();
});
