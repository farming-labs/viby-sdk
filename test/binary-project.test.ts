import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { unzipSync } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
} from "../src/sandbox.js";
import { sandboxCapabilities } from "../src/sandbox.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionArtifact } from "../src/types.js";
import { ConfigurationError, NotFoundError } from "../src/errors.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

class BinaryFixtureSandbox implements SandboxInstance {
  readonly id = "binary-fixture";
  readonly files = new Map<string, Uint8Array>();

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(file.path, typeof file.content === "string"
        ? Buffer.from(file.content)
        : Uint8Array.from(file.content));
    }
  }

  async run(_command: SandboxCommand) {
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (!content) throw new Error(`Missing sandbox fixture file: ${path}`);
    return Uint8Array.from(content);
  }

  async stop(): Promise<void> {}
}

class BinaryFixtureAdapter implements SandboxAdapter {
  readonly provider = "binary-fixture";
  readonly capabilities = sandboxCapabilities({ files: true, commands: true });
  readonly instances: BinaryFixtureSandbox[] = [];

  async create(_input: SandboxCreateInput): Promise<SandboxInstance> {
    const instance = new BinaryFixtureSandbox();
    this.instances.push(instance);
    return instance;
  }
}

const usage: LanguageModelUsage = {
  inputTokens: 1,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 1,
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  totalTokens: 2,
};

class BinaryFixtureGenerator implements ProjectGenerator<"farm"> {
  readonly calls: GeneratorInput<"farm">[] = [];

  async generate(input: GeneratorInput<"farm">): Promise<GeneratorOutput> {
    this.calls.push(input);
    return {
      kind: "changes",
      title: "Binary project iteration",
      summary: "Updated text without dropping binary assets.",
      changes: [{
        type: "write",
        path: "src/index.ts",
        content: "export const app = 'iterated';\n",
        mediaType: "text/javascript",
      }],
      usage,
      finishReason: "stop",
    };
  }
}

test("binary project entries conform across history, materialization, isolation, and cleanup", async () => {
  const repository = new MemoryRepository();
  const sandbox = new BinaryFixtureAdapter();
  const generator = new BinaryFixtureGenerator();
  const viby = createVibyWithDependencies({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    skills: {},
    sandbox,
  }, {
    repository,
    generator,
    skillResolver: new SkillResolver({}),
  });
  const owner = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const stranger = viby.forUser({ tenantId: "tenant-b", userId: "user-b" });
  const logo = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
  const font = new Uint8Array([0, 1, 0, 0, 102, 111, 110, 116]);

  const chat = await owner.chats.import({
    title: "Binary project",
    source: {
      type: "files",
      files: [
        { path: "src/index.ts", content: "export const app = true;\n" },
        { type: "artifact", path: "public/logo.png", bytes: logo, mediaType: "image/png" },
        {
          type: "artifact",
          path: "public/app.woff2",
          bytes: font,
          mediaType: "font/woff2",
          locked: true,
        },
      ],
    },
  });
  const initial = (await chat.latestVersion())!;
  assert.deepEqual((await initial.files()).map(({ path }) => path), ["src/index.ts"]);
  const initialEntries = await initial.entries();
  assert.deepEqual(initialEntries.map(({ path }) => path), [
    "public/app.woff2",
    "public/logo.png",
    "src/index.ts",
  ]);
  const logoEntry = initialEntries.find((entry): entry is VersionArtifact => (
    entry.type === "artifact" && entry.path === "public/logo.png"
  ));
  assert.ok(logoEntry);
  assert.deepEqual((await initial.projectArtifact(logoEntry.artifactId)).bytes, logo);
  await assert.rejects(() => stranger.chats.get(chat.id), NotFoundError);
  await assert.rejects(
    () => repository.getProjectArtifact(
      { tenantId: "tenant-b", userId: "user-b" },
      initial.id,
      logoEntry.artifactId,
    ).then((artifact) => {
      if (!artifact) throw new NotFoundError("Project artifact");
    }),
    NotFoundError,
  );

  const downloaded = await initial.download();
  const archive = unzipSync(downloaded.bytes);
  assert.deepEqual(archive["public/logo.png"], logo);
  assert.deepEqual(archive["public/app.woff2"], font);
  assert.equal(Buffer.from(archive["src/index.ts"]!).toString(), "export const app = true;\n");

  const roundTripChat = await owner.chats.import({
    title: "ZIP round trip",
    source: { type: "zip", bytes: downloaded.bytes },
  });
  const roundTrip = (await roundTripChat.latestVersion())!;
  assert.deepEqual((await roundTrip.download()).bytes.length > 0, true);
  const roundTripArchive = unzipSync((await roundTrip.download()).bytes);
  assert.deepEqual(roundTripArchive["public/logo.png"], logo);
  assert.deepEqual(roundTripArchive["public/app.woff2"], font);

  const session = await initial.sandbox();
  assert.deepEqual(sandbox.instances[0]?.files.get("public/logo.png"), logo);
  assert.deepEqual(sandbox.instances[0]?.files.get("public/app.woff2"), font);
  await session.stop();

  const moved = await initial.apply({
    changes: [{ type: "move", from: "public/logo.png", to: "assets/brand.png" }],
  });
  const movedLogo = (await moved.entries()).find((entry): entry is VersionArtifact => (
    entry.type === "artifact" && entry.path === "assets/brand.png"
  ));
  assert.ok(movedLogo);
  assert.equal(movedLogo.artifactId, logoEntry.artifactId);
  assert.deepEqual((await moved.projectArtifact(movedLogo.artifactId)).bytes, logo);

  const iterated = await moved.iterate({ prompt: "Update the application copy" });
  assert.equal(generator.calls[0]?.previousEntries?.some((entry) => entry.type === "artifact"), true);
  const iteratedLogo = (await iterated.entries()).find((entry): entry is VersionArtifact => (
    entry.type === "artifact" && entry.path === "assets/brand.png"
  ));
  assert.ok(iteratedLogo);
  assert.equal(iteratedLogo.artifactId, logoEntry.artifactId);
  assert.deepEqual((await iterated.projectArtifact(iteratedLogo.artifactId)).bytes, logo);
  await assert.rejects(
    () => moved.apply({ changes: [{ type: "delete", path: "public/app.woff2" }] }),
    (error: unknown) => error instanceof ConfigurationError && /locked/.test(error.message),
  );

  const withoutLogo = await moved.apply({
    changes: [{ type: "delete", path: "assets/brand.png" }],
  });
  assert.equal((await withoutLogo.entries()).some(({ path }) => path === "assets/brand.png"), false);
  assert.deepEqual((await initial.projectArtifact(logoEntry.artifactId)).bytes, logo);

  const restored = await initial.restore();
  assert.deepEqual((await restored.entries()).map(({ path }) => path), initialEntries.map(({ path }) => path));
  const fork = await moved.fork({ title: "Binary project fork" });
  const forked = (await fork.latestVersion())!;
  const forkedLogo = (await forked.entries()).find((entry): entry is VersionArtifact => (
    entry.type === "artifact" && entry.path === "assets/brand.png"
  ));
  assert.ok(forkedLogo);
  assert.equal(forkedLogo.artifactId, logoEntry.artifactId);
  assert.deepEqual((await forked.projectArtifact(forkedLogo.artifactId)).bytes, logo);

  assert.equal(repository.projectArtifacts.size, 4);
  await chat.delete({ retentionMs: 0 });
  await fork.delete({ retentionMs: 0 });
  await roundTripChat.delete({ retentionMs: 0 });
  assert.equal(await owner.chats.purgeDeleted(), 3);
  assert.equal(repository.projectArtifacts.size, 0);
  await viby.close();
});
