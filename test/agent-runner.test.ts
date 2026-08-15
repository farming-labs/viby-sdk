import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { AgentProjectGenerator, normalizeAgentRunnerConfig } from "../src/agent-runner.js";
import { SandboxSession, sandboxCapabilities } from "../src/sandbox.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function toolCall(
  toolCallId: string,
  toolName: string,
  input: unknown,
  callUsage = usage,
) {
  return {
    content: [{
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: callUsage,
    warnings: [],
  };
}

test("preserves validated iteration edits when a provider ends on a tool call", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: toolCall("write-only", "workspace_write_file", {
      path: "src/index.ts",
      content: "export const recovered = true;\n",
      mediaType: "text/javascript",
    }),
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 1,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
  });

  const output = await generator.generate({
    framework: "farm",
    prompt: "Update the project",
    messages: [],
    previousFiles: [{
      path: "src/index.ts",
      content: "export const recovered = false;\n",
      mediaType: "text/javascript",
      size: 32,
      checksum: "before",
      locked: false,
    }],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "changes");
  if (output.kind !== "changes") throw new Error("Expected recovered change output");
  assert.deepEqual(output.changes, [{
    type: "write",
    path: "src/index.ts",
    content: "export const recovered = true;\n",
    mediaType: "text/javascript",
  }]);
  assert.match(output.summary, /1 validated workspace change/);
});

test("reserves a completion turn after the token budget is reached", async () => {
  const budgetUsage = {
    inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 200, text: 200, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("write-budget", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const finalized = true;\n",
        mediaType: "text/javascript",
      }, budgetUsage),
      completion("Finalized project", "Completed after reaching the tool budget."),
    ],
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 4,
    maxDurationMs: 10_000,
    maxTokens: 1_000,
  });

  const output = await generator.generate({
    framework: "farm",
    prompt: "Build a project",
    messages: [],
    previousFiles: [],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "project");
  assert.equal(model.doGenerateCalls.length, 2);
  assert.equal(model.doGenerateCalls[1]?.tools, undefined);
  assert.equal(model.doGenerateCalls[1]?.toolChoice?.type, "none");
});

function completion(title: string, summary: string) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ outcome: "complete", title, summary, task: null }),
    }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

test("uses workspace tools in the default bounded agent loop", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("write-1", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const app = true;\n",
        mediaType: "text/javascript",
      }),
      completion("Agent project", "Created through workspace tools."),
    ],
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 4,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
  });
  const output = await generator.generate({
    framework: "farm",
    prompt: "Build a project",
    messages: [],
    previousFiles: [],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "project");
  if (output.kind !== "project") throw new Error("Expected project output");
  assert.equal(output.files[0]?.path, "src/index.ts");
  assert.equal(output.files[0]?.content, "export const app = true;\n");
  assert.equal(output.usage.totalTokens, 60);
  assert.equal(model.doGenerateCalls.length, 2);
});

test("gates sandbox tools by capabilities and enforces the command budget", async () => {
  let commandRuns = 0;
  const sandbox = new SandboxSession(
    "bounded-test",
    sandboxCapabilities({ files: true, commands: true }),
    {
      id: "bounded-sandbox",
      writeFiles: async () => {},
      run: async () => {
        commandRuns += 1;
        return { exitCode: 0, stdout: "ok\n", stderr: "", durationMs: 1 };
      },
      readFile: async () => new Uint8Array(),
      stop: async () => {},
    },
  );
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("command-1", "sandbox_run_command", {
        command: "npm",
        args: ["test"],
        cwd: null,
        timeoutMs: null,
      }),
      toolCall("command-2", "sandbox_run_command", {
        command: "npm",
        args: ["test"],
        cwd: null,
        timeoutMs: null,
      }),
      toolCall("write-2", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const app = 2;\n",
        mediaType: "text/javascript",
      }),
      completion("Bounded iteration", "Verified the allowed command and updated source."),
    ],
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 8,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
    maxCommands: 1,
    commandTimeoutMs: 500,
  });
  const output = await generator.generate({
    framework: "farm",
    prompt: "Verify and update the project",
    messages: [],
    previousFiles: [{
      path: "src/index.ts",
      content: "export const app = 1;\n",
      mediaType: "text/javascript",
      size: 22,
      checksum: "before",
      locked: false,
    }],
    skills: [],
    tasks: [],
    sandbox,
  });

  assert.equal(output.kind, "changes");
  assert.equal(commandRuns, 1);
  const sentTools = model.doGenerateCalls[0]?.tools?.map((candidate) => candidate.name) ?? [];
  assert.ok(sentTools.includes("sandbox_read_file"));
  assert.ok(sentTools.includes("sandbox_run_command"));
  assert.equal(sentTools.includes("sandbox_get_url"), false);
});

test("validates all agent execution limits", () => {
  assert.throws(() => normalizeAgentRunnerConfig({ maxSteps: 0 }), /agent.maxSteps/);
  assert.throws(() => normalizeAgentRunnerConfig({ maxDurationMs: 999 }), /maxDurationMs/);
  assert.throws(() => normalizeAgentRunnerConfig({ maxTokens: 999 }), /maxTokens/);
  assert.throws(() => normalizeAgentRunnerConfig({ maxCommands: -1 }), /maxCommands/);
  assert.throws(() => normalizeAgentRunnerConfig({ commandTimeoutMs: 99 }), /commandTimeoutMs/);
  assert.throws(() => normalizeAgentRunnerConfig({ sandboxPorts: [3000, 3000] }), /duplicates/);
});
