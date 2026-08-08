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
import { GenerationError, NotFoundError } from "../src/errors.js";
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
  assert.deepEqual(messages[0]?.parts.map((part) => part.type), ["text"]);
  assert.deepEqual(messages[1]?.parts.map((part) => part.type), [
    "file-edit",
    "text",
    "usage",
  ]);
  const assistant = messages[1]!;
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
  await viby.close();
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
