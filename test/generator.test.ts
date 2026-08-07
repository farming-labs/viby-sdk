import assert from "node:assert/strict";
import { test } from "node:test";
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

test("generates and validates a complete structured source project through AI SDK", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
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
  }));

  const output = await generator.generate({
    framework: "farm",
    prompt: "Build a dashboard",
    messages: [],
    previousFiles: [],
    skills: [],
  });

  assert.equal(output.title, "Farm dashboard");
  assert.deepEqual(output.files.map((file) => file.path), ["package.json", "src/index.tsx"]);
  assert.equal(output.files[1]?.mediaType, "text/javascript");
  assert.equal(output.usage.totalTokens, 36);
});

test("rejects unsafe paths even when the model returns schema-valid JSON", async () => {
  const generator = new AiProjectGenerator<"farm">(createMockModel({
    title: "Unsafe project",
    summary: "Should be rejected.",
    files: [{ path: "../.env", content: "SECRET=value", mediaType: null }],
  }));

  await assert.rejects(() => generator.generate({
    framework: "farm",
    prompt: "Build a project",
    messages: [],
    previousFiles: [],
    skills: [],
  }));
});
