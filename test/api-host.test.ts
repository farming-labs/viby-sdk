import assert from "node:assert/strict";
import { test } from "node:test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import type { LanguageModelUsage } from "ai";
import { createVibyApi } from "../src/api-host.js";
import { createVibyWithDependencies } from "../src/client.js";
import { EnvironmentManager } from "../src/environment.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import type { FrameworkId, VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import { MemoryEnvironmentVariableStore } from "./helpers/memory-environment-store.js";
import { MemorySecretStore } from "./helpers/memory-integration-store.js";
import type {
  ChatReadSnapshotOptions,
  GenerationReadSnapshot,
} from "../src/repository.js";

const scope = { tenantId: "api-tenant", userId: "api-user" };
const usage: LanguageModelUsage = {
  inputTokens: 3,
  inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: 8,
};

class SnapshotMemoryRepository extends MemoryRepository {
  snapshotReads = 0;
  generationSnapshotReads = 0;

  async readChatSnapshot<Framework extends FrameworkId>(
    readScope: typeof scope,
    options: ChatReadSnapshotOptions,
  ) {
    this.snapshotReads += 1;
    const [chat, messages, versions] = await Promise.all([
      this.getChat<Framework>(readScope, options.chatId),
      this.listMessagePage(
        readScope,
        options.chatId,
        options.messages.limit,
        options.messages.after,
      ),
      this.listVersionPage<Framework>(
        readScope,
        options.chatId,
        options.versions.limit,
        options.versions.after,
      ),
    ]);
    return chat ? { chat, messages, versions } : null;
  }

  async readGenerationSnapshot<Framework extends FrameworkId>(
    readScope: typeof scope,
    generationId: string,
  ): Promise<GenerationReadSnapshot<Framework> | null> {
    this.generationSnapshotReads += 1;
    const generation = await this.getGeneration(readScope, generationId);
    if (!generation) return null;
    const [attempts, tasks, steering, toolCalls, artifacts, version] = await Promise.all([
      this.listGenerationAttempts(readScope, generationId),
      this.listGenerationTasks(readScope, generationId),
      this.listGenerationSteering(readScope, generationId),
      this.listToolCalls(readScope, generationId),
      this.listGeneratedArtifacts(readScope, generationId),
      this.getVersionByGeneration<Framework>(readScope, generationId),
    ]);
    return { generation, attempts, tasks, steering, toolCalls, artifacts, version };
  }
}

test("hosts chat, message, stream, task, preview, and download flows with Web APIs", async () => {
  const inputs: GeneratorInput<"farm">[] = [];
  const steeringPrompts: string[] = [];
  let release = 0;
  const generator: ProjectGenerator<"farm"> = {
    async generate(input, options): Promise<GeneratorOutput> {
      inputs.push(input);
      steeringPrompts.push(...(await options?.steering?.consume() ?? []).map((entry) => entry.prompt));
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
  const repository = new SnapshotMemoryRepository();
  const viby = createVibyWithDependencies(
    { framework: "farm", model: "test/api" as never },
    {
      repository,
      generator,
      skillResolver: new SkillResolver({}),
      environment: new EnvironmentManager(
        new MemoryEnvironmentVariableStore(),
        new MemorySecretStore(),
      ),
    },
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

    const secret = await requestJson(api, `/chats/${chatId}/environment/preview/API_TOKEN`, {
      method: "PUT",
      body: JSON.stringify({ value: "private-token", secret: true }),
    });
    assert.equal(object(secret.variable).value, null);
    const environment = await requestJson(api, `/chats/${chatId}/environment?environment=preview`);
    assert.deepEqual(array(environment.variables).map((value) => object(value).name), ["API_TOKEN"]);

    const stream = await api.fetch(request(`/generations/${generationId}/events`, {}, true));
    assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
    assert.match(await stream.text(), /event: generation\.succeeded/);

    const generation = await requestJson(api, `/generations/${generationId}`);
    assert.equal(object(generation.generation).status, "succeeded");
    assert.equal(repository.generationSnapshotReads, 1);
    const chat = await requestJson(api, `/chats/${chatId}`);
    assert.equal(repository.snapshotReads, 1);
    const firstVersion = object(array(chat.versions)[0]);
    const versionId = string(firstVersion.id);
    assert.equal(array(chat.messages).length, 2);
    const firstWindow = await requestJson(
      api,
      `/chats/${chatId}?messagesLimit=1&versionsLimit=1`,
    );
    assert.equal(array(firstWindow.messages).length, 1);
    assert.ok(firstWindow.messagesNextCursor);

    const edited = await requestJson(api, `/chats/${chatId}/versions/${versionId}/changes`, {
      method: "POST",
      body: JSON.stringify({
        title: "Edited API project",
        summary: "Changed through the Web API host.",
        changes: [{ type: "write", path: "src/index.ts", content: "export const edited = true;\n" }],
      }),
    }, 201);
    const editedVersionId = string(object(edited.version).id);
    assert.equal(object(edited.version).parentVersionId, versionId);
    assert.equal(object(array(edited.entries)[0]).content, "export const edited = true;\n");
    const editedChanges = await requestJson(
      api,
      `/chats/${chatId}/versions/${editedVersionId}/changes`,
    );
    assert.equal(object(array(editedChanges.changes)[0]).type, "write");

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

    const messagesWithAttachment = await requestJson(api, `/chats/${chatId}/messages?limit=10`);
    const attachment = array(messagesWithAttachment.messages)
      .flatMap((message) => array(object(message).attachments))
      .map(object)[0]!;
    const attachmentResponse = await api.fetch(request(
      `/chats/${chatId}/attachments/${string(attachment.id)}`,
      {},
      true,
    ));
    assert.equal(await attachmentResponse.text(), "dense chart");
    assert.match(attachmentResponse.headers.get("content-disposition") ?? "", /brief\.txt/);

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
    const steered = await requestJson(api, `/generations/${waitingId}/steering`, {
      method: "POST",
      body: JSON.stringify({
        prompt: "Keep the approved change compact.",
        idempotencyKey: "api-steering-1",
      }),
    }, 202);
    assert.equal(object(steered.steering).status, "queued");
    assert.equal(
      array((await requestJson(api, `/generations/${waitingId}/steering`)).steering).length,
      1,
    );
    const resolved = await requestJson(api, `/generations/${waitingId}/tasks/${taskId}`, {
      method: "POST",
      body: JSON.stringify({ resolution: { kind: "permission", decision: "allow" } }),
    }, 202);
    assert.ok(["queued", "running", "succeeded"].includes(string(object(resolved.generation).status)));
    assert.match(await (await api.fetch(request(`/generations/${waitingId}/events`, {}, true))).text(), /generation\.succeeded/);
    assert.deepEqual(steeringPrompts, ["Keep the approved change compact."]);
    const events = await requestJson(api, `/generations/${waitingId}/events/page?after=0&limit=100`);
    assert.ok(array(events.events).some((event) => object(event).type === "task.resolved"));

    const updated = await requestJson(api, `/chats/${chatId}`, {
      method: "PATCH",
      body: JSON.stringify({ title: "Analytics workspace", metadata: { toolset: "private" } }),
    });
    assert.equal(object(updated.chat).title, "Analytics workspace");
    const listed = await requestJson(api, `/chats?metadata=${encodeURIComponent(JSON.stringify({ toolset: "private" }))}`);
    assert.equal(array(listed.chats).length, 1);

    const imported = await requestJson(api, "/chats/imports", {
      method: "POST",
      body: JSON.stringify({
        title: "Imported assets",
        source: {
          type: "files",
          files: [
            { path: "src/main.ts", content: "export {};\n" },
            {
              type: "artifact",
              path: "public/logo.bin",
              mediaType: "application/octet-stream",
              base64: btoa("binary-logo"),
            },
          ],
        },
      }),
    }, 201);
    const importedChatId = string(object(imported.chat).id);
    const importedVersionId = string(object(imported.version).id);
    const importedVersion = await requestJson(
      api,
      `/chats/${importedChatId}/versions/${importedVersionId}`,
    );
    const projectArtifact = array(importedVersion.entries)
      .map(object)
      .find((entry) => entry.type === "artifact")!;
    const projectArtifactResponse = await api.fetch(request(
      `/chats/${importedChatId}/versions/${importedVersionId}/artifacts/${string(projectArtifact.artifactId)}`,
      {},
      true,
    ));
    assert.equal(await projectArtifactResponse.text(), "binary-logo");

    const zipped = await requestJson(api, "/chats/imports", {
      method: "POST",
      body: JSON.stringify({
        source: {
          type: "zip",
          base64: Buffer.from(zipSync({ "README.md": strToU8("# Imported\n") })).toString("base64"),
        },
      }),
    }, 201);
    assert.equal(object(zipped.version).origin, "imported");

    assert.equal(object(await requestJson(api, `/chats/${chatId}/environment/preview/API_TOKEN`, {
      method: "DELETE",
    })).deleted, true);
  } finally {
    await viby.close();
  }
});

test("adds authenticated session headers to successful and failed API responses", async () => {
  const viby = createVibyWithDependencies(
    { framework: "farm", model: "test/api-session" as never },
    {
      repository: new MemoryRepository(),
      generator: {
        async generate() {
          throw new Error("The generator is not used by this test.");
        },
      },
      skillResolver: new SkillResolver({}),
    },
  );
  const api = createVibyApi({
    viby,
    authenticate: () => ({
      scope,
      headers: {
        "Set-Cookie": "viby_session=rotated; Path=/; HttpOnly; SameSite=Lax",
        "X-Session-Rotated": "true",
      },
    }),
  });

  try {
    const success = await api.fetch(new Request("https://app.example/api/viby/chats"));
    assert.equal(success.status, 200);
    assert.equal(success.headers.get("x-session-rotated"), "true");
    assert.match(success.headers.get("set-cookie") ?? "", /viby_session=rotated/);

    const failure = await api.fetch(new Request("https://app.example/api/viby/chats/not-found"));
    assert.equal(failure.status, 404);
    assert.equal(failure.headers.get("x-session-rotated"), "true");
    assert.match(failure.headers.get("set-cookie") ?? "", /viby_session=rotated/);
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

test("hosts integration discovery, repository workflows, deployment workflows, and history", async () => {
  const calls: Array<{ readonly operation: string; readonly input: unknown }> = [];
  const version = {
    id: "version-api",
    chatId: "chat-api",
    generationId: null,
    parentVersionId: null,
    number: 1,
    origin: "imported",
    framework: "farm",
    title: "API workflows",
    summary: "Imported source.",
    createdAt: new Date("2026-08-12T00:00:00.000Z"),
    push: async (input: unknown) => {
      calls.push({ operation: "push", input });
      return {
        status: "pushed",
        repository: {
          id: "repository-1",
          owner: "farming-labs",
          name: "viby-app",
          defaultBranch: "main",
          visibility: "private",
          url: "https://git.example/farming-labs/viby-app",
        },
        commit: { id: "commit-1", message: "feat: publish", branch: "feature", url: null },
        changedFiles: 2,
        pullRequest: null,
      };
    },
    deploy: async (input: unknown) => {
      calls.push({ operation: "deploy", input });
      return {
        id: "provider-deployment-1",
        projectId: "project-1",
        environment: "preview",
        status: "ready",
        url: "https://preview.example",
        createdAt: new Date("2026-08-12T00:00:00.000Z"),
      };
    },
    repositoryPushes: async () => [{ id: "push-history-1" }],
    deployments: async () => [{ id: "deployment-history-1" }],
    visualArtifacts: async () => [{ id: "visual-1" }],
    getVisualArtifact: async () => ({
      id: "visual-1",
      filename: "preview.png",
      mediaType: "image/png",
      checksum: "visual-checksum",
      bytes: new TextEncoder().encode("visual-bytes"),
    }),
    deploymentArtifact: async () => ({
      id: "deployment-artifact-1",
      mediaType: "application/zip",
      checksum: "deployment-checksum",
      bytes: new TextEncoder().encode("deployment-bytes"),
    }),
  };
  const chat = {
    id: "chat-api",
    getVersion: async () => version,
    repositoryLinks: async () => [{ id: "link-1" }],
    repositoryPushes: async () => [{ id: "push-history-1" }],
    deploymentProjects: async () => [{ id: "project-link-1" }],
    deployments: async () => [{ id: "deployment-history-1" }],
  };
  const repositoryHandle = {
    readSource: async (input: unknown) => {
      calls.push({ operation: "read-source", input });
      return {
        repository: {
          id: "repository-1",
          owner: "farming-labs",
          name: "viby-app",
          defaultBranch: "main",
          visibility: "private",
          url: "https://git.example/farming-labs/viby-app",
        },
        ref: { branch: "main" },
        commit: "commit-1",
        files: [{
          path: "src/index.ts",
          content: new TextEncoder().encode("export {};\n"),
          mediaType: "text/typescript",
        }],
      };
    },
    owners: { list: async () => ({ items: [{ id: "owner-1" }], nextCursor: null }) },
    repositories: {
      list: async (input: unknown) => {
        calls.push({ operation: "list-repositories", input });
        return { items: [{ id: "repository-1", owner: "farming-labs", name: "viby-app" }], nextCursor: null };
      },
      create: async () => ({ id: "repository-2", owner: "farming-labs", name: "new-app" }),
    },
    branches: {
      list: async () => ({ items: [{ name: "main", head: "head-1" }], nextCursor: null }),
      create: async (input: unknown) => {
        calls.push({ operation: "create-branch", input });
        return { name: "feature", head: "head-1", protected: false };
      },
    },
    pullRequests: {
      create: async () => ({ id: "pr-1", number: 1, status: "open" }),
      merge: async () => ({ id: "pr-1", number: 1, status: "merged" }),
    },
  };
  const deploymentHandle = {
    projects: {
      list: async () => ({ items: [{ id: "project-1", name: "viby-app" }], nextCursor: null }),
      create: async () => ({ id: "project-2", name: "new-app", url: null }),
    },
    deployments: {
      get: async () => ({ id: "provider-deployment-1", status: "ready" }),
      cancel: async () => ({ id: "provider-deployment-1", status: "cancelled" }),
    },
  };
  const category = (name: "repository" | "deployment") => ({
    list: async () => [{ id: name === "repository" ? "git" : "host", category: name }],
    connections: async () => [{ id: `${name}-connection` }],
    connect: async (_id: string, input: unknown) => {
      calls.push({ operation: `connect-${name}`, input });
      return { status: "authorization-required", url: "https://provider.example/oauth" };
    },
    disconnect: async () => ({ connection: { status: "revoked" }, providerRevoked: true }),
    use: () => name === "repository" ? repositoryHandle : deploymentHandle,
  });
  const api = createVibyApi({
    viby: {
      framework: "farm",
      integrations: { callback: async () => ({}) },
      forUser: () => ({
        chats: {
          get: async () => chat,
          import: async (input: unknown) => {
            calls.push({ operation: "import", input });
            return {
              id: "imported-chat",
              title: "viby-app",
              framework: "farm",
              metadata: {},
              createdAt: new Date("2026-08-12T00:00:00.000Z"),
              updatedAt: new Date("2026-08-12T00:00:00.000Z"),
              latestVersion: async () => version,
            };
          },
        },
        generations: {
          get: async () => ({
            getArtifact: async () => ({
              id: "generated-1",
              filename: "render.bin",
              mediaType: "application/octet-stream",
              checksum: "generated-checksum",
              bytes: new TextEncoder().encode("generated-bytes"),
            }),
          }),
        },
        integrations: {
          repository: category("repository"),
          deployment: category("deployment"),
        },
      }),
      worker: () => { throw new Error("not used"); },
      close: async () => {},
    } as never,
    authenticate: () => scope,
  });

  const configured = await requestJson(api, "/integrations");
  assert.equal(array(configured.repository).length, 1);
  assert.equal(array(configured.deployment).length, 1);
  const connected = await requestJson(api, "/integrations/repository/git/connect", {
    method: "POST",
    body: JSON.stringify({
      callbackUrl: "https://app.example/callback",
      returnTo: "/settings/integrations",
      authorization: { account: "existing", externalAccountId: "42" },
    }),
  });
  assert.equal(object(connected.result).status, "authorization-required");
  assert.deepEqual(calls[0], {
    operation: "connect-repository",
    input: {
      callbackUrl: "https://app.example/callback",
      returnTo: "/settings/integrations",
      authorization: { account: "existing", externalAccountId: "42" },
      signal: calls[0] && object(calls[0].input).signal,
    },
  });
  const repositories = await requestJson(
    api,
    "/integrations/repository/git/repositories?owner=farming-labs&search=viby&connectionId=repository-connection",
  );
  assert.equal(array(repositories.items).length, 1);
  const branch = await requestJson(api, "/integrations/repository/git/branches", {
    method: "POST",
    body: JSON.stringify({ owner: "farming-labs", repository: "viby-app", name: "feature", from: "main" }),
  }, 201);
  assert.equal(object(branch.branch).name, "feature");

  const imported = await requestJson(api, "/chats/imports", {
    method: "POST",
    body: JSON.stringify({
      source: {
        type: "repository",
        integrationId: "git",
        repository: { owner: "farming-labs", name: "viby-app" },
        ref: { branch: "main" },
      },
    }),
  }, 201);
  assert.equal(object(imported.chat).id, "imported-chat");

  const pushed = await requestJson(api, "/chats/chat-api/versions/version-api/repository-pushes", {
    method: "POST",
    body: JSON.stringify({
      integrationId: "git",
      repository: { owner: "farming-labs", name: "viby-app" },
      branch: { name: "feature", from: "main", createIfMissing: true },
      commit: { message: "feat: publish" },
    }),
  }, 201);
  assert.equal(object(pushed.result).status, "pushed");
  const deployed = await requestJson(api, "/chats/chat-api/versions/version-api/deployments", {
    method: "POST",
    body: JSON.stringify({
      integrationId: "host",
      project: { name: "viby-app", createIfMissing: true },
      environment: "preview",
    }),
  }, 201);
  assert.equal(object(deployed.deployment).status, "ready");
  assert.equal(array((await requestJson(api, "/chats/chat-api/repository-links")).links).length, 1);
  assert.equal(array((await requestJson(api, "/chats/chat-api/deployments")).deployments).length, 1);
  assert.equal(await (await api.fetch(request(
    "/generations/generation-api/artifacts/generated-1",
    {},
    true,
  ))).text(), "generated-bytes");
  assert.equal(await (await api.fetch(request(
    "/chats/chat-api/versions/version-api/visual-artifacts/visual-1",
    {},
    true,
  ))).text(), "visual-bytes");
  assert.equal(await (await api.fetch(request(
    "/chats/chat-api/versions/version-api/deployments/deployment-history-1/artifact",
    {},
    true,
  ))).text(), "deployment-bytes");
  assert.deepEqual(calls.map((call) => call.operation), [
    "connect-repository",
    "list-repositories",
    "create-branch",
    "read-source",
    "import",
    "push",
    "deploy",
  ]);
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
