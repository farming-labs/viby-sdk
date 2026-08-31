import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import {
  defineGenerationEngine,
  type GenerationEngine,
} from "../src/generation-engine.js";
import {
  GenerationEngineConformanceError,
  verifyGenerationEngine,
} from "../src/generation-engine-conformance.js";
import type { GeneratorInput, GeneratorOutput } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 1,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 1,
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  totalTokens: 2,
};

const input: GeneratorInput<"farm"> = {
  framework: "farm",
  prompt: "Build a small app",
  messages: [],
  previousFiles: [],
  skills: [],
  tasks: [],
};

function projectOutput(): GeneratorOutput {
  const content = "export const app = true;\n";
  return {
    kind: "project",
    title: "Custom runtime app",
    summary: "Generated outside the AI SDK shortcut.",
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

test("runs a custom generation engine without an AI SDK model", async () => {
  const calls: GeneratorInput<"farm">[] = [];
  const runs: unknown[] = [];
  let closed = 0;
  const engine = defineGenerationEngine<"farm">({
    identity: { provider: "custom-runtime", model: "design-agent-v1" },
    async generate(generationInput, options) {
      options?.signal?.throwIfAborted();
      calls.push(generationInput);
      runs.push(options?.run);
      return projectOutput();
    },
    async close() { closed += 1; },
  });
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      generation: { engine, engines: { same: engine } },
    },
    { repository, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.create();
  const version = await chat.generate({ prompt: "Use my custom agent" });
  const generation = await version.generation();

  assert.equal(calls.length, 1);
  assert.deepEqual(runs, [{
    tenantId: "tenant",
    userId: "user",
    chatId: chat.id,
    generationId: generation?.id,
    attemptId: generation?.activeAttemptId,
  }]);
  assert.equal(generation?.modelProvider, "custom-runtime");
  assert.equal(generation?.modelId, "design-agent-v1");
  await viby.close();
  assert.equal(closed, 1);
});

test("verifies provider-neutral generation engine behavior", async () => {
  const engine = defineGenerationEngine<"farm">({
    identity: { provider: "fixture", model: "fixture-v1" },
    capabilities: { steering: true },
    async generate(_input, options) {
      options?.signal?.throwIfAborted();
      await options?.steering?.consume();
      return projectOutput();
    },
  });
  const report = await verifyGenerationEngine({
    engine,
    scenarios: [{ name: "new-project", input, expected: "project" }],
  });

  assert.deepEqual(report.identity, { provider: "fixture", model: "fixture-v1" });
  assert.deepEqual(report.capabilities, {
    operations: ["change"],
    streaming: false,
    steering: true,
    traces: false,
    toolCalls: false,
    artifacts: false,
  });
  assert.deepEqual(report.checks, ["identity", "new-project", "steering", "cancellation"]);
});

test("capability-gates unsupported inspection before invoking an engine", async () => {
  let calls = 0;
  const engine = defineGenerationEngine<"farm">({
    identity: { provider: "fixture", model: "changes-only" },
    async generate() {
      calls += 1;
      return projectOutput();
    },
  });
  const viby = createVibyWithDependencies(
    { framework: "farm", generation: { engine } },
    { repository: new MemoryRepository(), skillResolver: new SkillResolver({}) },
  );
  const chat = await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.create();
  const version = await chat.generate({ prompt: "Create source" });

  await assert.rejects(
    () => version.startInspection({ prompt: "Inspect source" }),
    /does not support inspect operations/,
  );
  assert.equal(calls, 1);
  await viby.close();
});

test("keeps the top-level engine as a compatibility alias", async () => {
  const engine = defineGenerationEngine<"farm">({
    identity: { provider: "fixture", model: "legacy" },
    async generate() { return projectOutput(); },
  });
  const viby = createVibyWithDependencies(
    { framework: "farm", engine },
    { repository: new MemoryRepository(), skillResolver: new SkillResolver({}) },
  );
  const chat = await viby.forUser({ tenantId: "tenant", userId: "legacy" }).chats.create();
  const version = await chat.generate({ prompt: "Create source" });
  assert.equal((await version.generation())?.modelId, "legacy");
  await viby.close();
});

test("rejects engines that violate the portable output contract", async () => {
  const engine: GenerationEngine<"farm"> = {
    identity: { provider: "fixture", model: "broken" },
    async generate(_input, options) {
      options?.signal?.throwIfAborted();
      return { ...projectOutput(), files: [] } as GeneratorOutput;
    },
  };
  await assert.rejects(
    () => verifyGenerationEngine({
      engine,
      scenarios: [{ name: "new-project", input, expected: "project" }],
    }),
    GenerationEngineConformanceError,
  );
});

test("validates custom generation engine identities", () => {
  assert.throws(
    () => defineGenerationEngine({
      identity: { provider: " ", model: "agent" },
      async generate() { return projectOutput(); },
    }),
    /provider/,
  );
  assert.throws(
    () => defineGenerationEngine({
      identity: { provider: "fixture", model: "invalid-capabilities" },
      capabilities: { operations: [] },
      async generate() { return projectOutput(); },
    }),
    /operations cannot be empty/,
  );
});
