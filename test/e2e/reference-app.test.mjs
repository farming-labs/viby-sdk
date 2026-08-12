import assert from "node:assert/strict";
import { test } from "node:test";
import { MockLanguageModelV4 } from "ai/test";
import { strFromU8, unzipSync } from "fflate";
import { createReferenceApp } from "../../examples/reference/src/app.ts";
import { createVibyWithDependencies } from "../../src/client.ts";
import { sandboxCapabilities } from "../../src/sandbox.ts";
import { SkillResolver } from "../../src/skills.ts";
import { mcpAdapter } from "../../src/tool-source-mcp.ts";
import { MemoryRepository } from "../helpers/memory-repository.ts";

test("runs connected tools, chat, stream, preview, iterate, and download through the reference app", async () => {
  const repository = new MemoryRepository();
  const toolCalls = [];
  const sandboxCalls = [];
  const sandbox = {
    provider: "test-sandbox",
    capabilities: sandboxCapabilities({
      files: true,
      commands: true,
      backgroundProcesses: true,
      portUrls: true,
    }),
    async create() {
      return {
        id: "reference-sandbox",
        async writeFiles(files) { sandboxCalls.push(["write", files.map((entry) => entry.path)]); },
        async readFile() { return new Uint8Array(); },
        async run(command) {
          sandboxCalls.push(["run", command.command, ...(command.args ?? [])]);
          return { exitCode: 0, stdout: "installed", stderr: "", durationMs: 1 };
        },
        async start(command) {
          sandboxCalls.push(["start", command.command, ...(command.args ?? [])]);
          return {
            id: "preview-process",
            async wait() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }; },
            async kill() { sandboxCalls.push(["kill"]); },
          };
        },
        getUrl(port) { return `https://preview.example.test:${port}/`; },
        async stop() { sandboxCalls.push(["stop"]); },
      };
    },
  };
  let connectedSourceId;
  let modelStep = 0;
  const responses = () => [
    modelToolCall("context-1", `${connectedSourceId}__product_context`, { focus: "analytics" }),
    modelToolCall("package-1", "workspace_write_file", {
      path: "package.json",
      content: JSON.stringify({ name: "reference-output", scripts: { dev: "farm start" } }),
      mediaType: "application/json",
    }),
    modelToolCall("source-1", "workspace_write_file", {
      path: "src/main.ts",
      content: "export const release = 1;\n",
      mediaType: "text/typescript",
    }),
    modelCompletion("Reference workspace", "Used connected context to create version one."),
    modelToolCall("source-2", "workspace_write_file", {
      path: "src/main.ts",
      content: "export const release = 2;\n",
      mediaType: "text/typescript",
    }),
    modelCompletion("Reference workspace", "Made the activity view denser."),
  ];
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: new MockLanguageModelV4({
        doGenerate: async () => responses()[modelStep++],
      }),
      skills: {},
      sandbox,
      agent: { maxSteps: 8, maxDurationMs: 10_000, maxTokens: 10_000 },
      tools: {
        adapters: {
          mcp: mcpAdapter({
            connect: async ({ source }) => ({
              async listTools() {
                return { tools: [{
                  name: "product_context",
                  description: "Read connected product context.",
                  inputSchema: { type: "object" },
                  annotations: { readOnlyHint: true },
                }] };
              },
              async callTool(input) {
                toolCalls.push([source.id, input.name]);
                return {
                  content: [{ type: "text", text: "Connected product context" }],
                  structuredContent: { connected: true },
                  isError: false,
                };
              },
              async close() {},
            }),
          }),
        },
      },
    },
    { repository, skillResolver: new SkillResolver({}) },
  );
  const scoped = viby.forUser({ tenantId: "reference-tenant", userId: "reference-user" });
  const connected = await scoped.toolSources.create({
    type: "mcp",
    name: "Connected product tools",
    configuration: { workspace: "reference" },
  });
  connectedSourceId = connected.id;
  const app = createReferenceApp({
    viby,
    scope: { tenantId: "reference-tenant", userId: "reference-user" },
    defaultToolSourceIds: [connected.id],
    preview: {
      port: 4173,
      install: { command: "npm", args: ["install"] },
      start: { command: "npm", args: ["run", "dev"] },
      readinessCheck: async () => true,
    },
  });

  try {
    const created = await requestJson(app, "/api/chats", {
      method: "POST",
      body: JSON.stringify({ prompt: "Build a complete product analytics workspace." }),
    }, 201);
    assert.equal(created.chat.framework, "farm");
    assert.deepEqual(created.toolSources.map((source) => source.id), [connected.id]);
    assert.deepEqual(
      (await requestJson(app, `/api/chats/${created.chat.id}/tool-sources`))
        .toolSources.map((source) => source.id),
      [connected.id],
    );

    const initialStream = await app.fetch(request(
      `/api/generations/${created.generation.id}/events`,
      { headers: { Accept: "text/event-stream" } },
    ));
    assert.equal(initialStream.status, 200);
    assert.match(initialStream.headers.get("content-type") ?? "", /^text\/event-stream/);
    const initialEvents = await initialStream.text();
    assert.match(initialEvents, /event: generation\.succeeded/);
    assert.match(initialEvents, /id: \d+/);

    const initial = await requestJson(app, `/api/generations/${created.generation.id}`);
    assert.equal(initial.generation.status, "succeeded");
    assert.equal(initial.version.number, 1);
    assert.deepEqual(toolCalls, [[connected.id, "product_context"]]);
    assert.ok(initial.toolCalls.some((call) => (
      call.name === `tool-source.${connected.id}.product_context`
      && call.status === "succeeded"
    )));

    const preview = await requestJson(app, `/api/versions/${initial.version.id}/preview`, {
      method: "POST",
      body: JSON.stringify({ chatId: created.chat.id }),
    }, 201);
    assert.equal(preview.url, "https://preview.example.test:4173/");
    assert.equal(preview.provider, "test-sandbox");
    assert.deepEqual(sandboxCalls.slice(0, 3), [
      ["write", ["package.json", "src/main.ts"]],
      ["run", "npm", "install"],
      ["start", "npm", "run", "dev"],
    ]);

    const iteration = await requestJson(app, `/api/versions/${initial.version.id}/iterations`, {
      method: "POST",
      body: JSON.stringify({ chatId: created.chat.id, prompt: "Make the activity view denser." }),
    }, 202);
    const iterationStream = await app.fetch(request(`/api/generations/${iteration.generation.id}/events`));
    assert.match(await iterationStream.text(), /event: generation\.succeeded/);
    const iterated = await requestJson(app, `/api/generations/${iteration.generation.id}`);
    assert.equal(iterated.version.number, 2);
    assert.equal(iterated.version.parentVersionId, initial.version.id);

    const download = await app.fetch(request(
      `/api/versions/${iterated.version.id}/download?chatId=${created.chat.id}`,
    ));
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") ?? "", /attachment/);
    const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
    assert.equal(strFromU8(archive["src/main.ts"]), "export const release = 2;\n");

    const restored = await requestJson(app, `/api/chats/${created.chat.id}`);
    assert.equal(restored.versions.length, 2);
    assert.equal(restored.messages.length, 4);
    const listing = await requestJson(app, "/api/chats");
    assert.equal(listing.chats[0].id, created.chat.id);
    assert.deepEqual(toolCalls, [[connected.id, "product_context"]]);
  } finally {
    await viby.close();
  }
});

const usage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function modelToolCall(toolCallId, toolName, input) {
  return {
    content: [{ type: "tool-call", toolCallId, toolName, input: JSON.stringify(input) }],
    finishReason: { unified: "tool-calls", raw: undefined },
    usage,
    warnings: [],
  };
}

function modelCompletion(title, summary) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify({ outcome: "complete", title, summary, task: null }),
    }],
    finishReason: { unified: "stop", raw: undefined },
    usage,
    warnings: [],
  };
}

function request(path, init = {}) {
  return new Request(`http://reference.test${path}`, init);
}

async function requestJson(app, path, init = {}, expectedStatus = 200) {
  const response = await app.fetch(request(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  }));
  const body = await response.json();
  assert.equal(response.status, expectedStatus, JSON.stringify(body));
  return body;
}
