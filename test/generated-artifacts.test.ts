import assert from "node:assert/strict";
import { test } from "node:test";
import { DefaultGeneratedFile, type LanguageModel, type LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import {
  generatedFileOutputs,
  type GeneratorOutput,
  type ProjectGenerator,
} from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 1,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 1,
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  totalTokens: 2,
};

function output(artifacts: NonNullable<GeneratorOutput["artifacts"]>): GeneratorOutput {
  const content = "export const generated = true;\n";
  return {
    kind: "project",
    title: "Artifact project",
    summary: "Generated source and durable media.",
    files: [{
      path: "src/index.ts",
      content,
      mediaType: "text/javascript",
      size: Buffer.byteLength(content),
      checksum: sha256(content),
      locked: false,
    }],
    artifacts,
    usage,
    finishReason: "stop",
  };
}

function setup(generator: ProjectGenerator<"farm">) {
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies({
    framework: "farm",
    model: "test/generated-artifacts" as LanguageModel,
  }, { repository, generator, skillResolver: new SkillResolver({}) });
  return { viby, repository };
}

test("persists generated images, audio, documents, and binary files by generation", async () => {
  const expected = [
    { kind: "image" as const, filename: "preview.png", mediaType: "image/png", bytes: new Uint8Array([1, 2]) },
    { kind: "audio" as const, filename: "voice.mp3", mediaType: "audio/mpeg", bytes: new Uint8Array([3, 4]) },
    { kind: "document" as const, filename: "report.pdf", mediaType: "application/pdf", bytes: new Uint8Array([5, 6]) },
    { kind: "binary" as const, filename: "bundle.bin", mediaType: "application/octet-stream", bytes: new Uint8Array([7, 8]) },
  ];
  const { viby } = setup({ async generate() { return output(expected); } });
  const user = viby.forUser({ tenantId: "tenant", userId: "user" });
  const chat = await user.chats.create();
  const generation = await chat.start({ prompt: "Generate a multimedia project" });
  assert.equal((await generation.wait()).status, "succeeded");

  const artifacts = await generation.artifacts();
  assert.deepEqual(artifacts.map(({ kind, filename, mediaType, size, versionId }) => ({
    kind,
    filename,
    mediaType,
    size,
    versionId: typeof versionId,
  })), expected.map(({ kind, filename, mediaType, bytes }) => ({
    kind,
    filename,
    mediaType,
    size: bytes.byteLength,
    versionId: "string",
  })));
  assert.equal(Object.hasOwn(artifacts[0]!, "bytes"), false);
  const content = await generation.getArtifact(artifacts[0]!.id);
  assert.deepEqual(content.bytes, new Uint8Array([1, 2]));
  content.bytes.fill(99);
  assert.deepEqual((await generation.getArtifact(artifacts[0]!.id)).bytes, new Uint8Array([1, 2]));
  assert.equal(content.checksum, sha256(new Uint8Array([1, 2])));
  assert.equal((await generation.events({ limit: 100 })).events
    .filter((event) => event.type === "artifact.created").length, 4);

  const other = viby.forUser({ tenantId: "tenant", userId: "other" });
  await assert.rejects(() => other.generations.get(generation.id));
  await viby.close();
});

test("rejects unsafe generated artifact output before persistence", async () => {
  const { viby, repository } = setup({
    async generate() {
      return output([{
        filename: "../secret.png",
        mediaType: "image/png",
        bytes: new Uint8Array([1]),
      }]);
    },
  });
  const generation = await (await viby
    .forUser({ tenantId: "tenant", userId: "user" })
    .chats.create())
    .start({ prompt: "Generate unsafe output" });
  const outcome = await generation.wait();
  assert.equal(outcome.status, "failed");
  assert.equal(repository.generatedArtifacts.size, 0);
  await viby.close();
});

test("maps AI SDK generated files to portable artifact output", () => {
  const source = new Uint8Array([9, 8, 7]);
  const artifacts = generatedFileOutputs([
    new DefaultGeneratedFile({ data: source, mediaType: "image/webp" }),
    new DefaultGeneratedFile({ data: new Uint8Array([1]), mediaType: "application/pdf" }),
  ]);

  assert.deepEqual(artifacts.map(({ kind, filename, mediaType }) => ({
    kind,
    filename,
    mediaType,
  })), [
    { kind: "image", filename: "generated-1.webp", mediaType: "image/webp" },
    { kind: "document", filename: "generated-2.pdf", mediaType: "application/pdf" },
  ]);
  source.fill(0);
  assert.deepEqual(artifacts[0]?.bytes, new Uint8Array([9, 8, 7]));
});

test("persists artifacts emitted alongside a blocking generation task", async () => {
  const { viby } = setup({
    async generate() {
      return {
        kind: "task",
        task: {
          kind: "question",
          title: "Choose an image",
          message: "Select the generated direction to continue.",
          question: "Which image should become the hero?",
          choices: ["First"],
          allowFreeform: true,
        },
        artifacts: [{
          filename: "direction.png",
          mediaType: "image/png",
          bytes: new Uint8Array([1, 3, 3, 7]),
        }],
        usage,
        finishReason: "stop",
      };
    },
  });
  const generation = await (await viby
    .forUser({ tenantId: "tenant", userId: "user" })
    .chats.create())
    .start({ prompt: "Create visual directions" });

  assert.equal((await generation.wait()).status, "waiting");
  const [artifact] = await generation.artifacts();
  assert.equal(artifact?.versionId, null);
  assert.equal(artifact?.kind, "image");
  assert.deepEqual((await generation.getArtifact(artifact!.id)).bytes, new Uint8Array([1, 3, 3, 7]));
  await viby.close();
});
