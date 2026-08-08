import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import { GenerationStateError } from "../src/errors.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import type { GenerationTaskRequest, VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 12,
  inputTokenDetails: {
    noCacheTokens: 12,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 24,
  outputTokenDetails: { textTokens: 24, reasoningTokens: 0 },
  totalTokens: 36,
};

function projectOutput(version: number): GeneratorOutput {
  const content = `export const version = ${version};\n`;
  const files: VersionFile[] = [{
    path: "src/index.ts",
    content,
    mediaType: "text/javascript",
    size: Buffer.byteLength(content),
    checksum: sha256(content),
  }];
  return {
    kind: "project",
    title: "Durable dashboard",
    summary: `Generated version ${version}`,
    files,
    usage,
    finishReason: "stop",
  };
}

function taskOutput(task: GenerationTaskRequest): GeneratorOutput {
  return { kind: "task", task, usage, finishReason: "stop" };
}

function setup(generator: ProjectGenerator<"farm">) {
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      skills: {},
    },
    {
      repository,
      generator,
      skillResolver: new SkillResolver({}),
    },
  );
  return { repository, viby };
}

test("starts asynchronously, persists streamed deltas, and resumes from an event cursor", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const generator: ProjectGenerator<"farm"> = {
    async generate(_input, options) {
      await options?.onDelta?.("first-delta");
      await gate;
      await options?.onDelta?.("second-delta");
      return projectOutput(1);
    },
  };
  const { viby } = setup(generator);
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();

  const generation = await chat.start({ prompt: "Build a dashboard" });
  await waitUntil(async () => (await generation.data()).status === "running");
  assert.equal((await generation.data()).status, "running");

  const streamed: string[] = [];
  const streamDone = (async () => {
    for await (const event of generation.stream({ pollIntervalMs: 10 })) {
      streamed.push(event.type);
    }
  })();
  release();
  const outcome = await generation.wait({ pollIntervalMs: 10 });
  await streamDone;

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(
    streamed.filter((type) => type === "output.delta"),
    ["output.delta", "output.delta"],
  );

  const firstPage = await generation.events({ limit: 3 });
  assert.equal(firstPage.events.length, 3);
  assert.ok(firstPage.nextCursor);
  const resumed = await generation.events({ after: firstPage.nextCursor!, limit: 100 });
  assert.ok(resumed.events.length > 0);
  assert.ok(
    resumed.events.every((event) => BigInt(event.cursor) > BigInt(firstPage.nextCursor!)),
  );
  await viby.close();
});

test("cancels a running model call and durably records cancellation", async () => {
  let observedAbort = false;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => { markStarted = resolve; });
  const generator: ProjectGenerator<"farm"> = {
    async generate(_input, options) {
      await new Promise<void>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) throw new Error("Expected an abort signal");
        markStarted();
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason);
        }, { once: true });
      });
      return projectOutput(1);
    },
  };
  const { viby } = setup(generator);
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a dashboard" });
  await started;

  await generation.cancel("Stopped from the product UI.");
  const outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "cancelled");
  assert.equal(observedAbort, true);
  assert.equal((await generation.attempts())[0]?.status, "cancelled");
  const events = (await generation.events({ limit: 100 })).events;
  assert.ok(events.some((event) => event.type === "generation.cancelled"));
  await viby.close();
});

test("retries a failed generation as a new immutable attempt", async () => {
  let calls = 0;
  const generator: ProjectGenerator<"farm"> = {
    async generate() {
      calls += 1;
      if (calls === 1) throw new Error("temporary provider failure");
      return projectOutput(calls);
    },
  };
  const { viby } = setup(generator);
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a dashboard" });

  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "failed");
  await generation.retry();
  const outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(
    (await generation.attempts()).map((attempt) => [attempt.number, attempt.reason, attempt.status]),
    [[1, "initial", "failed"], [2, "retry", "succeeded"]],
  );
  await viby.close();
});

test("resumes a durable running record after its original process is gone", async () => {
  const repository = new MemoryRepository();
  const scope = { tenantId: "tenant-a", userId: "user-a" };
  const chat = await repository.createChat(scope, {
    id: "59d16c6e-d4e0-4e57-8101-0471568526f4",
    title: "Dashboard",
    metadata: {},
    framework: "farm",
  });
  const generationId = "a6c2b008-d89e-4874-a63a-b40d7f81b15d";
  const attemptId = "ac51f554-c238-4a62-a7cb-a0054640ba3c";
  await repository.createGeneration(scope, {
    id: generationId,
    attemptId,
    chatId: chat.id,
    baseVersionId: null,
    prompt: "Build a dashboard",
    modelProvider: "test",
    modelId: "test/mock",
  });
  await repository.startGenerationAttempt(scope, generationId, attemptId);

  const viby = createVibyWithDependencies(
    { framework: "farm", model: "test/mock" as LanguageModel, skills: {} },
    {
      repository,
      generator: { async generate() { return projectOutput(2); } },
      skillResolver: new SkillResolver({}),
    },
  );
  const generation = await viby.forUser(scope).generations.get(generationId);
  await generation.resume();
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");
  assert.deepEqual(
    (await generation.attempts()).map((attempt) => [attempt.reason, attempt.status]),
    [["initial", "interrupted"], ["resume", "succeeded"]],
  );
  await viby.close();
});

test("persists and resolves plan, question, and permission tasks before completing", async () => {
  const outputs: GeneratorOutput[] = [
    taskOutput({
      kind: "plan",
      title: "Approve the implementation plan",
      message: "Review the proposed implementation plan.",
      steps: ["Create the dashboard", "Verify loading states"],
    }),
    taskOutput({
      kind: "question",
      title: "Choose a data source",
      message: "Choose the dashboard data source.",
      question: "Which data source should be used?",
      choices: ["Postgres", "REST API"],
      allowFreeform: true,
    }),
    taskOutput({
      kind: "permission",
      title: "Authorize schema inspection",
      message: "Permission is required to inspect the schema.",
      action: "Inspect the application database schema",
      permissions: ["database:schema:read"],
    }),
    projectOutput(4),
  ];
  const calls: Array<GeneratorInput<"farm">> = [];
  const generator: ProjectGenerator<"farm"> = {
    async generate(input: GeneratorInput<"farm">, _options?: GeneratorOptions) {
      calls.push(input);
      const output = outputs.shift();
      if (!output) throw new Error("Missing output");
      return output;
    },
  };
  const { viby } = setup(generator);
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a dashboard" });

  let outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "waiting");
  if (outcome.status !== "waiting") throw new Error("Expected plan task");
  assert.equal(outcome.tasks[0]?.kind, "plan");
  await generation.resolve({
    taskId: outcome.tasks[0]!.id,
    resolution: { kind: "plan", decision: "approve" },
  });

  outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "waiting");
  if (outcome.status !== "waiting") throw new Error("Expected question task");
  assert.equal(outcome.tasks[0]?.kind, "question");
  await generation.resolve({
    taskId: outcome.tasks[0]!.id,
    resolution: { kind: "question", answer: "Postgres" },
  });

  outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "waiting");
  if (outcome.status !== "waiting") throw new Error("Expected permission task");
  assert.equal(outcome.tasks[0]?.kind, "permission");
  await generation.resolve({
    taskId: outcome.tasks[0]!.id,
    resolution: { kind: "permission", decision: "allow" },
  });

  outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "succeeded");
  assert.equal(calls[3]?.tasks.length, 3);
  assert.deepEqual(
    (await generation.tasks()).map((task) => [task.kind, task.status]),
    [["plan", "resolved"], ["question", "resolved"], ["permission", "resolved"]],
  );
  assert.deepEqual(
    (await generation.attempts()).map((attempt) => attempt.reason),
    ["initial", "task_resolution", "task_resolution", "task_resolution"],
  );
  await viby.close();
});

test("runs queued generations through a provider-neutral durable worker", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let started!: () => void;
  const running = new Promise<void>((resolve) => { started = resolve; });
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      skills: {},
      generation: { execution: "worker" },
    },
    {
      repository,
      generator: {
        async generate() {
          started();
          await gate;
          return projectOutput(1);
        },
      },
      skillResolver: new SkillResolver({}),
    },
  );
  const scope = { tenantId: "tenant-a", userId: "user-a" };
  const generation = await (await viby.forUser(scope).chats.create())
    .start({ prompt: "Build in a worker" });
  assert.equal((await generation.data()).status, "queued");

  const worker = viby.worker({
    id: "worker-a",
    leaseMs: 120,
    heartbeatMs: 30,
    pollIntervalMs: 10,
  });
  const work = worker.runOnce();
  await running;
  const firstHeartbeat = (await generation.attempts())[0]!.heartbeatAt;
  assert.ok(firstHeartbeat);
  await new Promise((resolve) => setTimeout(resolve, 70));
  const renewed = (await generation.attempts())[0]!;
  assert.equal(renewed.workerId, "worker-a");
  assert.ok(renewed.heartbeatAt!.getTime() > firstHeartbeat.getTime());
  assert.ok(renewed.leaseExpiresAt!.getTime() > Date.now());

  release();
  assert.equal(await work, true);
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");
  assert.equal(await worker.runOnce(), false);
  await viby.close();
});

test("fences stale workers and reclaims only expired generation leases", async () => {
  const repository = new MemoryRepository();
  const scope = { tenantId: "tenant-a", userId: "user-a" };
  const chat = await repository.createChat(scope, {
    id: "50d16c6e-d4e0-4e57-8101-0471568526f4",
    title: "Worker fencing",
    metadata: {},
    framework: "farm",
  });
  const generationId = "b6c2b008-d89e-4874-a63a-b40d7f81b15d";
  const attemptId = "bc51f554-c238-4a62-a7cb-a0054640ba3c";
  await repository.createGeneration(scope, {
    id: generationId,
    attemptId,
    chatId: chat.id,
    baseVersionId: null,
    prompt: "Build safely",
    modelProvider: "test",
    modelId: "test/mock",
  });
  const first = await repository.claimGenerationAttempt({
    workerId: "worker-a",
    leaseToken: "11111111-1111-4111-8111-111111111111",
    leaseMs: 100,
    framework: "farm",
    modelProvider: "test",
    modelId: "test/mock",
  });
  assert.ok(first);
  assert.equal(await repository.claimGenerationAttempt({
    workerId: "worker-b",
    leaseToken: "22222222-2222-4222-8222-222222222222",
    leaseMs: 100,
    framework: "farm",
    modelProvider: "test",
    modelId: "test/mock",
  }), null);
  await assert.rejects(
    () => repository.appendGenerationEvent(scope, {
      generationId,
      attemptId,
      leaseToken: "33333333-3333-4333-8333-333333333333",
      type: "output.delta",
      data: { delta: "stale" },
    }),
    GenerationStateError,
  );

  await new Promise((resolve) => setTimeout(resolve, 110));
  const second = await repository.claimGenerationAttempt({
    workerId: "worker-b",
    leaseToken: "22222222-2222-4222-8222-222222222222",
    leaseMs: 100,
    framework: "farm",
    modelProvider: "test",
    modelId: "test/mock",
  });
  assert.ok(second);
  assert.equal(await repository.heartbeatGenerationAttempt(first, 100), null);
  await assert.rejects(
    () => repository.appendGenerationEvent(scope, {
      generationId,
      attemptId,
      leaseToken: first.leaseToken,
      type: "output.delta",
      data: { delta: "old owner" },
    }),
    GenerationStateError,
  );
  await repository.appendGenerationEvent(scope, {
    generationId,
    attemptId,
    leaseToken: second.leaseToken,
    type: "output.delta",
    data: { delta: "current owner" },
  });
  assert.equal(
    repository.events.filter((event) => event.type === "output.delta").length,
    1,
  );
});

async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("Timed out waiting for condition.");
}
