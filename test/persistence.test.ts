import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { createViby } from "../src/client.js";
import {
  verifyPersistenceAdapter,
} from "../src/persistence-conformance.js";
import { postgresPersistence } from "../src/persistence-postgres.js";
import type { PersistenceAdapter } from "../src/persistence.js";
import type { GeneratorOutput } from "../src/generator.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 1,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 1,
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  totalTokens: 2,
};

function projectOutput(): GeneratorOutput {
  const content = "export const persistence = 'custom';\n";
  return {
    kind: "project",
    title: "Custom persistence",
    summary: "Generated without a PostgreSQL URL.",
    files: [{
      path: "src/index.ts",
      content,
      mediaType: "text/javascript",
      size: Buffer.byteLength(content),
      checksum: sha256(content),
      locked: false,
    }],
    usage,
    finishReason: "stop",
  };
}

test("uses a custom persistence adapter without requiring DATABASE_URL", async () => {
  const persistence = new MemoryRepository();
  const adapter: PersistenceAdapter = persistence;
  const viby = createViby({
    framework: "custom-runtime",
    persistence: adapter,
    engine: {
      identity: { provider: "test", model: "custom-persistence" },
      async generate(_input, options) {
        options?.signal?.throwIfAborted();
        return projectOutput();
      },
    },
  });
  const version = await (await viby
    .forUser({ tenantId: "tenant", userId: "user" })
    .chats.create())
    .generate({ prompt: "Use the supplied durable backend" });

  assert.equal(version.framework, "custom-runtime");
  assert.equal(persistence.versions.has(version.id), true);
  await viby.close();
});

test("passes the provider-neutral persistence conformance suite", async () => {
  const report = await verifyPersistenceAdapter({
    create: () => new MemoryRepository(),
  });
  assert.deepEqual(report.checks, [
    "readiness",
    "chat-metadata",
    "durable-generation",
    "event-cursors",
    "source-history",
    "generated-artifacts",
    "design-evaluations",
    "tenant-isolation",
    "retention-purge",
    "close",
  ]);
});

test("validates explicit PostgreSQL persistence configuration", () => {
  assert.throws(
    () => postgresPersistence({ databaseUrl: "" }),
    /DATABASE_URL is required/,
  );
});

test("rejects ambiguous artifact storage with custom persistence", () => {
  assert.throws(() => createViby({
    framework: "custom-runtime",
    persistence: new MemoryRepository(),
    artifactStore: {
      id: "unused",
      async put() {},
      async get() { return null; },
      async delete() {},
    },
    engine: {
      identity: { provider: "test", model: "ambiguous-storage" },
      async generate() { return projectOutput(); },
    },
  }), /custom persistence adapter owns artifact references/);
});
