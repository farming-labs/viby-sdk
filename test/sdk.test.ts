import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import { AgentWorkspace } from "../src/agent-workspace.js";
import type {
  GeneratorInput,
  GeneratorOutput,
  ProjectGenerator,
} from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { MESSAGE_PART_TYPES } from "../src/types.js";
import type { FrameworkId, VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import {
  GenerationError,
  NotFoundError,
  OutboundEventDeliveryError,
  OutboundEventSignatureError,
  SourceImportError,
} from "../src/errors.js";
import {
  signedOutboundEventSink,
  verifySignedOutboundEvent,
  type OutboundEventRequest,
} from "../src/outbound-events.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 10,
  inputTokenDetails: {
    noCacheTokens: 10,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 20,
  outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
  totalTokens: 30,
};

class FakeGenerator<Framework extends FrameworkId> implements ProjectGenerator<Framework> {
  readonly calls: Array<GeneratorInput<Framework>> = [];
  shouldFail = false;

  async generate(input: GeneratorInput<Framework>): Promise<GeneratorOutput> {
    this.calls.push(input);
    if (this.shouldFail) throw new Error("model unavailable");
    const number = this.calls.length;
    const content = `export const version = ${number};\n`;
    const files: VersionFile[] = [{
      path: "src/index.ts",
      content,
      mediaType: "text/javascript",
      size: Buffer.byteLength(content),
      checksum: sha256(content),
      locked: false,
    }];
    return {
      kind: "project",
      title: "Analytics dashboard",
      summary: `Generated version ${number}`,
      files,
      usage,
      finishReason: "stop",
    };
  }
}

function setup() {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
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
  return { viby, repository, generator };
}

test("publishes the complete stable message part vocabulary", () => {
  assert.deepEqual(MESSAGE_PART_TYPES, [
    "text",
    "status",
    "reasoning-summary",
    "file-read",
    "file-edit",
    "search",
    "command",
    "tool-call",
    "error",
    "usage",
  ]);
});

test("creates a tenant-scoped chat, generation, immutable version, and source ZIP", async () => {
  const { viby, repository, generator } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.create({ title: "Dashboard" });

  const first = await chat.generate({ prompt: "Build an analytics dashboard" });
  assert.equal(first.number, 1);
  assert.equal(first.framework, "farm");
  assert.equal((await first.generation())?.status, "succeeded");

  const second = await first.iterate({ prompt: "Make the sidebar compact" });
  assert.equal(second.number, 2);
  assert.equal(second.parentVersionId, first.id);
  assert.equal(generator.calls[1]?.previousFiles[0]?.content, "export const version = 1;\n");
  assert.equal((await chat.getVersion(first.id)).id, first.id);

  const artifact = await second.download();
  assert.equal(artifact.filename, "analytics-dashboard.zip");
  const files = unzipSync(artifact.bytes);
  assert.equal(strFromU8(files["src/index.ts"]!), "export const version = 2;\n");
  assert.equal(repository.messages.length, 4);

  await viby.close();
  assert.equal(repository.closed, true);
});

test("persists typed ordered message parts with message, generation, and attempt ownership", async () => {
  const { viby } = setup();
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create({ title: "Message parts" });
  const version = await chat.generate({ prompt: "Build a dashboard" });
  const messages = (await chat.listMessages()).items;

  assert.equal(messages.length, 2);
  const user = messages.find((message) => message.role === "user")!;
  const assistant = messages.find((message) => message.role === "assistant")!;
  assert.deepEqual(user.parts.map((part) => part.type), ["text"]);
  assert.deepEqual(assistant.parts.map((part) => part.type), [
    "file-edit",
    "text",
    "usage",
  ]);
  assert.equal(assistant.generationId, version.generationId);
  assert.ok(assistant.parts.every((part, position) => (
    part.messageId === assistant.id
    && part.generationId === version.generationId
    && part.attemptId
    && part.position === position
  )));
  const edit = assistant.parts[0]!;
  assert.equal(edit.type, "file-edit");
  if (edit.type !== "file-edit") throw new Error("Expected a file edit part");
  assert.deepEqual(edit.data, { operation: "write", path: "src/index.ts" });
  const usagePart = assistant.parts[2]!;
  assert.equal(usagePart.type, "usage");
  if (usagePart.type !== "usage") throw new Error("Expected a usage part");
  assert.deepEqual(usagePart.data, {
    inputTokens: 10,
    outputTokens: 20,
    totalTokens: 30,
  });
  assert.deepEqual(await chat.getMessage(assistant.id), assistant);
  const otherChat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create({ title: "Other chat" });
  await assert.rejects(() => otherChat.getMessage(assistant.id), NotFoundError);
  const otherUserChat = await viby
    .forUser({ tenantId: "tenant-b", userId: "user-b" })
    .chats.create({ title: "Other tenant" });
  await assert.rejects(() => otherUserChat.getMessage(assistant.id), NotFoundError);
  await viby.close();
});

test("delivers resumable durable events as signed provider-neutral envelopes", async () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  const requests: OutboundEventRequest[] = [];
  const secret = "a-secure-outbound-event-secret-with-32-bytes";
  const now = new Date("2026-08-09T12:00:00.000Z");
  const sink = signedOutboundEventSink({
    id: "product-events",
    keyId: "key-2026-08",
    secret,
    source: "viby://tests/sdk",
    now: () => now,
    send(request) {
      requests.push(request);
    },
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      events: { sinks: [sink] },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a dashboard" });
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");

  let cursor = "0";
  const receipts = [];
  do {
    const page = await generation.deliverEvents({
      sink: "product-events",
      after: cursor,
      limit: 2,
    });
    receipts.push(...page.deliveries);
    cursor = page.cursor;
    if (!page.hasMore) break;
  } while (true);

  const events = (await generation.events({ limit: 100 })).events;
  assert.equal(receipts.length, events.length);
  assert.equal(requests.length, events.length);
  assert.deepEqual(receipts.map((receipt) => receipt.cursor), events.map((event) => event.cursor));
  for (const [index, request] of requests.entries()) {
    const envelope = verifySignedOutboundEvent(request, {
      secret,
      keyId: "key-2026-08",
      now,
    });
    assert.equal(envelope.id, `${generation.id}:${events[index]!.cursor}`);
    assert.equal(envelope.type, `dev.viby.generation.${events[index]!.type}`);
    assert.equal(envelope.source, "viby://tests/sdk");
    assert.equal(envelope.data.tenantId, "tenant-a");
    assert.equal(envelope.data.userId, "user-a");
    assert.equal(envelope.data.chatId, chat.id);
    assert.equal(envelope.data.generationId, generation.id);
    assert.equal(request.body.includes(secret), false);
  }

  const first = requests[0]!;
  assert.throws(
    () => verifySignedOutboundEvent({ ...first, body: `${first.body} ` }, {
      secret,
      keyId: "key-2026-08",
      now,
    }),
    OutboundEventSignatureError,
  );
  assert.throws(
    () => verifySignedOutboundEvent(first, {
      secret,
      keyId: "key-2026-08",
      now: new Date(now.getTime() + 5 * 60 * 1_000 + 1),
    }),
    /outside the accepted window/,
  );
});

test("isolates sink failures and exposes an exact safe resume cursor", async () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  const delivered: string[] = [];
  let fail = true;
  const sink = signedOutboundEventSink({
    id: "retryable-events",
    secret: "another-secure-outbound-secret-with-32-bytes",
    send(request) {
      if (fail && delivered.length === 1) throw new Error("transport credential must stay private");
      delivered.push(request.event.id);
    },
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      events: { sinks: [sink] },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a dashboard" });
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");

  let failure: OutboundEventDeliveryError | undefined;
  try {
    await generation.deliverEvents({
      sink: "retryable-events",
      limit: 100,
      retry: { initialDelayMs: 0, maxDelayMs: 0 },
    });
  } catch (error) {
    if (error instanceof OutboundEventDeliveryError) failure = error;
    else throw error;
  }
  assert.ok(failure);
  assert.equal(failure.lastDeliveredCursor, "1");
  assert.equal(failure.eventCursor, "2");
  assert.equal(failure.message.includes("transport credential"), false);
  assert.equal((await generation.data()).status, "succeeded");

  fail = false;
  const retry = await generation.deliverEvents({
    sink: "retryable-events",
    after: failure.lastDeliveredCursor,
    limit: 100,
    retry: { initialDelayMs: 0, maxDelayMs: 0 },
  });
  assert.ok(retry.deliveries.length > 0);
  assert.equal(retry.deliveries[0]?.eventId, `${generation.id}:2`);
  await assert.rejects(
    () => generation.deliverEvents({ sink: "missing" }),
    /not configured/,
  );
});

test("durably retries, dead-letters, and explicitly redrives outbound events", async () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  let available = false;
  const attempts: string[] = [];
  const sink = signedOutboundEventSink({
    id: "durable-events",
    secret: "durable-outbound-event-secret-at-least-32-bytes",
    send(request) {
      attempts.push(request.event.id);
      if (!available) throw new Error("provider unavailable with secret-value");
    },
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      events: { sinks: [sink] },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a durable event project" });
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");
  const retry = { maxAttempts: 2, initialDelayMs: 0, maxDelayMs: 0 } as const;

  await assert.rejects(
    () => generation.deliverEvents({ sink: "durable-events", retry }),
    (error: unknown) => (
      error instanceof OutboundEventDeliveryError
      && error.delivery?.status === "pending"
      && error.delivery.attemptCount === 1
      && error.delivery.lastError?.includes("secret-value") === false
    ),
  );
  await assert.rejects(
    () => generation.deliverEvents({ sink: "durable-events", retry }),
    (error: unknown) => (
      error instanceof OutboundEventDeliveryError
      && error.delivery?.status === "dead_lettered"
      && error.delivery.attemptCount === 2
      && error.delivery.deadLetteredAt instanceof Date
    ),
  );

  const [deadLetter] = await generation.outboundDeliveries({
    sink: "durable-events",
    status: "dead_lettered",
  });
  assert.ok(deadLetter);
  assert.equal(deadLetter.eventCursor, "1");
  assert.equal(attempts.length, 2);

  const redriven = await generation.redriveOutboundEvent({
    sink: "durable-events",
    cursor: deadLetter.eventCursor,
  });
  assert.equal(redriven.status, "pending");
  assert.equal(redriven.attemptCount, 0);

  available = true;
  const delivered = await generation.deliverEvents({
    sink: "durable-events",
    retry,
    limit: 100,
  });
  assert.ok(delivered.deliveries.length > 0);
  assert.equal(delivered.deadLetters.length, 0);
  assert.equal(delivered.retryAt, null);
  assert.equal(delivered.hasMore, false);
  assert.ok((await generation.outboundDeliveries({ sink: "durable-events" }))
    .every((delivery) => delivery.status === "delivered"));
  await viby.close();
});

test("returns the durable retry time without busy-looping a deferred delivery", async () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  const sink = signedOutboundEventSink({
    id: "deferred-events",
    secret: "deferred-outbound-event-secret-at-least-32-bytes",
    send() {
      throw new Error("temporarily unavailable");
    },
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      events: { sinks: [sink] },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a deferred event project" });
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");

  await assert.rejects(() => generation.deliverEvents({
    sink: "deferred-events",
    retry: { initialDelayMs: 60_000, maxDelayMs: 60_000 },
  }));
  const page = await generation.deliverEvents({ sink: "deferred-events" });
  assert.equal(page.deliveries.length, 0);
  assert.equal(page.cursor, "0");
  assert.equal(page.hasMore, true);
  assert.ok(page.retryAt && page.retryAt.getTime() > Date.now());
  await viby.close();
});

test("leases outbound delivery so concurrent callers do not repeat an effect", async () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  const delivered: string[] = [];
  const sink = signedOutboundEventSink({
    id: "leased-events",
    secret: "leased-outbound-event-secret-at-least-32-bytes",
    async send(request) {
      await new Promise((resolve) => setTimeout(resolve, 5));
      delivered.push(request.event.id);
    },
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      events: { sinks: [sink] },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a leased event project" });
  assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");

  const [first, second] = await Promise.all([
    generation.deliverEvents({ sink: "leased-events", limit: 100 }),
    generation.deliverEvents({ sink: "leased-events", limit: 100 }),
  ]);
  assert.ok(first.deliveries.length === 0 || second.deliveries.length === 0);
  const events = (await generation.events({ limit: 100 })).events;
  assert.equal(delivered.length, events.length);
  assert.equal(new Set(delivered).size, events.length);
  await viby.close();
});

test("validates signed outbound sink configuration", () => {
  assert.throws(
    () => signedOutboundEventSink({ id: "events", secret: "short", send() {} }),
    /at least 32 bytes/,
  );
  const sink = signedOutboundEventSink({
    id: "duplicate",
    secret: "secure-outbound-event-secret-at-least-32-bytes",
    send() {},
  });
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  assert.throws(
    () => createVibyWithDependencies({
      framework: "farm",
      model: "test/mock" as LanguageModel,
      events: { sinks: [sink, sink] },
    }, { repository, generator, skillResolver: new SkillResolver({}) }),
    /duplicated/,
  );
});

test("imports normalized source files without invoking the model", async () => {
  const { viby, repository, generator } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.import({
    title: "Imported Farm app",
    summary: "Existing source",
    source: {
      type: "files",
      files: [
        { path: "./src/index.ts", content: "export const app = true;\n" },
        { path: "package.json", content: '{"name":"imported"}\n' },
      ],
    },
  });

  const version = await chat.latestVersion();
  assert.ok(version);
  assert.equal(version.origin, "imported");
  assert.equal(version.generationId, null);
  assert.equal(await version.generation(), null);
  assert.deepEqual((await version.files()).map((file) => file.path), [
    "package.json",
    "src/index.ts",
  ]);
  assert.equal((await version.files())[1]?.mediaType, "text/javascript");
  assert.equal(generator.calls.length, 0);
  assert.equal(repository.messages.length, 0);

  const artifact = await version.download();
  assert.equal(
    strFromU8(unzipSync(artifact.bytes)["src/index.ts"]!),
    "export const app = true;\n",
  );
});

test("imports UTF-8 ZIP source and rejects unsafe or binary archives", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.import({
    source: {
      type: "zip",
      bytes: zipSync({
        "package.json": strToU8('{"name":"zipped"}\n'),
        "src/index.ts": strToU8("export const zipped = true;\n"),
      }),
    },
  });
  assert.deepEqual((await (await chat.latestVersion())!.files()).map((file) => file.path), [
    "package.json",
    "src/index.ts",
  ]);

  await assert.rejects(
    () => user.chats.import({
      source: { type: "files", files: [{ path: "../.env", content: "SECRET=value" }] },
    }),
    /unsafe/,
  );
  await assert.rejects(
    () => user.chats.import({
      source: {
        type: "files",
        files: [
          { path: "./src/index.ts", content: "one" },
          { path: "src/index.ts", content: "two" },
        ],
      },
    }),
    /duplicate path/,
  );
  await assert.rejects(
    () => user.chats.import({
      source: { type: "zip", bytes: zipSync({ "image.png": new Uint8Array([0xff, 0xfe]) }) },
    }),
    /not UTF-8 source text/,
  );
  await assert.rejects(
    () => user.chats.import({
      source: {
        type: "zip",
        bytes: zipSync({
          link: [strToU8("src/index.ts"), { os: 3, attrs: 0o120777 << 16 }],
        }),
      },
    }),
    /Symbolic links/,
  );
});

test("imports typed external sources through a provider-neutral adapter", async () => {
  const { viby, repository, generator } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const calls: unknown[] = [];
  const chat = await user.chats.import({
    metadata: { workspace: "workspace-1" },
    filePolicy: { locked: ["package.json"] },
    source: {
      type: "adapter",
      adapter: {
        name: "portable-source",
        async import(input: { project: string; credential: string }, context) {
          calls.push({ input, context });
          return {
            title: "Adapter project",
            summary: "Imported from an application-owned source adapter.",
            source: {
              type: "files" as const,
              files: [
                { path: "package.json", content: '{"name":"adapter-project"}\n' },
                { path: "src/index.ts", content: `export const project = "${input.project}";\n` },
              ],
            },
          };
        },
      },
      input: { project: "dashboard", credential: "must-not-be-persisted" },
    },
  });

  assert.equal(chat.title, "Adapter project");
  assert.deepEqual(chat.metadata, { workspace: "workspace-1" });
  const version = await chat.latestVersion();
  assert.ok(version);
  assert.equal(version.summary, "Imported from an application-owned source adapter.");
  assert.equal((await version.files()).find((file) => file.path === "package.json")?.locked, true);
  assert.deepEqual(calls, [{
    input: { project: "dashboard", credential: "must-not-be-persisted" },
    context: { tenantId: "tenant-a", userId: "user-a", framework: "farm" },
  }]);
  assert.equal(JSON.stringify([...repository.chats.values()]).includes("must-not-be-persisted"), false);
  assert.equal(JSON.stringify([...repository.versions.values()]).includes("must-not-be-persisted"), false);
  assert.equal(generator.calls.length, 0);
});

test("validates, cancels, and safely reports source adapter imports", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  await assert.rejects(
    () => user.chats.import({
      source: {
        type: "adapter",
        adapter: {
          name: "unsafe-source",
          async import() {
            return { source: { type: "files", files: [{ path: "../.env", content: "secret" }] } };
          },
        },
        input: null,
      },
    }),
    /unsafe/,
  );

  await assert.rejects(
    () => user.chats.import({
      source: {
        type: "adapter",
        adapter: {
          name: "failing-source",
          async import() {
            throw new Error("credential=must-not-be-reported");
          },
        },
        input: null,
      },
    }),
    (error: unknown) => (
      error instanceof SourceImportError
      && error.adapter === "failing-source"
      && !error.message.includes("must-not-be-reported")
    ),
  );

  const controller = new AbortController();
  controller.abort(new DOMException("Import cancelled.", "AbortError"));
  let called = false;
  await assert.rejects(
    () => user.chats.import({
      signal: controller.signal,
      source: {
        type: "adapter",
        adapter: {
          name: "cancelled-source",
          async import() {
            called = true;
            return { source: { type: "files", files: [{ path: "index.ts", content: "" }] } };
          },
        },
        input: null,
      },
    }),
    /Import cancelled/,
  );
  assert.equal(called, false);

  await assert.rejects(
    () => user.chats.import({
      source: {
        type: "adapter",
        adapter: {
          name: "invalid source name!",
          async import() {
            return { source: { type: "files", files: [{ path: "index.ts", content: "" }] } };
          },
        },
        input: null,
      },
    }),
    /adapter name/,
  );
});

test("applies writes, deletes, and moves as an immutable child snapshot", async () => {
  const { viby, generator } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.import({
    title: "Editable project",
    source: {
      type: "files",
      files: [
        { path: "src/index.ts", content: "export const version = 1;\n" },
        { path: "src/old.ts", content: "export const old = true;\n" },
        { path: "README.md", content: "# Before\n" },
      ],
    },
  });
  const first = await chat.latestVersion();
  assert.ok(first);

  const second = await first.apply({
    title: "Edited project",
    summary: "Applied a deterministic source patch.",
    changes: [
      { type: "write", path: "src/index.ts", content: "export const version = 2;\n" },
      { type: "delete", path: "src/old.ts" },
      { type: "move", from: "README.md", to: "docs/README.md" },
      { type: "write", path: "src/new.ts", content: "export const added = true;\n" },
    ],
  });

  assert.equal(second.number, 2);
  assert.equal(second.origin, "edited");
  assert.equal(second.parentVersionId, first.id);
  assert.equal(second.generationId, null);
  assert.deepEqual((await second.files()).map((file) => file.path), [
    "docs/README.md",
    "src/index.ts",
    "src/new.ts",
  ]);
  assert.equal((await first.files()).find((file) => file.path === "src/index.ts")?.content,
    "export const version = 1;\n");
  assert.ok((await first.files()).some((file) => file.path === "src/old.ts"));
  assert.deepEqual(await first.changes(), []);
  assert.deepEqual(await second.changes(), [
    { type: "write", path: "src/index.ts", content: "export const version = 2;\n" },
    { type: "delete", path: "src/old.ts" },
    { type: "move", from: "README.md", to: "docs/README.md" },
    { type: "write", path: "src/new.ts", content: "export const added = true;\n" },
  ]);
  assert.equal(generator.calls.length, 0);
});

test("stages agent workspace tools and atomically commits an immutable child version", async () => {
  const { viby, generator } = setup();
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.import({
      title: "Agent workspace",
      source: {
        type: "files",
        files: [
          { path: "README.md", content: "# Dashboard\n" },
          { path: "src/index.ts", content: "export const version = 1;\n" },
          { path: "src/old.ts", content: "export const old = true;\n" },
        ],
      },
    });
  const base = await chat.latestVersion();
  assert.ok(base);
  const workspace = await base.workspace();

  assert.equal(Object.isFrozen(workspace.tools), true);
  assert.deepEqual(
    (await workspace.tools.listFiles({ prefix: "src/" })).map((file) => file.path),
    ["src/index.ts", "src/old.ts"],
  );
  assert.equal((await workspace.tools.readFile({ path: "./src/index.ts" })).content,
    "export const version = 1;\n");
  assert.deepEqual(await workspace.tools.search({ query: "DASHBOARD" }), [{
    path: "README.md",
    line: 1,
    column: 3,
    preview: "# Dashboard",
  }]);

  await workspace.tools.writeFile({
    path: "./src/index.ts",
    content: "export const version = 2;\n",
    mediaType: " text/javascript ",
  });
  await workspace.tools.deleteFile({ path: "src/old.ts" });
  await workspace.tools.moveFile({ from: "README.md", to: "docs/README.md" });
  await workspace.tools.writeFile({
    path: "src/new.ts",
    content: "export const added = true;\n",
  });

  assert.equal(workspace.committed, false);
  assert.deepEqual(workspace.files().map((file) => file.path), [
    "docs/README.md",
    "src/index.ts",
    "src/new.ts",
  ]);
  assert.deepEqual((await base.files()).map((file) => file.path), [
    "README.md",
    "src/index.ts",
    "src/old.ts",
  ]);

  const committed = await workspace.commit({
    title: "Agent-refined dashboard",
    summary: "Committed four reviewed workspace operations.",
  });
  assert.equal(workspace.committed, true);
  assert.equal(committed.parentVersionId, base.id);
  assert.equal(committed.origin, "edited");
  assert.deepEqual(await committed.changes(), [
    {
      type: "write",
      path: "src/index.ts",
      content: "export const version = 2;\n",
      mediaType: "text/javascript",
    },
    { type: "delete", path: "src/old.ts" },
    { type: "move", from: "README.md", to: "docs/README.md" },
    { type: "write", path: "src/new.ts", content: "export const added = true;\n" },
  ]);
  await assert.rejects(() => workspace.commit(), /already committed/);
  await assert.rejects(
    () => workspace.tools.writeFile({ path: "src/late.ts", content: "late" }),
    /cannot change/,
  );
  assert.equal(generator.calls.length, 0);
});

test("rejects invalid agent workspace operations before creating a version", async () => {
  const { viby } = setup();
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.import({
      source: {
        type: "files",
        files: [
          { path: "src/index.ts", content: "export {};\n" },
          { path: "src/other.ts", content: "export {};\n" },
        ],
      },
    });
  const version = await chat.latestVersion();
  assert.ok(version);
  const workspace = await version.workspace();

  await assert.rejects(() => workspace.commit(), /no source changes/);
  await assert.rejects(() => workspace.tools.readFile({ path: "missing.ts" }), /not found/);
  await assert.rejects(
    () => workspace.tools.search({ query: "", limit: 0 }),
    /search query/,
  );
  await assert.rejects(
    () => workspace.tools.deleteFile({ path: "missing.ts" }),
    /delete missing/,
  );
  await assert.rejects(
    () => workspace.tools.moveFile({ from: "src/index.ts", to: "src/other.ts" }),
    /Cannot overwrite/,
  );
  assert.equal((await chat.listVersions()).items.length, 1);
});

test("deduplicates concurrent workspace commits and permits retry after persistence failure", async () => {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const workspace = new AgentWorkspace([{
    path: "src/index.ts",
    content: "export const version = 1;\n",
    mediaType: "text/javascript",
    size: 26,
    checksum: "before",
    locked: false,
  }], async (changes) => {
    calls += 1;
    if (calls === 1) throw new Error("temporary persistence failure");
    await gate;
    return changes.length;
  });
  await workspace.tools.writeFile({
    path: "src/index.ts",
    content: "export const version = 2;\n",
  });

  await assert.rejects(() => workspace.commit(), /temporary persistence failure/);
  assert.equal(workspace.committed, false);
  const first = workspace.commit();
  const second = workspace.commit();
  release();
  assert.equal(await first, 1);
  assert.equal(await second, 1);
  assert.equal(calls, 2);
  assert.equal(workspace.committed, true);
});

test("rejects invalid source change sets before persistence", async () => {
  const { viby } = setup();
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.import({
      source: {
        type: "files",
        files: [
          { path: "src/index.ts", content: "export {};\n" },
          { path: "src/other.ts", content: "export {};\n" },
        ],
      },
    });
  const version = await chat.latestVersion();
  assert.ok(version);

  await assert.rejects(() => version.apply({ changes: [] }), /at least one change/);
  await assert.rejects(
    () => version.apply({ changes: [{ type: "delete", path: "missing.ts" }] }),
    /delete missing/,
  );
  await assert.rejects(
    () => version.apply({
      changes: [{ type: "move", from: "src/index.ts", to: "src/other.ts" }],
    }),
    /Cannot overwrite/,
  );
  await assert.rejects(
    () => version.apply({
      changes: [{ type: "write", path: "../../secret", content: "nope" }],
    }),
    /unsafe/,
  );
  assert.equal((await chat.listVersions()).items.length, 1);
});

test("enforces immutable locked files across every source editing path", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.import({
    title: "Protected project",
    filePolicy: { locked: ["package.json"] },
    source: {
      type: "files",
      files: [
        { path: "package.json", content: "{}\n" },
        { path: "farm.config.ts", content: "export default {};\n", locked: true },
        { path: "src/index.ts", content: "export const version = 1;\n" },
      ],
    },
  });
  const version = await chat.latestVersion();
  assert.ok(version);
  assert.deepEqual((await version.files()).map(({ path, locked }) => ({ path, locked })), [
    { path: "farm.config.ts", locked: true },
    { path: "package.json", locked: true },
    { path: "src/index.ts", locked: false },
  ]);

  for (const changes of [
    [{ type: "write", path: "package.json", content: "changed" }] as const,
    [{ type: "delete", path: "package.json" }] as const,
    [{ type: "move", from: "package.json", to: "package.old.json" }] as const,
  ]) {
    await assert.rejects(() => version.apply({ changes }), /locked: package\.json/);
  }

  const workspace = await version.workspace();
  assert.equal((await workspace.tools.listFiles()).find((file) => file.path === "package.json")?.locked,
    true);
  await assert.rejects(
    () => workspace.tools.writeFile({ path: "package.json", content: "changed" }),
    /locked: package\.json/,
  );
  await assert.rejects(() => workspace.tools.deleteFile({ path: "package.json" }),
    /locked: package\.json/);
  await assert.rejects(
    () => workspace.tools.moveFile({ from: "package.json", to: "package.old.json" }),
    /locked: package\.json/,
  );

  const edited = await version.apply({
    changes: [{ type: "write", path: "src/index.ts", content: "export const version = 2;\n" }],
  });
  assert.equal((await edited.files()).find((file) => file.path === "package.json")?.locked, true);
  const forked = await version.fork();
  assert.equal((await (await forked.latestVersion())?.files())?.find(
    (file) => file.path === "package.json",
  )?.locked, true);
  const restored = await version.restore();
  assert.equal((await restored.files()).find((file) => file.path === "package.json")?.locked, true);

  await assert.rejects(() => version.iterate({ prompt: "Replace the entire project" }),
    /locked: farm\.config\.ts/);
  assert.equal((await chat.listVersions()).items.length, 3);
});

test("applies locked import policies to ZIP archives and validates policy paths", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.import({
    filePolicy: { locked: "all" },
    source: {
      type: "zip",
      bytes: zipSync({ "package.json": strToU8("{}\n"), "src/index.ts": strToU8("export {};\n") }),
    },
  });
  assert.equal((await (await chat.latestVersion())?.files())?.every((file) => file.locked), true);
  await assert.rejects(
    () => user.chats.import({
      filePolicy: { locked: ["missing.ts"] },
      source: { type: "files", files: [{ path: "src/index.ts", content: "export {};\n" }] },
    }),
    /not found in the import/,
  );
});

test("forks and restores exact immutable version snapshots", async () => {
  const { viby, generator, repository } = setup();
  const owner = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const stranger = viby.forUser({ tenantId: "tenant-b", userId: "user-b" });
  const chat = await owner.chats.import({
    title: "Source project",
    source: {
      type: "files",
      files: [{ path: "src/index.ts", content: "export const version = 1;\n" }],
    },
  });
  const first = await chat.latestVersion();
  assert.ok(first);
  const second = await first.apply({
    changes: [{ type: "write", path: "src/index.ts", content: "export const version = 2;\n" }],
  });

  const forkedChat = await first.fork({ title: "Version one experiment" });
  const forkedVersion = await forkedChat.latestVersion();
  assert.ok(forkedVersion);
  assert.notEqual(forkedChat.id, chat.id);
  assert.equal(forkedVersion.number, 1);
  assert.equal(forkedVersion.origin, "forked");
  assert.equal(forkedVersion.parentVersionId, first.id);
  assert.equal((await forkedVersion.files())[0]?.content, "export const version = 1;\n");

  const restored = await first.restore();
  assert.equal(restored.number, 3);
  assert.equal(restored.origin, "restored");
  assert.equal(restored.parentVersionId, first.id);
  assert.equal((await restored.files())[0]?.content, "export const version = 1;\n");
  assert.equal((await second.files())[0]?.content, "export const version = 2;\n");
  assert.equal((await chat.latestVersion())?.id, restored.id);
  assert.equal(generator.calls.length, 0);
  assert.equal(repository.messages.length, 0);
  await assert.rejects(() => stranger.chats.get(forkedChat.id), NotFoundError);
});

test("does not return a version that belongs to a different chat", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const firstChat = await user.chats.create();
  const secondChat = await user.chats.create();
  const version = await firstChat.generate({ prompt: "Build a dashboard" });

  await assert.rejects(() => secondChat.getVersion(version.id), NotFoundError);
});

test("never exposes records across tenants or users", async () => {
  const { viby } = setup();
  const owner = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const stranger = viby.forUser({ tenantId: "tenant-b", userId: "user-b" });
  const chat = await owner.chats.create();

  await assert.rejects(() => stranger.chats.get(chat.id), NotFoundError);
  assert.deepEqual((await stranger.chats.list()).items, []);
});

test("updates JSON chat metadata and paginates chats, messages, and versions", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const chat = await user.chats.create({
    title: "Original",
    metadata: { favorite: false, labels: ["dashboard"] },
  });
  const first = await chat.generate({ prompt: "First version" });
  const second = await first.iterate({ prompt: "Second version" });
  const third = await second.iterate({ prompt: "Third version" });

  const updated = await chat.update({
    title: "Updated dashboard",
    metadata: { favorite: true, nested: { owner: "design" } },
  });
  assert.equal(updated.title, "Updated dashboard");
  assert.deepEqual(updated.metadata, { favorite: true, nested: { owner: "design" } });
  assert.deepEqual((await user.chats.get(chat.id)).metadata, updated.metadata);

  const versionPageOne = await updated.listVersions({ limit: 2 });
  assert.deepEqual(versionPageOne.items.map((version) => version.id), [third.id, second.id]);
  assert.ok(versionPageOne.nextCursor);
  const versionPageTwo = await updated.listVersions({ limit: 2, after: versionPageOne.nextCursor });
  assert.deepEqual(versionPageTwo.items.map((version) => version.id), [first.id]);
  assert.equal(versionPageTwo.nextCursor, null);

  const messageIds: string[] = [];
  let messageCursor: string | undefined;
  do {
    const page = await updated.listMessages(
      messageCursor ? { limit: 2, after: messageCursor } : { limit: 2 },
    );
    messageIds.push(...page.items.map((message) => message.id));
    messageCursor = page.nextCursor ?? undefined;
  } while (messageCursor);
  assert.equal(messageIds.length, 6);
  assert.equal(new Set(messageIds).size, 6);

  const secondChat = await user.chats.create({ title: "Second chat" });
  await new Promise((resolve) => setTimeout(resolve, 2));
  const refreshed = await updated.update({ metadata: updated.metadata });
  const chatPageOne = await user.chats.list({ limit: 1 });
  assert.equal(chatPageOne.items[0]?.id, refreshed.id);
  assert.ok(chatPageOne.nextCursor);
  const chatPageTwo = await user.chats.list({ limit: 1, after: chatPageOne.nextCursor });
  assert.equal(chatPageTwo.items[0]?.id, secondChat.id);

  await assert.rejects(
    () => updated.listVersions({ after: chatPageOne.nextCursor! }),
    /cursor is invalid/,
  );
  await assert.rejects(
    () => updated.update({ metadata: { invalid: Number.POSITIVE_INFINITY } }),
    /must be finite/,
  );
});

test("soft deletes, restores, and purges chats according to retention", async () => {
  const { viby, repository } = setup();
  const owner = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const stranger = viby.forUser({ tenantId: "tenant-b", userId: "user-b" });
  const chat = await owner.chats.import({
    title: "Retained project",
    source: { type: "files", files: [{ path: "src/index.ts", content: "export {};\n" }] },
  });
  const version = await chat.latestVersion();
  assert.ok(version);

  const deleted = await chat.delete();
  assert.equal(deleted.chatId, chat.id);
  assert.equal(deleted.purgeAfter!.getTime() - deleted.deletedAt.getTime(), 30 * 24 * 60 * 60 * 1_000);
  await assert.rejects(() => owner.chats.get(chat.id), NotFoundError);
  await assert.rejects(() => chat.latestVersion(), NotFoundError);
  await assert.rejects(() => version.files(), NotFoundError);
  await assert.rejects(() => stranger.chats.restore(chat.id), NotFoundError);
  assert.deepEqual((await owner.chats.list()).items, []);

  const restored = await owner.chats.restore(chat.id);
  assert.equal((await restored.latestVersion())?.id, version.id);
  assert.equal((await version.files())[0]?.path, "src/index.ts");

  await restored.delete({ retentionMs: null });
  assert.equal(await owner.chats.purgeDeleted(), 0);
  const restoredAgain = await owner.chats.restore(chat.id);
  await restoredAgain.delete({ retentionMs: 0 });
  await assert.rejects(() => owner.chats.restore(chat.id), NotFoundError);
  assert.equal(await owner.chats.purgeDeleted(), 1);
  assert.equal(repository.chats.has(chat.id), false);
  assert.equal(repository.versions.has(version.id), false);
  assert.equal(await owner.chats.purgeDeleted(), 0);
});

test("rejects deletion while a chat has an active durable generation", async () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      generation: { execution: "worker" },
    },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();
  const generation = await chat.start({ prompt: "Build a dashboard" });
  await assert.rejects(() => chat.delete(), /active generation/);
  await generation.cancel("Delete requested.");
  assert.equal((await chat.delete({ retentionMs: 0 })).chatId, chat.id);
});

test("validates the declarative deleted-chat retention policy", () => {
  const repository = new MemoryRepository();
  const generator = new FakeGenerator<"farm">();
  const dependencies = { repository, generator, skillResolver: new SkillResolver({}) };
  assert.throws(
    () => createVibyWithDependencies({
      framework: "farm",
      model: "test/mock" as LanguageModel,
      retention: { deletedChatsMs: -1 },
    }, dependencies),
    /Deleted chat retention/,
  );
  assert.throws(
    () => createVibyWithDependencies({
      framework: "farm",
      model: "test/mock" as LanguageModel,
      retention: "forever" as never,
    }, dependencies),
    /retention must be an object/,
  );
});

test("filters tenant-scoped chat pages by nested metadata containment", async () => {
  const { viby } = setup();
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const first = await user.chats.create({
    title: "First dashboard",
    metadata: {
      workspace: { id: "workspace-1", owner: "design" },
      labels: ["dashboard", "analytics"],
    },
  });
  await user.chats.create({
    title: "Different workspace",
    metadata: { workspace: { id: "workspace-2" }, labels: ["dashboard"] },
  });
  const second = await user.chats.create({
    title: "Second dashboard",
    metadata: {
      workspace: { id: "workspace-1", owner: "engineering" },
      labels: ["saas", "dashboard"],
    },
  });
  const filter = { workspace: { id: "workspace-1" }, labels: ["dashboard"] };

  const pageOne = await user.chats.list({ limit: 1, metadata: filter });
  assert.equal(pageOne.items.length, 1);
  assert.ok(pageOne.nextCursor);
  const pageTwo = await user.chats.list({
    limit: 1,
    after: pageOne.nextCursor,
    metadata: filter,
  });
  assert.equal(pageTwo.items.length, 1);
  assert.equal(pageTwo.nextCursor, null);
  assert.deepEqual(
    new Set([...pageOne.items, ...pageTwo.items].map((chat) => chat.id)),
    new Set([first.id, second.id]),
  );
  assert.deepEqual((await user.chats.list({ metadata: { missing: true } })).items, []);
  assert.deepEqual(
    (await viby.forUser({ tenantId: "tenant-b", userId: "user-b" }).chats.list({
      metadata: filter,
    })).items,
    [],
  );
  await assert.rejects(
    () => user.chats.list({ metadata: { score: Number.NaN } }),
    /must be finite/,
  );
});

test("persists failed generation attempts without creating partial versions", async () => {
  const { viby, repository, generator } = setup();
  generator.shouldFail = true;
  const chat = await viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.create();

  await assert.rejects(
    () => chat.generate({ prompt: "Build a dashboard" }),
    (error: unknown) => error instanceof GenerationError && error.generationId.length > 0,
  );
  assert.equal([...repository.generations.values()][0]?.status, "failed");
  assert.equal((await chat.listVersions()).items.length, 0);
});
