import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { AgentProjectGenerator, normalizeAgentRunnerConfig } from "../src/agent-runner.js";
import type { AgentTraceWriter } from "../src/generator.js";
import { SandboxSession, sandboxCapabilities } from "../src/sandbox.js";
import type { FileEditMessagePartData } from "../src/types.js";

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function toolCall(toolCallId: string, toolName: string, input: unknown, callUsage = usage) {
  return {
    content: [
      {
        type: "tool-call" as const,
        toolCallId,
        toolName,
        input: JSON.stringify(input),
      },
    ],
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
    previousFiles: [
      {
        path: "src/index.ts",
        content: "export const recovered = false;\n",
        mediaType: "text/javascript",
        size: 32,
        checksum: "before",
        locked: false,
      },
    ],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "changes");
  if (output.kind !== "changes") throw new Error("Expected recovered change output");
  assert.deepEqual(output.changes, [
    {
      type: "write",
      path: "src/index.ts",
      content: "export const recovered = true;\n",
      mediaType: "text/javascript",
    },
  ]);
  assert.match(output.summary, /1 validated workspace change/);
});

test("reserves a completion turn after the token budget is reached", async () => {
  const budgetUsage = {
    inputTokens: { total: 900, noCache: 900, cacheRead: undefined, cacheWrite: undefined },
    outputTokens: { total: 200, text: 200, reasoning: undefined },
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall(
        "write-budget",
        "workspace_write_file",
        {
          path: "src/index.ts",
          content: "export const finalized = true;\n",
          mediaType: "text/javascript",
        },
        budgetUsage,
      ),
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
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ outcome: "complete", title, summary, task: null }),
      },
    ],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function taskCompletion() {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          outcome: "task",
          title: null,
          summary: null,
          task: {
            kind: "question",
            title: "Choose a follow-up",
            message: "A late question that must not discard completed edits.",
            steps: [],
            question: "Continue?",
            choices: ["Yes", "No"],
            allowFreeform: false,
            action: null,
            permissions: [],
          },
        }),
      },
    ],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

test("preserves staged edits when a provider returns an invalid late task", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("write-before-task", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const complete = true;\n",
        mediaType: "text/javascript",
      }),
      taskCompletion(),
    ],
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 4,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
  });

  const output = await generator.generate({
    framework: "farm",
    prompt: "Finish the project",
    messages: [],
    previousFiles: [
      {
        path: "src/index.ts",
        content: "export const complete = false;\n",
        mediaType: "text/javascript",
        size: 31,
        checksum: "before",
        locked: false,
      },
    ],
    skills: [],
    tasks: [],
  });

  assert.equal(output.kind, "changes");
  if (output.kind !== "changes") throw new Error("Expected recovered changes");
  assert.equal(output.changes[0]?.type, "write");
  assert.match(output.summary, /late task outcome/);
});

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

test("includes a bounded workspace inventory to avoid exploratory model turns", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("update-heading", "workspace_write_file", {
        path: "src/app/dashboard.tsx",
        content: "export default function Dashboard() { return 'Updated'; }\n",
        mediaType: "text/typescript",
      }),
      completion("Focused iteration", "Used the supplied workspace inventory."),
    ],
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 3,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
  });
  await generator.generate({
    framework: "farm",
    prompt: "Change the dashboard heading",
    messages: [],
    previousFiles: [
      {
        path: "src/app/dashboard.tsx",
        content: "export default function Dashboard() { return null; }\n",
        mediaType: "text/typescript",
        size: 53,
        checksum: "dashboard",
        locked: false,
      },
    ],
    skills: [],
    tasks: [],
  });

  assert.match(JSON.stringify(model.doGenerateCalls[0]?.prompt), /src\/app\/dashboard\.tsx/);
  assert.match(JSON.stringify(model.doGenerateCalls[0]?.prompt), /Read only files relevant/);
});

test("applies durable steering before the next default-agent step", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("write-steered", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const compact = true;\n",
        mediaType: "text/javascript",
      }),
      completion("Steered project", "Applied the live steering update."),
    ],
  });
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 4,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
  });
  let consumed = false;
  await generator.generate(
    {
      framework: "farm",
      prompt: "Build a project",
      messages: [],
      previousFiles: [],
      skills: [],
      tasks: [],
    },
    {
      steering: {
        async consume() {
          if (consumed) return [];
          consumed = true;
          return [
            {
              id: "steering-1",
              generationId: "generation-1",
              messageId: "message-1",
              submittedAttemptId: "attempt-1",
              appliedAttemptId: "attempt-1",
              prompt: "Use a compact navigation.",
              status: "applied",
              idempotencyKey: null,
              createdAt: new Date(),
              appliedAt: new Date(),
              attachments: [],
            },
          ];
        },
      },
    },
  );

  assert.match(JSON.stringify(model.doGenerateCalls[0]?.prompt), /Use a compact navigation/);
});

test("classifies workspace writes as created or updated in the agent trace", async () => {
  const model = new MockLanguageModelV4({
    doGenerate: [
      toolCall("update-existing", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const app = 2;\n",
        mediaType: "text/javascript",
      }),
      toolCall("create-new", "workspace_write_file", {
        path: "src/new.ts",
        content: "export const added = true;\n",
        mediaType: "text/javascript",
      }),
      completion("Classified edits", "Updated one file and added another."),
    ],
  });
  const completed: FileEditMessagePartData[] = [];
  const trace: AgentTraceWriter = {
    async start(type) {
      return {
        id: `part-${type}-${completed.length}`,
        type,
        async delta() {},
        async complete(data) {
          if (type === "file-edit") completed.push(data as FileEditMessagePartData);
        },
        async fail() {},
      };
    },
  };
  const generator = new AgentProjectGenerator<"farm">(model, {
    maxSteps: 4,
    maxDurationMs: 10_000,
    maxTokens: 10_000,
  });

  await generator.generate(
    {
      framework: "farm",
      prompt: "Update the project and add a module",
      messages: [],
      previousFiles: [
        {
          path: "src/index.ts",
          content: "export const app = 1;\n",
          mediaType: "text/javascript",
          size: 22,
          checksum: "before",
          locked: false,
        },
      ],
      skills: [],
      tasks: [],
    },
    { trace },
  );

  assert.deepEqual(completed, [
    { operation: "update", path: "src/index.ts" },
    { operation: "create", path: "src/new.ts" },
  ]);
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
    previousFiles: [
      {
        path: "src/index.ts",
        content: "export const app = 1;\n",
        mediaType: "text/javascript",
        size: 22,
        checksum: "before",
        locked: false,
      },
    ],
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
  assert.throws(() => normalizeAgentRunnerConfig({ maxOutputTokens: 255 }), /maxOutputTokens/);
  assert.throws(() => normalizeAgentRunnerConfig({ maxCommands: -1 }), /maxCommands/);
  assert.throws(() => normalizeAgentRunnerConfig({ commandTimeoutMs: 99 }), /commandTimeoutMs/);
  assert.throws(() => normalizeAgentRunnerConfig({ sandboxPorts: [3000, 3000] }), /duplicates/);
});
