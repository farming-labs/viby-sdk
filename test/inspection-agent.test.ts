import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { codex } from "../src/agent-codex.js";
import { createVibyWithDependencies } from "../src/client.js";
import { defineCodingAgent } from "../src/generation-engine.js";
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
  let completedSignal: AbortSignal | undefined;
  const agent = defineCodingAgent<"farmjs">({
    identity: { provider: "fixture-agent", model: "fixture-v1" },
    async generate(input, options) {
      calls.push(input);
      if (input.operation === "inspect") {
        completedSignal = options?.signal;
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
    { framework: "farmjs", agent },
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
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  assert.equal(completedSignal?.aborted, false);
  await viby.close();
});

test("rejects source output from a read-only inspection", async () => {
  const agent = defineCodingAgent<"farmjs">({
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
    { framework: "farmjs", agent },
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
  const agent = defineCodingAgent<"farmjs">({
    identity: { provider: "fixture-agent", model: "fixture-v1" },
    async generate() { return sourceProject(); },
  });
  const viby = createVibyWithDependencies(
    { framework: "farmjs", agent },
    { repository: new MemoryRepository(), skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "empty-tenant", userId: "empty-user" })
    .chats.create();
  await assert.rejects(() => chat.inspect({ prompt: "What is here?" }), /existing project version/);
  await viby.close();
});

test("Codex adapter uses read-only and workspace-write modes end to end", async () => {
  const threadOptions: Array<{
    sandboxMode?: string;
    workingDirectory?: string;
    networkAccessEnabled?: boolean;
    webSearchMode?: string;
  }> = [];
  const client = {
    startThread(options: { sandboxMode?: string; workingDirectory?: string }) {
      threadOptions.push(options);
      return {
        async runStreamed() {
          if (options.sandboxMode === "workspace-write") {
            await writeFile(join(options.workingDirectory!, "src.ts"), "export const built = true;\n");
          }
          async function* events() {
            if (options.sandboxMode === "workspace-write") {
              yield {
                type: "item.completed" as const,
                item: {
                  id: "file-change-1",
                  type: "file_change" as const,
                  changes: [{
                    path: join(options.workingDirectory!, "src.ts"),
                    kind: "add" as const,
                  }],
                },
              };
            }
            yield {
              type: "item.completed" as const,
              item: {
                id: "message-1",
                type: "agent_message" as const,
                text: options.sandboxMode === "read-only"
                  ? "`src.ts` exports `built`."
                  : "Created the source module.",
              },
            };
            yield {
              type: "turn.completed" as const,
              usage: {
                input_tokens: 4,
                cached_input_tokens: 1,
                cache_write_input_tokens: 0,
                output_tokens: 3,
                reasoning_output_tokens: 1,
              },
            };
          }
          return { events: events() };
        },
      };
    },
  };
  const agent = codex<"farmjs">({
    model: "gpt-test",
    networkAccess: true,
    webSearch: "live",
    client: client as never,
  });
  const common = {
    framework: "farmjs" as const,
    prompt: "Work with the source",
    messages: [],
    skills: [],
    tasks: [],
  };
  const tracedFiles: string[] = [];
  const project = await agent.generate(
    { ...common, operation: "change", previousFiles: [] },
    {
      trace: {
        async start(type) {
          return {
            id: `trace-${type}`,
            type,
            async delta() {},
            async complete(value) {
              if (
                type === "file-edit" &&
                "path" in value &&
                typeof value.path === "string"
              ) {
                tracedFiles.push(value.path);
              }
            },
            async fail() {},
          };
        },
      },
    },
  );
  assert.equal(project.kind, "project");
  assert.deepEqual(tracedFiles, ["src.ts"]);
  const inspection = await agent.generate({
    ...common,
    operation: "inspect",
    previousFiles: project.kind === "project" ? project.files : [],
  });
  assert.equal(inspection.kind, "message");
  assert.deepEqual(threadOptions.map((options) => options.sandboxMode), [
    "workspace-write",
    "read-only",
  ]);
  assert.deepEqual(threadOptions.map((options) => options.networkAccessEnabled), [
    true,
    false,
  ]);
  assert.deepEqual(threadOptions.map((options) => options.webSearchMode), [
    "live",
    "disabled",
  ]);
});

test("Codex adapter preserves locked file metadata and names locked paths in its prompt", async () => {
  let prompt = "";
  const client = {
    startThread(options: { workingDirectory?: string }) {
      return {
        async runStreamed(nextPrompt: string) {
          prompt = nextPrompt;
          await writeFile(
            join(options.workingDirectory!, "src/app/page.tsx"),
            "export default function Page() { return <main>Updated</main>; }\n",
          );
          async function* events() {
            yield {
              type: "item.completed" as const,
              item: {
                id: "message-1",
                type: "agent_message" as const,
                text: "Updated the page without changing framework configuration.",
              },
            };
            yield {
              type: "turn.completed" as const,
              usage: {
                input_tokens: 4,
                cached_input_tokens: 0,
                cache_write_input_tokens: 0,
                output_tokens: 3,
                reasoning_output_tokens: 0,
              },
            };
          }
          return { events: events() };
        },
      };
    },
  };
  const agent = codex<"farmjs">({ model: "gpt-test", client: client as never });
  const config = "export default {};\n";
  const page = "export default function Page() { return <main>Initial</main>; }\n";
  const result = await agent.generate({
    framework: "farmjs",
    operation: "change",
    prompt: "Update the page",
    messages: [],
    skills: [],
    tasks: [],
    previousFiles: [
      {
        path: "farm.config.ts",
        content: config,
        mediaType: "text/plain",
        size: Buffer.byteLength(config),
        checksum: sha256(config),
        locked: true,
      },
      {
        path: "src/app/page.tsx",
        content: page,
        mediaType: "text/plain",
        size: Buffer.byteLength(page),
        checksum: sha256(page),
        locked: false,
      },
    ],
  });

  assert.equal(result.kind, "changes");
  if (result.kind === "changes") {
    assert.deepEqual(result.changes.map((change) => (
      change.type === "move" ? change.from : change.path
    )), ["src/app/page.tsx"]);
    assert.equal(result.changes[0]?.type === "write" && result.changes[0].mediaType, "text/plain");
  }
  assert.match(prompt, /Locked files \(must remain byte-for-byte unchanged\):\n- farm\.config\.ts/);
});
