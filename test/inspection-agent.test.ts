import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import { defineGenerationEngine } from "../src/generation-engine.js";
import type { GeneratorInput, GeneratorOutput } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 12,
  inputTokenDetails: { noCacheTokens: 12, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 8,
  outputTokenDetails: { textTokens: 8, reasoningTokens: 0 },
  totalTokens: 20,
};

function sourceProject(): GeneratorOutput {
  const content = "export const answer = 42;\n";
  return {
    kind: "project",
    title: "Answer app",
    summary: "Created the initial source version.",
    files: [{
      path: "src/index.ts",
      content,
      mediaType: "text/typescript",
      size: Buffer.byteLength(content),
      checksum: sha256(content),
      locked: false,
    }],
    usage,
    finishReason: "stop",
  };
}

test("persists read-only inspections without creating a source version", async () => {
  const calls: GeneratorInput<"farmjs">[] = [];
  const engine = defineGenerationEngine<"farmjs">({
    identity: { provider: "fixture-agent", model: "fixture-v1" },
    async generate(input) {
      calls.push(input);
      if (input.operation === "inspect") {
        assert.equal(input.previousFiles[0]?.path, "src/index.ts");
        return {
          kind: "message",
          content: "`src/index.ts` exports `answer` with the value 42.",
          usage,
          finishReason: "stop",
        };
      }
      return sourceProject();
    },
  });
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    { framework: "farmjs", engine },
    { repository, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "inspection-tenant", userId: "inspection-user" })
    .chats.create({ title: "Inspection" });
  const version = await chat.generate({ prompt: "Create an answer module" });
  const message = await version.inspect({ prompt: "What does the source export?" });

  assert.equal(message.content, "`src/index.ts` exports `answer` with the value 42.");
  assert.equal(message.finishReason, "stop");
  assert.equal((await chat.listVersions()).items.length, 1);
  const messages = (await chat.listMessages()).items;
  assert.equal(messages.length, 4);
  const inspectionGeneration = await chat.getGeneration(message.generationId!);
  assert.equal((await inspectionGeneration.data()).configuration.operation, "inspect");
  assert.equal((await inspectionGeneration.wait()).status, "responded");
  assert.deepEqual(calls.map((call) => call.operation), ["change", "inspect"]);
  await viby.close();
});

test("rejects source output from a read-only inspection", async () => {
  const engine = defineGenerationEngine<"farmjs">({
    identity: { provider: "malicious-fixture", model: "fixture-v1" },
    async generate(input) {
      if (input.operation === "inspect") {
        return {
          kind: "changes",
          title: "Should not persist",
          summary: "Attempted a write.",
          changes: [{ type: "write", path: "src/index.ts", content: "changed\n" }],
          usage,
          finishReason: "stop",
        };
      }
      return sourceProject();
    },
  });
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    { framework: "farmjs", engine },
    { repository, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "guard-tenant", userId: "guard-user" })
    .chats.create();
  const version = await chat.generate({ prompt: "Create source" });
  const inspection = await version.startInspection({ prompt: "Inspect and secretly edit" });
  const outcome = await inspection.wait({ pollIntervalMs: 10 });

  assert.equal(outcome.status, "failed");
  if (outcome.status === "failed") assert.match(outcome.error, /must return a message/);
  assert.equal((await chat.listVersions()).items.length, 1);
  await viby.close();
});

test("requires a source version before chat inspection", async () => {
  const engine = defineGenerationEngine<"farmjs">({
    identity: { provider: "fixture-agent", model: "fixture-v1" },
    async generate() { return sourceProject(); },
  });
  const viby = createVibyWithDependencies(
    { framework: "farmjs", engine },
    { repository: new MemoryRepository(), skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "empty-tenant", userId: "empty-user" })
    .chats.create();
  await assert.rejects(() => chat.inspect({ prompt: "What is here?" }), /existing project version/);
  await viby.close();
});
