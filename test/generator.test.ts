import assert from "node:assert/strict";
import { test } from "node:test";
import { simulateReadableStream } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AiProjectGenerator } from "../src/generator.js";

function createMockModel(project: unknown) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      content: [{ type: "text", text: JSON.stringify(project) }],
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: {
          total: 12,
          noCache: 12,
          cacheRead: undefined,
          cacheWrite: undefined,
        },
        outputTokens: {
          total: 24,
          text: 24,
          reasoning: undefined,
        },
      },
      warnings: [],
    }),
  });
}

function createStreamingMockModel(project: unknown) {
  const json = JSON.stringify(project);
  const middle = Math.floor(json.length / 2);
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start" as const, id: "text-1" },
          { type: "text-delta" as const, id: "text-1", delta: json.slice(0, middle) },
          { type: "text-delta" as const, id: "text-1", delta: json.slice(middle) },
          { type: "text-end" as const, id: "text-1" },
          {
            type: "finish" as const,
            finishReason: { unified: "stop" as const, raw: undefined },
            logprobs: undefined,
            usage: {
              inputTokens: {
                total: 12,
                noCache: 12,
                cacheRead: undefined,
                cacheWrite: undefined,
              },
              outputTokens: {
                total: 24,
                text: 24,
                reasoning: undefined,
              },
            },
          },
        ],
      }),
    }),
  });
}

test("generates and validates a complete structured source project through AI SDK", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
    outcome: "project",
    project: {
      title: "Farm dashboard",
      summary: "A complete dashboard.",
      files: [
        {
          path: "package.json",
          content: "{\"scripts\":{\"dev\":\"farm start\"}}",
          mediaType: "application/json",
        },
        {
          path: "src/index.tsx",
          content: "export function App() { return null }",
          mediaType: null,
        },
      ],
    },
    changes: null,
    task: null,
  }));

  const output = await generator.generate({
    framework: "farm",
    prompt: "Build a dashboard",
    messages: [],
    previousFiles: [],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "project");
  if (output.kind !== "project") throw new Error("Expected project output");
  assert.equal(output.title, "Farm dashboard");
  assert.deepEqual(output.files.map((file) => file.path), ["package.json", "src/index.tsx"]);
  assert.equal(output.files[1]?.mediaType, "text/javascript");
  assert.equal(output.usage.totalTokens, 36);
});

test("rejects unsafe paths even when the model returns schema-valid JSON", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
    outcome: "project",
    project: {
      title: "Unsafe project",
      summary: "Should be rejected.",
      files: [{ path: "../.env", content: "SECRET=value", mediaType: null }],
    },
    changes: null,
    task: null,
  }));

  await assert.rejects(() => generator.generate({
    framework: "farm",
    prompt: "Build a project",
    messages: [],
    previousFiles: [],
    skills: [],
    tasks: [],
  }));
});

test("rejects full-tree replacement output when iterating an existing version", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
    outcome: "project",
    project: {
      title: "Replacement",
      summary: "A full replacement that should not be accepted.",
      files: [{ path: "src/index.ts", content: "export {};\n", mediaType: null }],
    },
    changes: null,
    task: null,
  }));

  await assert.rejects(() => generator.generate({
    framework: "farm",
    prompt: "Update the project",
    messages: [],
    previousFiles: [{
      path: "src/index.ts",
      content: "export const before = true;\n",
      mediaType: "text/javascript",
      size: 28,
      checksum: "before",
    }],
    skills: [],
    tasks: [],
  }), /must return source changes/);
});

test("returns a typed question task when generation needs critical input", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
    outcome: "task",
    project: null,
    changes: null,
    task: {
      kind: "question",
      title: "Choose a data source",
      message: "Which data source should power the dashboard?",
      steps: [],
      question: "Which data source should power the dashboard?",
      choices: ["Postgres", "REST API"],
      allowFreeform: true,
      action: null,
      permissions: [],
    },
  }));

  const output = await generator.generate({
    framework: "farm",
    prompt: "Build a dashboard",
    messages: [],
    previousFiles: [],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "task");
  if (output.kind !== "task") throw new Error("Expected task output");
  assert.equal(output.task.kind, "question");
});

test("streams structured output deltas while retaining the validated final project", async () => {
  const generator = new AiProjectGenerator<"farm">(createStreamingMockModel({
    outcome: "project",
    project: {
      title: "Streaming dashboard",
      summary: "A streamed dashboard.",
      files: [{
        path: "src/index.ts",
        content: "export const streamed = true;",
        mediaType: null,
      }],
    },
    changes: null,
    task: null,
  }));
  const deltas: string[] = [];

  const output = await generator.generate({
    framework: "farm",
    prompt: "Build a streaming dashboard",
    messages: [],
    previousFiles: [],
    skills: [],
    tasks: [],
  }, {
    onDelta(delta) {
      deltas.push(delta);
    },
  });

  assert.equal(deltas.length, 2);
  assert.equal(output.kind, "project");
  if (output.kind !== "project") throw new Error("Expected project output");
  assert.equal(output.title, "Streaming dashboard");
  assert.equal(output.files[0]?.path, "src/index.ts");
});

test("returns validated immutable changes for an existing source version", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
    outcome: "changes",
    project: null,
    changes: {
      title: "Refined dashboard",
      summary: "Updated the entrypoint and documentation.",
      changes: [
        {
          type: "write",
          path: "./src/index.ts",
          content: "export const version = 2;\n",
          mediaType: "text/javascript",
          from: null,
          to: null,
        },
        {
          type: "move",
          path: null,
          content: null,
          mediaType: null,
          from: "README.md",
          to: "docs/README.md",
        },
      ],
    },
    task: null,
  }));

  const output = await generator.generate({
    framework: "farm",
    prompt: "Refine the dashboard",
    messages: [],
    previousFiles: [
      {
        path: "README.md",
        content: "# Dashboard\n",
        mediaType: "text/markdown",
        size: 12,
        checksum: "readme",
      },
      {
        path: "src/index.ts",
        content: "export const version = 1;\n",
        mediaType: "text/javascript",
        size: 26,
        checksum: "source",
      },
    ],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "changes");
  if (output.kind !== "changes") throw new Error("Expected changes output");
  assert.deepEqual(output.changes, [
    {
      type: "write",
      path: "src/index.ts",
      content: "export const version = 2;\n",
      mediaType: "text/javascript",
    },
    { type: "move", from: "README.md", to: "docs/README.md" },
  ]);
});
