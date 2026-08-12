import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyApi } from "../src/api-host.js";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import { defineToolSourceAdapter } from "../src/tool-source-registry.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import {
  createVibyWebClient,
  VibyApiClientError,
} from "../src/web-client.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import { MemorySecretStore } from "./helpers/memory-integration-store.js";

const usage: LanguageModelUsage = {
  inputTokens: 10,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 20,
  outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
  totalTokens: 30,
};

class WebClientGenerator implements ProjectGenerator<"farm"> {
  async generate(input: GeneratorInput<"farm">): Promise<GeneratorOutput> {
    const content = `export const prompt = ${JSON.stringify(input.prompt)};\n`;
    const file: VersionFile = {
      path: "src/index.ts",
      content,
      mediaType: "text/typescript",
      size: new TextEncoder().encode(content).byteLength,
      checksum: sha256(content),
      locked: false,
    };
    return {
      kind: "project",
      title: "Web client project",
      summary: "Generated through the Web API client.",
      files: [file],
      usage,
      finishReason: "stop",
    };
  }
}

test("consumes the Web API host through typed chat, stream, preview, and download operations", async () => {
  const secrets = new MemorySecretStore();
  const toolAdapter = defineToolSourceAdapter<"farm">({
    type: "web-oauth",
    authorization: {
      provider: "web-oauth-provider",
      async startAuthorization(input) {
        return {
          url: `https://provider.example/oauth?state=${encodeURIComponent(input.state)}`,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
      async completeAuthorization() {
        return {
          account: { id: "web-account", name: "Web account" },
          credential: {
            secret: new TextEncoder().encode("web-access-token"),
            scopes: ["tools:read"],
            expiresAt: null,
          },
        };
      },
    },
    open: ({ source }) => ({ id: source.id, list: async () => [], call: async () => null }),
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/web-client" as LanguageModel,
      storage: { secrets },
      tools: { adapters: { "web-oauth": toolAdapter } },
    },
    {
      repository: new MemoryRepository(),
      generator: new WebClientGenerator(),
      skillResolver: new SkillResolver({}),
    },
  );
  const api = createVibyApi({
    viby,
    authenticate: (request) => request.headers.has("authorization")
      ? { tenantId: "tenant-web", userId: "user-web" }
      : null,
    preview: ({ version }) => ({ url: `https://preview.example/${version.id}` }),
  });
  const client = createVibyWebClient<"farm">({
    baseUrl: "https://app.example/api/viby",
    headers: async () => ({ Authorization: "Bearer browser-session" }),
    fetch: (input, init) => api.fetch(new Request(input, init)),
  });

  try {
    const created = await client.chats.create({
      title: "Analytics",
      metadata: { workspace: "design" },
      prompt: "Build an analytics dashboard",
      attachments: [{
        filename: "brief.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("Compact navigation"),
      }],
    });
    assert.equal(created.chat.framework, "farm");
    assert.equal(typeof created.chat.createdAt, "string");

    const events = [];
    for await (const event of client.generations.stream(created.generation.id)) events.push(event);
    assert.equal(events.at(-1)?.type, "generation.succeeded");
    assert.equal(typeof events.at(-1)?.createdAt, "string");

    const generation = await client.generations.get(created.generation.id);
    assert.equal(generation.generation.status, "succeeded");
    assert.ok(generation.version);
    const detail = await client.chats.get(created.chat.id);
    assert.equal(detail.messages.length, 2);
    assert.equal(detail.versions.length, 1);

    const preview = await client.chats.versions.preview<{ readonly url: string }>(
      created.chat.id,
      generation.version!.id,
    );
    assert.match(preview.url, /^https:\/\/preview\.example\//);
    const download = await client.chats.versions.download(
      created.chat.id,
      generation.version!.id,
    );
    assert.equal(download.headers.get("content-type"), "application/zip");
    assert.ok((await download.arrayBuffer()).byteLength > 0);

    const listed = await client.chats.list({ metadata: { workspace: "design" } });
    assert.deepEqual(listed.chats.map((chat) => chat.id), [created.chat.id]);

    const registered = await client.toolSources.create({
      type: "web-oauth",
      name: "Web tools",
      configuration: { endpoint: "https://tools.example" },
    });
    assert.equal(registered.toolSource.status, "active");
    const selected = await client.chats.toolSources.set(created.chat.id, [registered.toolSource.id]);
    assert.deepEqual(selected.toolSources.map((source) => source.id), [registered.toolSource.id]);
    assert.deepEqual(
      (await client.chats.toolSources.list(created.chat.id)).toolSources.map((source) => source.id),
      [registered.toolSource.id],
    );
    const authorization = await client.toolSources.connect(registered.toolSource.id, {
      callbackUrl: "https://app.example/api/viby/tool-sources/callback",
      returnTo: "/settings/tools",
    });
    assert.equal(authorization.result.status, "authorization-required");
    if (authorization.result.status !== "authorization-required") return;
    const state = new URL(authorization.result.url).searchParams.get("state");
    assert.ok(state);
    const callback = await api.fetch(new Request(
      `https://app.example/api/viby/tool-sources/callback?state=${encodeURIComponent(state)}&code=approved`,
    ));
    assert.equal(callback.status, 200);
    assert.equal((await client.toolSources.connection(registered.toolSource.id)).connection?.status, "active");
    assert.equal((await client.toolSources.list({ type: "web-oauth" })).toolSources.length, 1);
    assert.equal((await client.toolSources.update(registered.toolSource.id, {
      name: "Updated web tools",
    })).toolSource.name, "Updated web tools");
    assert.equal(
      (await client.toolSources.disconnect(registered.toolSource.id)).result.connection.status,
      "revoked",
    );
    assert.equal(
      (await client.toolSources.archive(registered.toolSource.id)).toolSource.status,
      "archived",
    );
  } finally {
    await viby.close();
  }
});

test("reconnects an interrupted SSE stream from its last durable cursor", async () => {
  const requests: Array<string | null> = [];
  let calls = 0;
  const client = createVibyWebClient({
    baseUrl: "https://app.example/api/viby",
    fetch: async (_input, init) => {
      calls += 1;
      requests.push(new Headers(init?.headers).get("last-event-id"));
      return new Response(calls === 1
        ? sseEvent("1", "generation.created", { prompt: "Build" })
        : sseEvent("2", "generation.succeeded", { versionId: "version-1" }), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const cursors: string[] = [];
  for await (const event of client.generations.stream("generation-1", { retryMs: 0 })) {
    cursors.push(event.cursor);
  }

  assert.deepEqual(cursors, ["1", "2"]);
  assert.deepEqual(requests, [null, "1"]);
});

test("returns typed API errors without retrying authorization failures", async () => {
  const client = createVibyWebClient({
    baseUrl: "https://app.example/api/viby",
    fetch: async () => Response.json({
      error: "Authentication required.",
      code: "unauthorized",
    }, { status: 401 }),
  });

  await assert.rejects(client.chats.list(), (error) => {
    assert.ok(error instanceof VibyApiClientError);
    assert.equal(error.status, 401);
    assert.equal(error.code, "unauthorized");
    return true;
  });
});

function sseEvent(cursor: string, type: string, data: Record<string, unknown>): string {
  return [
    "retry: 0",
    "",
    `id: ${cursor}`,
    `event: ${type}`,
    `data: ${JSON.stringify({
      cursor,
      generationId: "generation-1",
      attemptId: "attempt-1",
      type,
      data,
      createdAt: "2026-08-12T00:00:00.000Z",
    })}`,
    "",
    "",
  ].join("\n");
}
