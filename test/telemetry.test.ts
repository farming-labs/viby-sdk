import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import {
  openTelemetry,
  type OpenTelemetryMeterLike,
  type OpenTelemetrySpanLike,
  type OpenTelemetryTracerLike,
  type TelemetryAttribute,
} from "../src/telemetry.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 4,
  inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 8,
  outputTokenDetails: { textTokens: 8, reasoningTokens: 0 },
  totalTokens: 12,
};

test("records OpenTelemetry spans, metrics, and durable cost across attempts", async () => {
  const spans: TestSpan[] = [];
  const metrics: TestMetric[] = [];
  const tracer: OpenTelemetryTracerLike = {
    startSpan(name, options) {
      const span = new TestSpan(name, options.attributes);
      spans.push(span);
      return span;
    },
  };
  const meter = testMeter(metrics);
  let run = 0;
  const generator: ProjectGenerator<"farm"> = {
    async generate(): Promise<GeneratorOutput> {
      run += 1;
      if (run === 1) {
        return {
          kind: "task",
          task: {
            kind: "plan",
            title: "Approve implementation",
            message: "Approve the implementation plan.",
            steps: ["Build the project"],
          },
          usage,
          finishReason: "stop",
        };
      }
      const content = "export const observed = true;\n";
      const file: VersionFile = {
        path: "src/index.ts",
        content,
        mediaType: "text/javascript",
        size: Buffer.byteLength(content),
        checksum: sha256(content),
        locked: false,
      };
      return {
        kind: "project",
        title: "Observed project",
        summary: "Generated with durable attribution.",
        files: [file],
        usage,
        finishReason: "stop",
      };
    },
  };
  const repository = new MemoryRepository();
  const costInputs: Array<Record<string, unknown>> = [];
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "openai/test-model" as LanguageModel,
      telemetry: openTelemetry({ tracer, meter }),
      cost: {
        currency: "usd",
        calculate(input) {
          costInputs.push({ ...input });
          return (input.totalTokens ?? 0) * 10;
        },
      },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );

  try {
    const user = viby.forUser({ tenantId: "tenant-observed", userId: "user-observed" });
    const chat = await user.chats.create();
    const generation = await chat.start({ prompt: "Build an observed project" });
    const waiting = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(waiting.status, "waiting");
    if (waiting.status !== "waiting") throw new Error("Expected a plan task");
    assert.deepEqual(waiting.generation.cost, { amountMicros: 120, currency: "USD" });

    await generation.resolve({
      taskId: waiting.tasks[0]!.id,
      resolution: { kind: "plan", decision: "approve" },
    });
    const completed = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(completed.status, "succeeded");
    if (completed.status !== "succeeded") throw new Error("Expected generation success");
    assert.deepEqual(completed.generation.cost, { amountMicros: 240, currency: "USD" });
    assert.deepEqual(
      (await generation.attempts()).map((attempt) => attempt.cost),
      [
        { amountMicros: 120, currency: "USD" },
        { amountMicros: 120, currency: "USD" },
      ],
    );

    const assistantUsage = (await chat.listMessages()).items
      .filter((message) => message.role === "assistant")
      .map((message) => message.parts.find((part) => part.type === "usage"))
      .map((part) => part?.type === "usage" ? part.data.cost : undefined);
    assert.deepEqual(assistantUsage, [
      { amountMicros: 120, currency: "USD" },
      { amountMicros: 120, currency: "USD" },
    ]);

    assert.equal(costInputs.length, 2);
    assert.ok(costInputs.every((input) => !Object.hasOwn(input, "prompt")));
    assert.deepEqual(costInputs[0], {
      tenantId: "tenant-observed",
      userId: "user-observed",
      chatId: chat.id,
      generationId: generation.id,
      attemptId: (await generation.attempts())[0]!.id,
      modelProvider: "openai",
      modelId: "openai/test-model",
      inputTokens: 4,
      outputTokens: 8,
      totalTokens: 12,
    });

    assert.equal(spans.length, 2);
    assert.ok(spans.every((span) => span.name === "viby.generation.attempt"));
    assert.ok(spans.every((span) => span.ended));
    assert.deepEqual(spans.map((span) => span.status?.code), [1, 1]);
    assert.deepEqual(
      spans.map((span) => span.attributes["viby.generation.outcome"]),
      ["waiting", "succeeded"],
    );
    assert.equal(metrics.filter((metric) => metric.name === "viby.generation.attempts").length, 2);
    assert.equal(metrics.filter((metric) => metric.name === "viby.generation.cost").length, 2);
    assert.equal(metrics.filter((metric) => metric.name === "viby.generation.tokens").length, 6);
    assert.equal(metrics.filter((metric) => metric.name === "viby.generation.duration").length, 2);
    assert.ok(metrics.every((metric) => !Object.hasOwn(metric.attributes, "viby.user.id")));
  } finally {
    await viby.close();
  }
});

test("keeps generation fail-open when telemetry or cost attribution fails", async () => {
  const content = "export {};\n";
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/fail-open" as LanguageModel,
      telemetry: {
        startSpan() {
          throw new Error("collector unavailable");
        },
        recordMetric() {
          throw new Error("collector unavailable");
        },
      },
      cost: { currency: "credits", calculate: () => -1 },
    },
    {
      repository,
      skillResolver: new SkillResolver({}),
      generator: {
        async generate(): Promise<GeneratorOutput> {
          return {
            kind: "project",
            title: "Fail open",
            summary: "Telemetry cannot break generation.",
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
        },
      },
    },
  );
  try {
    const chat = await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.create();
    const generation = await chat.start({ prompt: "Generate safely" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    assert.equal(outcome.generation.cost, null);
  } finally {
    await viby.close();
  }
});

class TestSpan implements OpenTelemetrySpanLike {
  readonly attributes: Record<string, TelemetryAttribute>;
  status: { code: number; message?: string } | undefined;
  readonly exceptions: unknown[] = [];
  ended = false;

  constructor(readonly name: string, attributes: Record<string, TelemetryAttribute>) {
    this.attributes = { ...attributes };
  }

  setAttributes(attributes: Record<string, TelemetryAttribute>): void {
    Object.assign(this.attributes, attributes);
  }

  setStatus(status: { code: number; message?: string }): void {
    this.status = status;
  }

  recordException(exception: unknown): void {
    this.exceptions.push(exception);
  }

  end(): void {
    this.ended = true;
  }
}

interface TestMetric {
  readonly name: string;
  readonly kind: "counter" | "histogram";
  readonly value: number;
  readonly attributes: Record<string, TelemetryAttribute>;
}

function testMeter(metrics: TestMetric[]): OpenTelemetryMeterLike {
  return {
    createCounter(name) {
      return {
        add(value, attributes = {}) {
          metrics.push({ name, kind: "counter", value, attributes });
        },
      };
    },
    createHistogram(name) {
      return {
        record(value, attributes = {}) {
          metrics.push({ name, kind: "histogram", value, attributes });
        },
      };
    },
  };
}
