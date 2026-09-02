import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyApi } from "../src/api-host.js";
import { createVibyWithDependencies } from "../src/client.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "../src/generator.js";
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
import { MemoryEnvironmentVariableStore } from "./helpers/memory-environment-store.js";

const usage: LanguageModelUsage = {
  inputTokens: 10,
  inputTokenDetails: { noCacheTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 20,
  outputTokenDetails: { textTokens: 20, reasoningTokens: 0 },
  totalTokens: 30,
};

class WebClientGenerator implements ProjectGenerator<"farm"> {
  async generate(input: GeneratorInput<"farm">, options?: GeneratorOptions): Promise<GeneratorOutput> {
    await options?.attribution?.record({
      idempotencyKey: `web:${options.run?.attemptId ?? "direct"}`,
      providerRequestId: `req_${options.run?.attemptId ?? "direct"}`,
      outcome: "succeeded",
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      totalTokens: usage.totalTokens ?? null,
      cacheReadTokens: usage.inputTokenDetails.cacheReadTokens ?? null,
      latencyMs: 12,
    });
    if (input.operation === "inspect") {
      return {
        kind: "message",
        content: "`src/index.ts` contains the generated prompt.",
        usage,
        finishReason: "stop",
      };
    }
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
      environment: { store: new MemoryEnvironmentVariableStore() },
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
    const queued = await client.chats.queue.create(created.chat.id, {
      prompt: "Add a revenue trend",
      afterGenerationId: created.generation.id,
    });
    for await (const _event of client.generations.stream(queued.generation.id)) {
      // Consume the resumable stream through its terminal event.
    }
    const queuedOutcome = await client.generations.get(queued.generation.id);
    assert.equal(queuedOutcome.generation.status, "succeeded");
    assert.equal(queuedOutcome.generation.afterGenerationId, created.generation.id);
    assert.equal(queuedOutcome.generation.baseVersionId, generation.version!.id);
    assert.deepEqual((await client.chats.queue.list(created.chat.id)).generations, []);
    const providerRequests = await client.generations.providerRequests(created.generation.id);
    assert.equal(providerRequests.providerRequests.length, 1);
    assert.match(providerRequests.providerRequests[0]!.providerRequestId!, /^req_/);
    const detail = await client.chats.get(created.chat.id);
    assert.equal(detail.messages.length, 4);
    assert.equal(detail.versions.length, 2);
    const assistant = detail.messages.find((message) => message.role === "assistant")!;
    const submittedFeedback = await client.chats.messages.submitFeedback(
      created.chat.id,
      assistant.id,
      {
        rating: "positive",
        reasons: ["accurate"],
        idempotencyKey: "web-feedback-1",
      },
    );
    assert.equal(submittedFeedback.feedback.messageId, assistant.id);
    const listedFeedback = await client.chats.messages.listFeedback(created.chat.id, assistant.id);
    assert.equal(listedFeedback.feedback.length, 1);
    assert.equal(listedFeedback.selected?.id, submittedFeedback.feedback.id);
    const feedbackAnalytics = await client.feedback.analytics({
      groupBy: ["model", "framework"],
    });
    assert.equal(feedbackAnalytics.analytics.totals.total, 1);
    assert.deepEqual(feedbackAnalytics.analytics.buckets[0]?.dimensions, {
      model: { provider: "test", id: "test/web-client" },
      framework: "farm",
    });

    const inspection = await client.chats.versions.inspect(
      created.chat.id,
      generation.version!.id,
      { prompt: "What is in src/index.ts?" },
    );
    const inspectionEvents = [];
    for await (const event of client.generations.stream(inspection.generation.id)) {
      inspectionEvents.push(event);
    }
    assert.equal(inspectionEvents.at(-1)?.type, "generation.succeeded");
    assert.equal((await client.generations.get(inspection.generation.id)).version, null);
    const inspectedDetail = await client.chats.get(created.chat.id);
    assert.equal(inspectedDetail.messages.at(-1)?.content, "`src/index.ts` contains the generated prompt.");
    assert.equal(inspectedDetail.versions.length, 2);

    const imported = await client.chats.import({
      title: "Imported web project",
      source: {
        type: "files",
        files: [
          { path: "src/imported.ts", content: "export const imported = true;\n" },
          {
            type: "artifact",
            path: "public/mark.bin",
            mediaType: "application/octet-stream",
            bytes: new Uint8Array([0, 1, 2, 255]),
          },
        ],
      },
    });
    assert.equal(imported.chat.title, "Imported web project");
    const importedVersion = await client.chats.versions.get(imported.chat.id, imported.version.id);
    assert.equal(importedVersion.entries.length, 2);
    assert.equal(
      importedVersion.entries.find((entry) => entry.path === "public/mark.bin")?.type,
      "artifact",
    );

    const edited = await client.chats.versions.apply(created.chat.id, generation.version!.id, {
      title: "Edited web project",
      changes: [{
        type: "write",
        path: "src/index.ts",
        content: "export const edited = true;\n",
      }],
    });
    assert.equal(edited.version.parentVersionId, generation.version!.id);
    assert.equal(edited.entries[0]?.type, "text");
    assert.equal(
      (await client.chats.versions.changes(created.chat.id, edited.version.id)).changes[0]?.type,
      "write",
    );

    const restoredVersion = await client.chats.versions.restore(
      created.chat.id,
      generation.version!.id,
      { title: "Restored web project" },
    );
    assert.ok(restoredVersion.version.parentVersionId);
    assert.equal(restoredVersion.version.origin, "restored");
    const forked = await client.chats.versions.fork(created.chat.id, edited.version.id, {
      title: "Forked web project",
      metadata: { workspace: "fork" },
    });
    assert.notEqual(forked.chat.id, created.chat.id);
    assert.equal(forked.version.origin, "forked");

    const savedVariable = await client.chats.environment.set(created.chat.id, {
      environment: "preview",
      name: "PUBLIC_API_ORIGIN",
      value: "https://api.example",
    });
    assert.equal(savedVariable.variable.name, "PUBLIC_API_ORIGIN");
    assert.equal(
      (await client.chats.environment.list(created.chat.id, { environment: "preview" }))
        .variables[0]?.value,
      "https://api.example",
    );
    assert.equal(
      (await client.chats.environment.delete(
        created.chat.id,
        "preview",
        "PUBLIC_API_ORIGIN",
      )).deleted,
      true,
    );

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

    await client.chats.delete(forked.chat.id);
    assert.equal((await client.chats.restore(forked.chat.id)).chat.id, forked.chat.id);
  } finally {
    await viby.close();
  }
});

test("maps provider-neutral preview and integration operations onto the Web API", async () => {
  const requests: Array<{ readonly method: string; readonly url: string; readonly body: unknown }> = [];
  const client = createVibyWebClient({
    baseUrl: "https://app.example/api/viby",
    fetch: async (input, init) => {
      requests.push({
        method: init?.method ?? "GET",
        url: String(input),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      const path = new URL(String(input)).pathname;
      if (path.endsWith("/steering")) {
        return init?.method === "POST"
          ? Response.json({ steering: { id: "steering-1", status: "queued" } })
          : Response.json({ steering: [] });
      }
      if (path.endsWith("/previews")) return Response.json({ previews: [] });
      if (path.endsWith("/previews/cleanup")) return Response.json({ cleaned: 2 });
      if (path.includes("/previews/")) {
        return Response.json({ preview: { id: "preview-1", status: "ready" } });
      }
      if (path.endsWith("/connections")) return Response.json({ connections: [] });
      if (path.endsWith("/connect")) {
        return Response.json({ result: { status: "authorization-required", url: "https://provider.example" } });
      }
      if (path.includes("/connections/")) {
        return Response.json({ result: { connection: { status: "revoked" }, providerRevoked: true } });
      }
      if (path.endsWith("/owners")) return Response.json({ items: [], nextCursor: null });
      if (path.endsWith("/repositories")) {
        return init?.method === "POST"
          ? Response.json({ repository: { id: "repository-1" } }, { status: 201 })
          : Response.json({ items: [], nextCursor: null });
      }
      if (path.endsWith("/branches")) {
        return init?.method === "POST"
          ? Response.json({ branch: { name: "feature" } }, { status: 201 })
          : Response.json({ items: [], nextCursor: null });
      }
      if (path.endsWith("/projects")) {
        return init?.method === "POST"
          ? Response.json({ project: { id: "project-1" } }, { status: 201 })
          : Response.json({ items: [], nextCursor: null });
      }
      if (path.includes("/deployments/")) {
        return Response.json({ deployment: { id: "deployment-1", status: "ready" } });
      }
      return Response.json({ integrations: [] });
    },
  });

  await client.generations.steering("generation-1");
  await client.generations.steer("generation-1", {
    prompt: "Use the reference",
    idempotencyKey: "composer-1",
    attachments: [{
      filename: "reference.txt",
      mediaType: "text/plain",
      bytes: new TextEncoder().encode("compact"),
    }],
  });
  await client.previews.list({ chatId: "chat-1", status: "ready" });
  await client.previews.get("preview-1");
  await client.previews.stop("preview-1");
  await client.previews.reconnect("preview-1");
  assert.equal((await client.previews.cleanup(10)).cleaned, 2);
  await client.integrations.repository.list();
  await client.integrations.repository.connections("github");
  await client.integrations.repository.connect("github", {
    callbackUrl: "https://app.example/callback",
    returnTo: "/settings",
    authorization: { account: "existing", externalAccountId: "42" },
  });
  await client.integrations.repository.disconnect("github", "connection-1");
  await client.integrations.repository.owners("github", { connectionId: "connection-1" });
  await client.integrations.repository.repositories("github", {
    owner: "farming-labs",
    connectionId: "connection-1",
  });
  await client.integrations.repository.createRepository("github", {
    owner: "farming-labs",
    name: "viby",
  }, { connectionId: "connection-1" });
  await client.integrations.repository.branches("github", {
    repository: { owner: "farming-labs", name: "viby" },
    connectionId: "connection-1",
  });
  await client.integrations.repository.createBranch("github", {
    repository: { owner: "farming-labs", name: "viby" },
    name: "feature",
    from: "main",
  }, { connectionId: "connection-1" });
  await client.integrations.deployment.projects("vercel", { connectionId: "connection-2" });
  await client.integrations.deployment.createProject("vercel", { name: "viby" }, {
    connectionId: "connection-2",
  });
  await client.integrations.deployment.getDeployment("vercel", "deployment-1", {
    connectionId: "connection-2",
  });
  await client.integrations.deployment.cancelDeployment(
    "vercel",
    "deployment-1",
    "cancel-1",
    { connectionId: "connection-2" },
  );

  assert.deepEqual(requests[1], {
    method: "POST",
    url: "https://app.example/api/viby/generations/generation-1/steering",
    body: {
      prompt: "Use the reference",
      idempotencyKey: "composer-1",
      attachments: [{
        filename: "reference.txt",
        mediaType: "text/plain",
        base64: "Y29tcGFjdA==",
      }],
    },
  });
  assert.equal(requests[2]?.url,
    "https://app.example/api/viby/previews?chatId=chat-1&status=ready");
  assert.deepEqual(requests.find((item) => item.url.endsWith("/integrations/repository/github/connect")), {
    method: "POST",
    url: "https://app.example/api/viby/integrations/repository/github/connect",
    body: {
      callbackUrl: "https://app.example/callback",
      returnTo: "/settings",
      authorization: { account: "existing", externalAccountId: "42" },
    },
  });
  assert.deepEqual(requests.find((item) => item.url.includes("/branches?")), {
    method: "GET",
    url: "https://app.example/api/viby/integrations/repository/github/branches?owner=farming-labs&name=viby&connectionId=connection-1",
    body: null,
  });
  assert.deepEqual(requests.at(-1), {
    method: "DELETE",
    url: "https://app.example/api/viby/integrations/deployment/vercel/deployments/deployment-1?connectionId=connection-2",
    body: { idempotencyKey: "cancel-1" },
  });
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

test("consumes streamed preview terminal output and the final result", async () => {
  let accept: string | null = null;
  const client = createVibyWebClient({
    baseUrl: "https://app.example/api/viby",
    fetch: async (_input, init) => {
      accept = new Headers(init?.headers).get("accept");
      return new Response([
        "event: command.output",
        `data: ${JSON.stringify({
          type: "command.output",
          previewId: "preview-1",
          stage: "prepare",
          index: 0,
          stream: "stdout",
          data: "installed dependencies\n",
          createdAt: "2026-08-15T10:00:00.000Z",
        })}`,
        "",
        "event: preview.result",
        `data: ${JSON.stringify({
          type: "preview.result",
          result: { url: "https://preview.example" },
        })}`,
        "",
        "",
      ].join("\n"), {
        headers: { "Content-Type": "text/event-stream" },
      });
    },
  });

  const events = [];
  for await (const event of client.chats.versions.previewStream<{ readonly url: string }>(
    "chat-1",
    "version-1",
  )) {
    events.push(event);
  }

  assert.equal(accept, "text/event-stream");
  assert.deepEqual(events.map((event) => event.type), ["command.output", "preview.result"]);
  assert.equal(events[1]?.type === "preview.result" ? events[1].result.url : null,
    "https://preview.example");
});

test("binds the default fetch implementation to the Web global", async () => {
  const originalFetch = globalThis.fetch;
  let receiver: unknown;
  globalThis.fetch = function (this: unknown) {
    receiver = this;
    return Promise.resolve(Response.json({ chats: [], nextCursor: null }));
  } as typeof globalThis.fetch;

  try {
    const client = createVibyWebClient({ baseUrl: "https://app.example/api/viby" });
    await client.chats.list();
    assert.equal(receiver, globalThis);
  } finally {
    globalThis.fetch = originalFetch;
  }
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
