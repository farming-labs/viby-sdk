import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import type {
  GeneratorInput,
  GeneratorOutput,
  ProjectGenerator,
} from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
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
  assert.deepEqual(await stranger.chats.list(), []);
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
  assert.equal((await chat.listVersions()).length, 0);
});
