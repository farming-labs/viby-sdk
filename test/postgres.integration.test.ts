import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { migrateDatabase } from "../src/migrations.js";
import { PostgresRepository } from "../src/postgres-repository.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const usage: LanguageModelUsage = {
  inputTokens: 8,
  inputTokenDetails: {
    noCacheTokens: 8,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 16,
  outputTokenDetails: { textTokens: 16, reasoningTokens: 0 },
  totalTokens: 24,
};

test("persists a durable generation, iteration, events, and download in Postgres", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);

  const repository = new PostgresRepository(databaseUrl);
  const calls: Array<GeneratorInput<"farm">> = [];
  const generator: ProjectGenerator<"farm"> = {
    async generate(input, options): Promise<GeneratorOutput> {
      calls.push(input);
      const number = calls.length;
      const content = `export const version = ${number};\n`;
      const files: VersionFile[] = [{
        path: "src/index.ts",
        content,
        mediaType: "text/javascript",
        size: Buffer.byteLength(content),
        checksum: sha256(content),
      }];
      await options?.onDelta?.(`version-${number}`);
      return {
        kind: "project",
        title: "Postgres integration",
        summary: `Generated version ${number}`,
        files,
        usage,
        finishReason: "stop",
      };
    },
  };
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/postgres" as LanguageModel,
      skills: {},
    },
    {
      repository,
      generator,
      skillResolver: new SkillResolver({}),
    },
  );
  const scope = {
    tenantId: `integration-${randomUUID()}`,
    userId: `integration-${randomUUID()}`,
  };

  try {
    const user = viby.forUser(scope);
    const chat = await user.chats.create({ title: "Postgres integration" });
    const generation = await chat.start({ prompt: "Build a durable Farm project" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") throw new Error("Expected a successful generation");

    const events = (await generation.events({ limit: 100 })).events;
    assert.deepEqual(events.map((event) => event.type), [
      "generation.created",
      "attempt.queued",
      "attempt.started",
      "output.delta",
      "attempt.succeeded",
      "generation.succeeded",
    ]);
    assert.deepEqual(
      (await generation.attempts()).map((attempt) => [attempt.number, attempt.status]),
      [[1, "succeeded"]],
    );

    const second = await outcome.version.iterate({ prompt: "Create a second version" });
    const persistedChat = await user.chats.get(chat.id);
    const persistedVersion = await persistedChat.getVersion(second.id);
    assert.equal(persistedVersion.number, 2);
    assert.equal(persistedVersion.parentVersionId, outcome.version.id);
    assert.equal((await persistedChat.listMessages()).items.length, 4);
    assert.equal((await persistedChat.listVersions()).items.length, 2);
    assert.equal(calls[1]?.previousFiles[0]?.content, "export const version = 1;\n");

    const artifact = await persistedVersion.download();
    const files = unzipSync(artifact.bytes);
    assert.equal(strFromU8(files["src/index.ts"]!), "export const version = 2;\n");

    const importedChat = await user.chats.import({
      title: "Imported Postgres project",
      source: {
        type: "zip",
        bytes: zipSync({
          "package.json": strToU8('{"name":"postgres-import"}\n'),
          "src/main.ts": strToU8("export const imported = true;\n"),
        }),
      },
    });
    const importedVersion = await importedChat.latestVersion();
    assert.ok(importedVersion);
    assert.equal(importedVersion.origin, "imported");
    assert.equal(importedVersion.generationId, null);
    assert.equal(await importedVersion.generation(), null);
    assert.equal((await importedVersion.files()).length, 2);

    const lease = await repository.createSandboxLease(scope, {
      id: randomUUID(),
      sandboxId: "provider-sandbox-id",
      provider: "integration-provider",
      context: {
        ...scope,
        chatId: importedVersion.chatId,
        versionId: importedVersion.id,
        framework: "farm",
      },
      ports: [3000],
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal((await user.sandboxes.get(lease.id)).sandboxId, "provider-sandbox-id");
    await repository.closeSandboxLease(scope, lease.id, "stopped");
    assert.equal((await user.sandboxes.get(lease.id)).status, "stopped");

    const editedVersion = await importedVersion.apply({
      changes: [
        { type: "write", path: "src/main.ts", content: "export const imported = 2;\n" },
        { type: "move", from: "package.json", to: "fixtures/package.json" },
      ],
    });
    assert.equal(editedVersion.origin, "edited");
    assert.equal(editedVersion.parentVersionId, importedVersion.id);
    assert.equal(editedVersion.number, 2);
    assert.equal((await importedVersion.files()).some((file) => file.path === "package.json"), true);
    assert.equal((await editedVersion.files()).some((file) => file.path === "fixtures/package.json"), true);

    const forkedChat = await importedVersion.fork({ title: "Postgres fork" });
    const forkedVersion = await forkedChat.latestVersion();
    assert.ok(forkedVersion);
    assert.equal(forkedVersion.origin, "forked");
    assert.equal(forkedVersion.parentVersionId, importedVersion.id);
    assert.equal((await forkedVersion.files()).some((file) => file.path === "package.json"), true);

    const restoredVersion = await importedVersion.restore();
    assert.equal(restoredVersion.origin, "restored");
    assert.equal(restoredVersion.number, 3);
    assert.equal(restoredVersion.parentVersionId, importedVersion.id);
    assert.equal((await restoredVersion.files()).some((file) => file.path === "package.json"), true);
    assert.equal((await editedVersion.files()).some((file) => file.path === "fixtures/package.json"), true);

    const updatedChat = await persistedChat.update({
      title: "Updated Postgres integration",
      metadata: { favorite: true, labels: ["integration", "postgres"] },
    });
    assert.deepEqual((await user.chats.get(updatedChat.id)).metadata, updatedChat.metadata);

    const messagePageOne = await updatedChat.listMessages({ limit: 2 });
    assert.equal(messagePageOne.items.length, 2);
    assert.ok(messagePageOne.nextCursor);
    const messagePageTwo = await updatedChat.listMessages({
      limit: 2,
      after: messagePageOne.nextCursor,
    });
    assert.equal(messagePageTwo.items.length, 2);
    assert.equal(messagePageTwo.nextCursor, null);

    const versionPageOne = await updatedChat.listVersions({ limit: 1 });
    assert.equal(versionPageOne.items.length, 1);
    assert.ok(versionPageOne.nextCursor);
    const versionPageTwo = await updatedChat.listVersions({
      limit: 1,
      after: versionPageOne.nextCursor,
    });
    assert.equal(versionPageTwo.items.length, 1);
    assert.equal(versionPageTwo.nextCursor, null);

    const chatPage = await user.chats.list({ limit: 1 });
    assert.equal(chatPage.items[0]?.id, updatedChat.id);
    assert.ok(chatPage.nextCursor);
  } finally {
    await viby.close();
  }
});
