import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { resolveToolSources } from "../src/tool-source.js";
import {
  defineToolSourceAdapter,
  ToolSourceRegistry,
  type ToolSourceRegistrationData,
} from "../src/tool-source-registry.js";
import type { FrameworkId } from "../src/types.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

class UnusedGenerator<Framework extends FrameworkId> implements ProjectGenerator<Framework> {
  async generate(_input: GeneratorInput<Framework>): Promise<GeneratorOutput> {
    throw new Error("The registry tests do not invoke generation.");
  }
}

const owner = { tenantId: "registry-tenant", userId: "registry-owner" };
const modelUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function modelToolCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [{
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: modelUsage,
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
    usage: modelUsage,
    warnings: [],
  };
}

function fixtureAdapter(events: string[]) {
  return defineToolSourceAdapter<"farm">({
    type: "fixture",
    open({ source, scope }) {
      events.push(`open:${scope.userId}:${source.id}`);
      return {
        id: source.id,
        async list() {
          return [{
            name: "lookup",
            description: "Look up a durable fixture.",
            inputSchema: { type: "object" },
            effect: "read",
          }];
        },
        async call(call) {
          return { source: source.id, query: call.arguments.query ?? null };
        },
        async close() {
          events.push(`close:${scope.userId}:${source.id}`);
        },
      };
    },
    async close() {
      events.push("adapter:close");
    },
  });
}

function createFixture(repository: MemoryRepository, events: string[]) {
  return createVibyWithDependencies({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    tools: { adapters: { fixture: fixtureAdapter(events) } },
  }, {
    repository,
    generator: new UnusedGenerator<"farm">(),
    skillResolver: new SkillResolver({}),
  });
}

test("persists tenant-scoped tool sources and selects them independently for each chat", async () => {
  const repository = new MemoryRepository();
  const events: string[] = [];
  const viby = createFixture(repository, events);
  const user = viby.forUser(owner);
  const firstChat = await user.chats.create({ title: "First" });
  const secondChat = await user.chats.create({ title: "Second" });
  const source = await user.toolSources.create({
    type: "fixture",
    name: "Company tools",
    description: "Tenant-owned tools",
    configuration: { endpoint: "https://tools.example.test/mcp" },
  });

  assert.equal(source.status, "active");
  assert.equal(source.data().configuration.endpoint, "https://tools.example.test/mcp");
  assert.deepEqual((await firstChat.toolSources.set([source.id])).map((item) => item.id), [source.id]);
  assert.deepEqual((await firstChat.toolSources.list()).map((item) => item.id), [source.id]);
  assert.deepEqual(await secondChat.toolSources.list(), []);
  assert.equal((await user.toolSources.list({ type: "fixture" }))[0]?.id, source.id);

  const outsider = viby.forUser({ tenantId: owner.tenantId, userId: "registry-outsider" });
  await assert.rejects(() => outsider.toolSources.get(source.id), /Tool source .*not found/);
  await assert.rejects(
    () => outsider.chats.create({ title: "Outsider" }).then((chat) => chat.toolSources.set([source.id])),
    /Active tool source .*not found/,
  );

  await source.update({ enabled: false, name: "Paused tools" });
  assert.equal(source.status, "disabled");
  assert.equal(source.name, "Paused tools");
  await source.update({ enabled: true });
  await source.archive();
  assert.equal(source.status, "archived");
  assert.deepEqual(await firstChat.toolSources.list(), []);
  await viby.close();
  assert.deepEqual(events, ["adapter:close"]);
});

test("resolves selected durable registrations alongside static sources and closes cached adapters", async () => {
  const repository = new MemoryRepository();
  const events: string[] = [];
  const registry = new ToolSourceRegistry<"farm">(repository, {
    fixture: fixtureAdapter(events),
  });
  const chat = await repository.createChat(owner, {
    id: crypto.randomUUID(),
    title: "Resolution",
    metadata: {},
    framework: "farm",
  });
  const durable = await registry.create(owner, {
    type: "fixture",
    name: "Durable",
  });
  await registry.select(owner, chat.id, [durable.id]);
  const context = {
    ...owner,
    chatId: chat.id,
    generationId: crypto.randomUUID(),
    attemptId: crypto.randomUUID(),
    framework: "farm" as const,
    metadata: {},
  };

  const resolved = await resolveToolSources({
    sources: {
      static: {
        id: "static",
        async list() {
          return [{
            name: "read",
            description: "Read static data.",
            inputSchema: { type: "object" },
            effect: "read",
          }];
        },
        async call() { return null; },
      },
    },
    registry,
  }, context);
  assert.deepEqual(resolved.map((item) => item.key), ["static__read", `${durable.id}__lookup`]);
  assert.equal(events.filter((event) => event.startsWith("open:")).length, 1);

  await registry.update(owner, durable.id, { name: "Reconfigured" });
  assert.equal(events.filter((event) => event.startsWith("close:")).length, 1);
  await registry.resolve(context);
  assert.equal(events.filter((event) => event.startsWith("open:")).length, 2);
  await registry.close();
  assert.equal(events.at(-1), "adapter:close");
});

test("connects chat-selected durable sources to the default generation agent", async () => {
  const repository = new MemoryRepository();
  const sourceId = crypto.randomUUID();
  const chatId = crypto.randomUUID();
  await repository.createChat(owner, {
    id: chatId,
    title: "Agent registry",
    metadata: {},
    framework: "farm",
  });
  await repository.createToolSourceRegistration(owner, {
    id: sourceId,
    type: "fixture",
    name: "Agent tools",
    description: null,
    configuration: {},
    now: new Date(),
  });
  await repository.replaceChatToolSources(owner, chatId, [sourceId], new Date());
  let calls = 0;
  const adapter = defineToolSourceAdapter<"farm">({
    type: "fixture",
    open: ({ source }) => ({
      id: source.id,
      list: async () => [{
        name: "lookup",
        description: "Look up agent context.",
        inputSchema: { type: "object" },
        effect: "read",
      }],
      call: async () => {
        calls += 1;
        return { value: "durable-context" };
      },
    }),
  });
  const model = new MockLanguageModelV4({
    doGenerate: [
      modelToolCall("lookup", `${sourceId}__lookup`, {}),
      modelToolCall("write", "workspace_write_file", {
        path: "src/index.ts",
        content: "export const context = 'durable-context';\n",
        mediaType: "text/javascript",
      }),
      modelCompletion("Durable tools", "Used the selected durable source."),
    ],
  });
  const viby = createVibyWithDependencies({
    framework: "farm",
    model,
    tools: { adapters: { fixture: adapter } },
    agent: { maxSteps: 6, maxDurationMs: 10_000, maxTokens: 10_000 },
  }, {
    repository,
    skillResolver: new SkillResolver({}),
  });
  try {
    const version = await (await viby.forUser(owner).chats.get(chatId)).generate({
      prompt: "Use the selected tool and create the project.",
    });
    assert.equal(calls, 1);
    assert.equal((await version.files())[0]?.content, "export const context = 'durable-context';\n");
  } finally {
    await viby.close();
  }
});

test("snapshots selected public registrations before a durable worker runs", async () => {
  const repository = new MemoryRepository();
  const observedRevisions: unknown[] = [];
  const adapter = defineToolSourceAdapter<"farm">({
    type: "fixture",
    open: ({ source }) => ({
      id: source.id,
      list: async () => [{
        name: "lookup",
        description: "Read the snapshotted public configuration.",
        inputSchema: { type: "object" },
        effect: "read",
      }],
      call: async () => {
        observedRevisions.push(source.configuration.revision);
        return { revision: source.configuration.revision ?? null };
      },
    }),
  });
  const config = {
    framework: "farm" as const,
    model: new MockLanguageModelV4({
      doGenerate: modelCompletion("Unused", "Unused"),
    }),
    tools: { adapters: { fixture: adapter } },
    generation: { execution: "worker" as const },
  };
  const creator = createVibyWithDependencies(config, {
    repository,
    skillResolver: new SkillResolver({}),
  });
  const scoped = creator.forUser(owner);
  const chat = await scoped.chats.create({ title: "Snapshot tools" });
  const registered = await scoped.toolSources.create({
    type: "fixture",
    name: "Versioned tools",
    configuration: { revision: "queued" },
  });
  await chat.toolSources.set([registered.id]);
  const generation = await chat.start({ prompt: "Use the queued tool revision." });
  const queued = await generation.data();
  assert.deepEqual(queued.configuration.toolSources?.map((source) => ({
    id: source.id,
    type: source.type,
    configuration: source.configuration,
  })), [{
    id: registered.id,
    type: "fixture",
    configuration: { revision: "queued" },
  }]);

  await registered.update({ configuration: { revision: "changed" } });
  await chat.toolSources.set([]);
  await creator.close();

  const worker = createVibyWithDependencies({
    ...config,
    model: new MockLanguageModelV4({
      doGenerate: [
        modelToolCall("lookup", `${registered.id}__lookup`, {}),
        modelToolCall("write", "workspace_write_file", {
          path: "src/index.ts",
          content: "export const revision = 'queued';\n",
          mediaType: "text/javascript",
        }),
        modelCompletion("Snapshot", "Used the queued tool revision."),
      ],
    }),
  }, {
    repository,
    skillResolver: new SkillResolver({}),
  });
  try {
    assert.equal(await worker.worker({ id: "tool-snapshot-worker" }).runOnce(), true);
    assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");
    assert.deepEqual(observedRevisions, ["queued"]);
  } finally {
    await worker.close();
  }
});

test("rejects credentials in durable configuration and invalid adapter registrations", async () => {
  const repository = new MemoryRepository();
  const registry = new ToolSourceRegistry(repository, { fixture: fixtureAdapter([]) });
  await assert.rejects(
    () => registry.create(owner, {
      type: "fixture",
      name: "Unsafe",
      configuration: { headers: { authorization: "Bearer secret" } },
    }),
    /looks secret/,
  );
  await assert.rejects(
    () => registry.create(owner, {
      type: "fixture",
      name: "Unsafe API key",
      configuration: { apiKey: "secret" },
    }),
    /looks secret/,
  );
  await assert.rejects(
    () => registry.create(owner, { type: "unknown", name: "Unknown" }),
    /No durable tool source adapter is configured/,
  );
  assert.throws(
    () => new ToolSourceRegistry(repository, {
      wrong: { type: "fixture", open() { throw new Error("unused"); } },
    }),
    /must match adapter.type/,
  );
});

test("returns defensive registration snapshots from the persistence boundary", async () => {
  const repository = new MemoryRepository();
  const registry = new ToolSourceRegistry(repository, { fixture: fixtureAdapter([]) });
  const source = await registry.create(owner, {
    type: "fixture",
    name: "Immutable",
    configuration: { nested: { enabled: true } },
  });
  const snapshot = source as ToolSourceRegistrationData & {
    configuration: { nested: { enabled: boolean } };
  };
  snapshot.configuration.nested.enabled = false;
  const stored = await registry.get(owner, source.id);
  assert.deepEqual(stored.configuration, { nested: { enabled: true } });
});
