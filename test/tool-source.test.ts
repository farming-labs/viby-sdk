import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { MockLanguageModelV4 } from "ai/test";
import { AgentProjectGenerator } from "../src/agent-runner.js";
import { createVibyWithDependencies } from "../src/client.js";
import { SkillResolver } from "../src/skills.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import {
  createToolSourceProposedAction,
  defineToolSource,
  resolveToolSourcePolicy,
  resolveToolSources,
  type ToolSourceContext,
} from "../src/tool-source.js";
import { mcp } from "../src/tool-source-mcp.js";

const context: ToolSourceContext<"farm"> = {
  tenantId: "tenant-a",
  userId: "user-a",
  chatId: "chat-a",
  generationId: "generation-a",
  attemptId: "attempt-a",
  framework: "farm",
  metadata: { team: "design" },
};

test("selects provider-neutral tool sources independently for each chat", async () => {
  const docs = defineToolSource<"farm">({
    id: "docs",
    list: async () => [{
      name: "search",
      description: "Search documentation.",
      inputSchema: { type: "object", properties: { query: { type: "string" } } },
      effect: "read",
    }],
    call: async ({ arguments: arguments_ }) => ({ result: arguments_.query ?? null }),
  });
  const skipped = defineToolSource<"farm">({
    id: "skipped",
    list: async () => { throw new Error("Unselected source must not connect"); },
    call: async () => null,
  });
  const config = {
    sources: { docs, skipped },
    select: ({ context: selected }: { context: ToolSourceContext<"farm"> }) => (
      selected.metadata.team === "design" ? ["docs"] : []
    ),
  };
  const [resolved] = await resolveToolSources(config, context);
  assert.equal(resolved?.key, "docs__search");
  assert.equal(await resolveToolSourcePolicy(config, {
    source: "docs",
    tool: resolved!.tool,
    arguments: { query: "Farm" },
    context,
  }), "allow");
  assert.deepEqual(await resolved?.source.call({
    name: "search",
    arguments: { query: "Farm" },
    idempotencyKey: "read-1",
  }, context), { result: "Farm" });
});

test("creates stable credential-free proposed actions for effectful tools", () => {
  const first = createToolSourceProposedAction("github", "create_issue", {
    title: "Bug",
    labels: ["sdk"],
  }, context);
  const second = createToolSourceProposedAction("github", "create_issue", {
    labels: ["sdk"],
    title: "Bug",
  }, context);
  assert.equal(first.idempotencyKey, second.idempotencyKey);
  assert.equal(JSON.stringify(first).includes("generation-a"), false);
  assert.equal(JSON.stringify(first).includes("attempt-a"), false);
});

test("consumes a real MCP connection and normalizes tool schemas and results", async () => {
  const server = new McpServer({ name: "inbound-test", version: "1" });
  server.registerTool("lookup", {
    description: "Look up one item.",
    inputSchema: z.object({ id: z.string() }),
    annotations: { readOnlyHint: true },
  }, async ({ id }) => ({
    content: [{ type: "text", text: `found:${id}` }],
    structuredContent: { id, found: true },
  }));
  const client = new Client({ name: "inbound-client", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const source = mcp<"farm">({ id: "catalog", connect: async () => client });
  try {
    const [tool] = await source.list(context);
    assert.equal(tool?.name, "lookup");
    assert.equal(tool?.effect, "read");
    const result = await source.call({
      name: "lookup",
      arguments: { id: "42" },
      idempotencyKey: "lookup-42",
    }, context);
    assert.deepEqual(result, {
      content: [{ type: "text", text: "found:42" }],
      structuredContent: { id: "42", found: true },
      isError: false,
    });
  } finally {
    await Promise.allSettled([source.close?.(), server.close()]);
  }
});

test("keeps MCP headers inside the transport factory", async () => {
  let observedAuthorization: string | null = null;
  const source = mcp<"farm">({
    id: "private",
    url: "https://mcp.example.test",
    headers: async (selected) => ({ Authorization: `Bearer secret-for-${selected.userId}` }),
    fetch: async (_input, init) => {
      observedAuthorization = new Headers(init?.headers).get("authorization");
      return new Response("not available", { status: 503 });
    },
  });
  await assert.rejects(() => source.list(context));
  assert.equal(observedAuthorization, "Bearer secret-for-user-a");
  assert.equal(JSON.stringify(source).includes("secret-for-user-a"), false);
});

test("closes configured tool sources with the Viby client", async () => {
  let closeCalls = 0;
  const source = defineToolSource<"farm">({
    id: "lifecycle",
    list: async () => [],
    call: async () => null,
    close: async () => { closeCalls += 1; },
  });
  const model = new MockLanguageModelV4({
    doGenerate: modelCompletion("Unused", "Unused"),
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model,
      tools: { sources: { lifecycle: source } },
    },
    {
      repository: new MemoryRepository(),
      skillResolver: new SkillResolver({}),
    },
  );

  await viby.close();

  assert.equal(closeCalls, 1);
});

test("pauses an effectful inbound call and resumes it exactly once after approval", async () => {
  let calls = 0;
  const source = defineToolSource<"farm">({
    id: "issues",
    list: async () => [{
      name: "create",
      description: "Create an issue.",
      inputSchema: {
        type: "object",
        properties: { title: { type: "string" } },
        required: ["title"],
        additionalProperties: false,
      },
      effect: "external",
      permissions: ["issues.create"],
    }],
    call: async ({ arguments: arguments_ }) => {
      calls += 1;
      return { id: "issue-1", title: arguments_.title ?? null };
    },
  });
  const toolConfig = { sources: { issues: source } } as const;
  const model = new MockLanguageModelV4({
    doGenerate: [
      modelToolCall("propose-issue", "issues__create", { title: "Fix navigation" }),
      modelToolCall("approved-issue", "issues__create", { title: "Fix navigation" }),
      modelToolCall("write-result", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const issue = 'issue-1';\n",
        mediaType: "text/javascript",
      }),
      modelCompletion("Issue project", "Created the approved issue and project."),
    ],
  });
  const agentConfig = { maxSteps: 8, maxDurationMs: 10_000, maxTokens: 10_000 };
  const viby = createVibyWithDependencies(
    { framework: "farm", model, tools: toolConfig, agent: agentConfig },
    {
      repository: new MemoryRepository(),
      generator: new AgentProjectGenerator(model, agentConfig, toolConfig),
      skillResolver: new SkillResolver({}),
    },
  );
  try {
    const scoped = viby.forUser({ tenantId: "tenant-tools", userId: "user-tools" });
    const generation = await (await scoped.chats.create({ metadata: { tools: "issues" } }))
      .start({ prompt: "Create the issue, then build the project" });
    let outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "waiting");
    if (outcome.status !== "waiting") throw new Error("Expected approval task");
    const [task] = outcome.tasks;
    assert.equal(task?.kind, "permission");
    if (!task || task.kind !== "permission") throw new Error("Expected permission task");
    assert.equal(task.proposedToolAction?.source, "issues");
    assert.equal(task.proposedToolAction?.tool, "create");
    assert.equal(calls, 0);
    await generation.resolve({
      taskId: task.id,
      resolution: { kind: "permission", decision: "allow" },
    });
    outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    assert.equal(calls, 1);
    const recorded = (await generation.toolCalls()).filter((call) => (
      call.name === "tool-source.issues.create"
    ));
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0]?.idempotencyKey, task.proposedToolAction?.idempotencyKey);
  } finally {
    await viby.close();
  }
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function modelToolCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [{ type: "tool-call" as const, toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage,
    warnings: [],
  };
}

function modelCompletion(title: string, summary: string) {
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
