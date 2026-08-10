import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import { createReferenceApp } from "../../examples/reference/src/app.ts";
import { createVibyWithDependencies } from "../../src/client.ts";
import { sandboxCapabilities } from "../../src/sandbox.ts";
import { SkillResolver } from "../../src/skills.ts";
import { sha256 } from "../../src/utils.ts";
import { MemoryRepository } from "../helpers/memory-repository.ts";

test("runs chat, stream, preview, iterate, and download through the reference app", async () => {
  const repository = new MemoryRepository();
  const generatedInputs = [];
  const sandboxCalls = [];
  let generationNumber = 0;
  const generator = {
    async generate(input, options) {
      generatedInputs.push(input);
      generationNumber += 1;
      const source = `export const release = ${generationNumber};\n`;
      await options?.onDelta?.(`release-${generationNumber}`);
      return {
        kind: "project",
        title: "Reference workspace",
        summary: `Completed product version ${generationNumber}.`,
        files: [
          file("package.json", JSON.stringify({
            name: "reference-output",
            scripts: { dev: "farm start" },
          })),
          file("src/main.ts", source),
        ],
        usage: {
          inputTokens: 10,
          inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
          outputTokens: 20,
          outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
          totalTokens: 30,
        },
        finishReason: "stop",
      };
    },
  };
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
  const viby = createVibyWithDependencies(
    { framework: "farm", model: "test/reference", skills: {}, sandbox },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const app = createReferenceApp({
    viby,
    scope: { tenantId: "reference-tenant", userId: "reference-user" },
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
    assert.equal(generatedInputs[1].previousFiles[1].content, "export const release = 1;\n");

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
  } finally {
    await viby.close();
  }
});

function file(path, content) {
  return {
    path,
    content,
    mediaType: path.endsWith(".json") ? "application/json" : "text/typescript",
    size: Buffer.byteLength(content),
    checksum: sha256(content),
    locked: false,
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
