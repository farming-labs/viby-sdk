import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, unzipSync } from "fflate";
import type { LanguageModelUsage } from "ai";
import { createVibyApi } from "../src/api-host.js";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const scope = { tenantId: "api-tenant", userId: "api-user" };
const usage: LanguageModelUsage = {
  inputTokens: 3,
  inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: 8,
};

test("hosts chat, message, stream, task, preview, and download flows with Web APIs", async () => {
  const inputs: GeneratorInput<"farm">[] = [];
  let release = 0;
  const generator: ProjectGenerator<"farm"> = {
    async generate(input, options): Promise<GeneratorOutput> {
      inputs.push(input);
      if (input.prompt.includes("approval") && !input.tasks.some((task) => task.status === "resolved")) {
        return {
          kind: "task",
          task: {
            kind: "permission",
            title: "Approve generated change",
            message: "The requested change requires approval.",
            action: "Continue generation",
            permissions: ["generation.continue"],
          },
          usage,
          finishReason: "tool-calls",
        };
      }
      release += 1;
      await options?.onDelta?.(`release-${release}`);
      const content = `export const release = ${release};\n`;
      if (input.previousFiles.length > 0) {
        return {
          kind: "changes",
          title: "API project",
          summary: `Updated release ${release}.`,
          changes: [{ type: "write", path: "src/index.ts", content }],
          usage,
          finishReason: "stop",
        };
      }
      return {
        kind: "project",
        title: "API project",
        summary: `Created release ${release}.`,
        files: [file("src/index.ts", content)],
        usage,
        finishReason: "stop",
      };
    },
  };
  const viby = createVibyWithDependencies(
    { framework: "farm", model: "test/api" as never },
    { repository: new MemoryRepository(), generator, skillResolver: new SkillResolver({}) },
  );
  const api = createVibyApi({
    viby,
    authenticate: async (request) => request.headers.get("authorization") === "Bearer test"
      ? scope
      : null,
    headers: { "X-Viby-Host": "test" },
    preview: async ({ version }) => ({
      versionId: version.id,
      url: `https://preview.example/${version.id}`,
    }),
  });
  try {
    const denied = await api.fetch(request("/chats"));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-viby-host"), "test");

    const created = await requestJson(api, "/chats", {
      method: "POST",
      body: JSON.stringify({
        title: "Analytics",
        metadata: { toolset: "docs" },
        prompt: "Build analytics",
      }),
    }, 201);
    const chatId = string(object(created.chat).id);
    const generationId = string(object(created.generation).id);

    const stream = await api.fetch(request(`/generations/${generationId}/events`, {}, true));
    assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(await stream.text(), /event: generation\.succeeded/);

    const generation = await requestJson(api, `/generations/${generationId}`);
    assert.equal(object(generation.generation).status, "succeeded");
    const chat = await requestJson(api, `/chats/${chatId}`);
    const firstVersion = object(array(chat.versions)[0]);
    const versionId = string(firstVersion.id);
    assert.equal(array(chat.messages).length, 2);

    const messages = await requestJson(api, `/chats/${chatId}/messages?limit=10`);
    const firstMessageId = string(object(array(messages.messages)[0]).id);
    assert.equal(object((await requestJson(api, `/chats/${chatId}/messages/${firstMessageId}`)).message).id, firstMessageId);

    const preview = await requestJson(api, `/chats/${chatId}/versions/${versionId}/preview`, {
      method: "POST",
    }, 201);
    assert.equal(preview.url, `https://preview.example/${versionId}`);

    const iterated = await requestJson(api, `/chats/${chatId}/versions/${versionId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        prompt: "Add a chart",
        attachments: [{
          filename: "brief.txt",
          mediaType: "text/plain",
          base64: btoa("dense chart"),
        }],
      }),
    }, 202);
    const iterationId = string(object(iterated.generation).id);
    assert.match(await (await api.fetch(request(`/generations/${iterationId}/events`, {}, true))).text(), /generation\.succeeded/);
    assert.equal(new TextDecoder().decode(inputs[1]?.attachments?.[0]?.bytes), "dense chart");

    const afterIteration = await requestJson(api, `/chats/${chatId}`);
    const latestVersion = object(array(afterIteration.versions)[0]);
    const latestVersionId = string(latestVersion.id);
    const download = await api.fetch(request(
      `/chats/${chatId}/versions/${latestVersionId}/download`,
      {},
      true,
    ));
    const archive = unzipSync(new Uint8Array(await download.arrayBuffer()));
    assert.equal(strFromU8(archive["src/index.ts"]!), "export const release = 2;\n");

    const waiting = await requestJson(api, `/chats/${chatId}/messages`, {
      method: "POST",
      body: JSON.stringify({ prompt: "Make an approval gated update" }),
    }, 202);
    const waitingId = string(object(waiting.generation).id);
    assert.match(await (await api.fetch(request(`/generations/${waitingId}/events`, {}, true))).text(), /attempt\.waiting/);
    const waitingData = await requestJson(api, `/generations/${waitingId}`);
    const taskId = string(object(array(waitingData.tasks)[0]).id);
    const resolved = await requestJson(api, `/generations/${waitingId}/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ resolution: { kind: "permission", decision: "allow" } }),
    }, 202);
    assert.ok(["queued", "running", "succeeded"].includes(string(object(resolved.generation).status)));
    assert.match(await (await api.fetch(request(`/generations/${waitingId}/events`, {}, true))).text(), /generation\.succeeded/);
    const events = await requestJson(api, `/generations/${waitingId}/events/page?after=0&limit=100`);
    assert.ok(array(events.events).some((event) => object(event).type === "task.resolved"));

    const updated = await requestJson(api, `/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Analytics workspace", metadata: { toolset: "private" } }),
    });
    assert.equal(object(updated.chat).title, "Analytics workspace");
    const listed = await requestJson(api, `/chats?metadata=${encodeURIComponent(JSON.stringify({ toolset: "private" }))}`);
    assert.equal(array(listed.chats).length, 1);
  } finally {
    await viby.close();
  }
});

test("handles public integration callbacks before product authentication", async () => {
  let authCalls = 0;
  const api = createVibyApi({
    viby: {
      framework: "farm",
      integrations: {
        callback: async (request: Request) => ({
          provider: new URL(request.url).searchParams.get("provider"),
          connected: true,
        }),
      },
      forUser: () => { throw new Error("callback must not create a user client"); },
      worker: () => { throw new Error("not used"); },
      close: async () => {},
    } as never,
    authenticate: async () => {
      authCalls += 1;
      return null;
    },
  });
  const response = await api.fetch(new Request(
    "https://app.example/api/viby/integrations/callback?provider=vercel",
  ));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { provider: "vercel", connected: true });
  assert.equal(authCalls, 0);
});

test("returns portable validation, method, route, and body-limit responses", async () => {
  const viby = {
    framework: "farm",
    integrations: { callback: async () => ({}) },
    forUser: () => ({ chats: { list: async () => ({ items: [], nextCursor: null }) } }),
    worker: () => { throw new Error("not used"); },
    close: async () => {},
  } as never;
  const api = createVibyApi({ viby, authenticate: () => scope, maxBodyBytes: 1_024 });
  assert.equal((await api.fetch(request("/missing", {}, true))).status, 404);
  assert.equal((await api.fetch(request("/chats", { method: "PUT" }, true))).status, 405);
  const oversized = await api.fetch(request("/chats", {
    method: "POST",
    body: JSON.stringify({ title: "x".repeat(2_000) }),
  }, true));
  assert.equal(oversized.status, 413);
  assert.equal(object(await oversized.json()).code, "body_too_large");
});

function file(path: string, content: string): VersionFile {
  return {
    path,
    content,
    mediaType: "text/typescript",
    size: new TextEncoder().encode(content).byteLength,
    checksum: sha256(content),
    locked: false,
  };
}

function request(path: string, init: RequestInit = {}, authorized = false): Request {
  return new Request(`https://app.example/api/viby${path}`, {
    ...init,
    headers: {
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(authorized ? { Authorization: "Bearer test" } : {}),
      ...Object.fromEntries(new Headers(init.headers)),
    },
  });
}

async function requestJson(
  api: { fetch(request: Request): Promise<Response> },
  path: string,
  init: RequestInit = {},
  status = 200,
): Promise<Record<string, unknown>> {
  const response = await api.fetch(request(path, init, true));
  const body = object(await response.json());
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}

function object(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === "object" && !Array.isArray(value));
  return value as Record<string, unknown>;
}

function array(value: unknown): unknown[] {
  assert.ok(Array.isArray(value));
  return value;
}

function string(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}
