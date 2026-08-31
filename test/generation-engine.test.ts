import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import {
  defineGenerationEngine,
  defineRemoteGenerationEngine,
  RemoteGenerationEngineError,
  type GenerationEngine,
} from "../src/generation-engine.js";
import type {
  GenerationEngineCheckpointData,
  GenerationEngineCheckpointChannel,
} from "../src/generator.js";
import {
  GenerationEngineConformanceError,
  verifyGenerationEngine,
} from "../src/generation-engine-conformance.js";
import type { GeneratorInput, GeneratorOutput } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import { defineToolSource } from "../src/tool-source.js";

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

test("adapts a resumable remote run into the generation engine contract", async () => {
  const deltas: string[] = [];
  const starts: unknown[] = [];
  const after: Array<string | null> = [];
  const engine = defineRemoteGenerationEngine<"farm">({
    identity: { provider: "remote-runtime", model: "frontend-agent-v2" },
    async start(_input, context) {
      starts.push(context.run);
      return { id: "remote-run-1", metadata: { region: "iad1" } };
    },
    async *events(_run, input) {
      after.push(input.after);
      yield { type: "output.delta", cursor: "event-1", delta: "Designing" };
      yield { type: "completed", cursor: "event-2", output: projectOutput() };
    },
  });
  const run = {
    tenantId: "tenant",
    userId: "user",
    chatId: "chat",
    generationId: "generation",
    attemptId: "attempt",
  };
  const output = await engine.generate(input, {
    run,
    onDelta(delta) { deltas.push(delta); },
  });

  assert.equal(output.kind, "project");
  assert.deepEqual(starts, [run]);
  assert.deepEqual(after, [null]);
  assert.deepEqual(deltas, ["Designing"]);
  assert.equal(engine.capabilities?.streaming, true);
});

test("rejects invalid remote event streams and cancels an aborted run", async () => {
  const controller = new AbortController();
  let cancelled = 0;
  const engine = defineRemoteGenerationEngine<"farm">({
    identity: { provider: "remote-runtime", model: "broken-agent" },
    async start() { return { id: "remote-run-2" }; },
    async *events() {
      yield { type: "output.delta", cursor: "same", delta: "one" } as const;
      controller.abort();
      yield { type: "output.delta", cursor: "same", delta: "two" } as const;
    },
    async cancel() { cancelled += 1; },
  });

  await assert.rejects(
    () => engine.generate(input, { signal: controller.signal }),
    (error: unknown) => error instanceof DOMException && error.name === "AbortError",
  );
  assert.equal(cancelled, 1);

  const repeated = defineRemoteGenerationEngine<"farm">({
    identity: { provider: "remote-runtime", model: "repeated-cursor" },
    async start() { return { id: "remote-run-3" }; },
    async *events() {
      yield { type: "output.delta", cursor: "same", delta: "one" } as const;
      yield { type: "completed", cursor: "same", output: projectOutput() } as const;
    },
  });
  await assert.rejects(
    () => repeated.generate(input),
    (error: unknown) => error instanceof RemoteGenerationEngineError && !error.retryable,
  );
});

test("resumes a remote run from a durable engine checkpoint", async () => {
  let checkpoint: GenerationEngineCheckpointData | null = null;
  let revision = 0;
  let starts = 0;
  const after: Array<string | null> = [];
  const channel: GenerationEngineCheckpointChannel = {
    async load() { return checkpoint; },
    async save(input) {
      revision += 1;
      const now = new Date();
      checkpoint = {
        generationId: "generation",
        attemptId: "attempt",
        revision,
        cursor: input.cursor ?? null,
        state: input.state,
        createdAt: checkpoint?.createdAt ?? now,
        updatedAt: now,
      };
      return checkpoint;
    },
    async clear() { checkpoint = null; },
  };
  const engine = defineRemoteGenerationEngine<"farm">({
    identity: { provider: "remote-runtime", model: "resumable-agent" },
    async start() {
      starts += 1;
      return { id: "remote-run-resume", metadata: { region: "iad1" } };
    },
    async *events(_run, input) {
      after.push(input.after);
      if (input.after === null) {
        yield { type: "output.delta", cursor: "event-1", delta: "Designing" } as const;
        return;
      }
      yield { type: "completed", cursor: "event-2", output: projectOutput() } as const;
    },
  });

  await assert.rejects(
    () => engine.generate(input, { checkpoint: channel }),
    (error: unknown) => error instanceof RemoteGenerationEngineError && error.retryable,
  );
  assert.equal((await channel.load())?.cursor, "event-1");

  const output = await engine.generate(input, { checkpoint: channel });
  assert.equal(output.kind, "project");
  assert.equal(starts, 1);
  assert.deepEqual(after, [null, "event-1"]);
  assert.equal(checkpoint, null);
});

test("projects authorized durable tools into a custom generation engine", async () => {
  let externalCalls = 0;
  const issues = defineToolSource<"farm">({
    id: "issues",
    async list() {
      return [{
        name: "create",
        description: "Create an issue.",
        inputSchema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
        effect: "external",
        permissions: ["issues.create"],
      }];
    },
    async call({ arguments: arguments_ }) {
      externalCalls += 1;
      return { id: "issue-1", title: arguments_.title ?? null };
    },
  });
  const engine = defineGenerationEngine<"farm">({
    identity: { provider: "custom-runtime", model: "tool-agent-v1" },
    capabilities: { toolCalls: true },
    async generate(_generationInput, options) {
      const [definition] = await options?.tools?.list() ?? [];
      assert.equal(definition?.name, "issues__create");
      const result = await options!.tools!.invoke({
        name: definition!.name,
        providerCallId: "custom-call-1",
        arguments: { title: "Fix navigation" },
      });
      assert.deepEqual(result, { id: "issue-1", title: "Fix navigation" });
      return projectOutput();
    },
  });
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      generation: { engine },
      tools: { sources: { issues } },
    },
    { repository, skillResolver: new SkillResolver({}) },
  );
  try {
    const chat = await viby
      .forUser({ tenantId: "tenant-tools", userId: "user-tools" })
      .chats.create();
    const generation = await chat.start({ prompt: "Create an issue and build the project" });
    let outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "waiting");
    if (outcome.status !== "waiting") throw new Error("Expected a tool approval task.");
    const [task] = outcome.tasks;
    assert.equal(task?.kind, "permission");
    if (!task || task.kind !== "permission") throw new Error("Expected a permission task.");
    assert.equal(task.proposedToolAction?.source, "issues");
    assert.equal(task.proposedToolAction?.tool, "create");
    assert.equal(externalCalls, 0);

    await generation.resolve({
      taskId: task.id,
      resolution: { kind: "permission", decision: "allow" },
    });
    outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    assert.equal(externalCalls, 1);
    const [toolCall] = await generation.toolCalls();
    assert.equal(toolCall?.name, "tool-source.issues.create");
    assert.equal(toolCall?.status, "succeeded");
    assert.equal(toolCall?.idempotencyKey, task.proposedToolAction?.idempotencyKey);
  } finally {
    await viby.close();
  }
});
