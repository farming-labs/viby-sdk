import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import { AgentProjectGenerator } from "../src/agent-runner.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { migrateDatabase } from "../src/migrations.js";
import { PostgresRepository } from "../src/postgres-repository.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";

const databaseUrl = process.env.TEST_DATABASE_URL;

const usage: LanguageModelUsage = {
  inputTokens: 8,
  inputTokenDetails: {
    noCacheTokens: 8,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 16,
  outputTokenDetails: { textTokens: 16, reasoningTokens: 0 },
  totalTokens: 24,
};

test("persists a durable generation, iteration, events, and download in Postgres", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);

  const repository = new PostgresRepository(databaseUrl);
  const calls: Array<GeneratorInput<"farm">> = [];
  const generator: ProjectGenerator<"farm"> = {
    async generate(input, options): Promise<GeneratorOutput> {
      calls.push(input);
      const number = calls.length;
      const content = `export const version = ${number};\n`;
      const files: VersionFile[] = [{
        path: "src/index.ts",
        content,
        mediaType: "text/javascript",
        size: Buffer.byteLength(content),
        checksum: sha256(content),
        locked: false,
      }];
      await options?.onDelta?.(`version-${number}`);
      if (number === 1) {
        const search = await options?.trace?.start("search");
        await search?.delta("src/");
        await search?.complete({ query: "version", path: "src", matches: 1 });
        const toolCall = await options?.toolCalls?.start({
          providerCallId: "postgres-tool-call-1",
          name: "workspace.inspect",
          effect: "read",
          arguments: { path: "src/index.ts", apiKey: "must-not-be-stored" },
        });
        await toolCall?.succeed({ found: true, accessToken: "must-not-be-stored" });
      }
      return {
        kind: "project",
        title: "Postgres integration",
        summary: `Generated version ${number}`,
        files,
        usage,
        finishReason: "stop",
      };
    },
  };
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/postgres" as LanguageModel,
      skills: {},
    },
    {
      repository,
      generator,
      skillResolver: new SkillResolver({}),
    },
  );
  const scope = {
    tenantId: `integration-${randomUUID()}`,
    userId: `integration-${randomUUID()}`,
  };

  try {
    const user = viby.forUser(scope);
    const chat = await user.chats.create({ title: "Postgres integration" });
    const generation = await chat.start({ prompt: "Build a durable Farm project" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") throw new Error("Expected a successful generation");

    const events = (await generation.events({ limit: 100 })).events;
    assert.deepEqual(events.map((event) => event.type), [
      "generation.created",
      "attempt.queued",
      "attempt.started",
      "output.delta",
      "part.started",
      "part.delta",
      "part.completed",
      "part.started",
      "part.completed",
      "attempt.succeeded",
      "generation.succeeded",
    ]);
    assert.deepEqual(
      (await generation.attempts()).map((attempt) => [attempt.number, attempt.status]),
      [[1, "succeeded"]],
    );

    const second = await outcome.version.iterate({ prompt: "Create a second version" });
    const persistedChat = await user.chats.get(chat.id);
    const persistedVersion = await persistedChat.getVersion(second.id);
    assert.equal(persistedVersion.number, 2);
    assert.equal(persistedVersion.parentVersionId, outcome.version.id);
    assert.equal((await persistedChat.listMessages()).items.length, 4);
    const persistedMessages = (await persistedChat.listMessages()).items;
    assert.deepEqual(persistedMessages[0]?.parts.map((part) => part.type), ["text"]);
    assert.deepEqual(persistedMessages[1]?.parts.map((part) => part.type), [
      "search",
      "tool-call",
      "file-edit",
      "text",
      "usage",
    ]);
    assert.ok(persistedMessages[1]?.parts.every((part) => part.attemptId));
    const lookedUpMessage = await persistedChat.getMessage(persistedMessages[1]!.id);
    assert.deepEqual(lookedUpMessage, persistedMessages[1]);
    const [persistedToolCall] = await generation.toolCalls();
    assert.ok(persistedToolCall);
    assert.equal(persistedToolCall.status, "succeeded");
    assert.equal(persistedToolCall.attemptId, (await generation.attempts())[0]?.id);
    assert.equal(persistedToolCall.messageId, persistedMessages[1]?.id);
    assert.deepEqual(persistedToolCall.arguments, {
      path: "src/index.ts",
      apiKey: "[REDACTED]",
    });
    assert.deepEqual(persistedToolCall.result, {
      found: true,
      accessToken: "[REDACTED]",
    });
    assert.equal((await persistedChat.listVersions()).items.length, 2);
    assert.equal(calls[1]?.previousFiles[0]?.content, "export const version = 1;\n");

    const artifact = await persistedVersion.download();
    const files = unzipSync(artifact.bytes);
    assert.equal(strFromU8(files["src/index.ts"]!), "export const version = 2;\n");

    const importedChat = await user.chats.import({
      title: "Imported Postgres project",
      filePolicy: { locked: ["package.json"] },
      source: {
        type: "zip",
        bytes: zipSync({
          "package.json": strToU8('{"name":"postgres-import"}\n'),
          "README.md": strToU8("# Imported\n"),
          "src/main.ts": strToU8("export const imported = true;\n"),
        }),
      },
    });
    const importedVersion = await importedChat.latestVersion();
    assert.ok(importedVersion);
    assert.equal(importedVersion.origin, "imported");
    assert.equal(importedVersion.generationId, null);
    assert.equal(await importedVersion.generation(), null);
    assert.equal((await importedVersion.files()).length, 3);
    assert.equal((await importedVersion.files()).find((file) => file.path === "package.json")?.locked,
      true);
    await assert.rejects(
      () => importedVersion.apply({ changes: [{ type: "delete", path: "package.json" }] }),
      /locked: package\.json/,
    );

    const lease = await repository.createSandboxLease(scope, {
      id: randomUUID(),
      sandboxId: "provider-sandbox-id",
      provider: "integration-provider",
      context: {
        ...scope,
        chatId: importedVersion.chatId,
        versionId: importedVersion.id,
        framework: "farm",
      },
      ports: [3000],
      expiresAt: new Date(Date.now() + 60_000),
    });
    assert.equal((await user.sandboxes.get(lease.id)).sandboxId, "provider-sandbox-id");
    await repository.closeSandboxLease(scope, lease.id, "stopped");
    assert.equal((await user.sandboxes.get(lease.id)).status, "stopped");

    const editedVersion = await importedVersion.apply({
      changes: [
        { type: "write", path: "src/main.ts", content: "export const imported = 2;\n" },
        { type: "move", from: "README.md", to: "docs/README.md" },
      ],
    });
    assert.equal(editedVersion.origin, "edited");
    assert.equal(editedVersion.parentVersionId, importedVersion.id);
    assert.equal(editedVersion.number, 2);
    assert.equal((await importedVersion.files()).some((file) => file.path === "package.json"), true);
    assert.equal((await editedVersion.files()).some((file) => file.path === "docs/README.md"), true);
    assert.equal((await editedVersion.files()).find((file) => file.path === "package.json")?.locked,
      true);
    assert.deepEqual(await importedVersion.changes(), []);
    assert.deepEqual(await editedVersion.changes(), [
      { type: "write", path: "src/main.ts", content: "export const imported = 2;\n" },
      { type: "move", from: "README.md", to: "docs/README.md" },
    ]);

    const forkedChat = await importedVersion.fork({ title: "Postgres fork" });
    const forkedVersion = await forkedChat.latestVersion();
    assert.ok(forkedVersion);
    assert.equal(forkedVersion.origin, "forked");
    assert.equal(forkedVersion.parentVersionId, importedVersion.id);
    assert.equal((await forkedVersion.files()).some((file) => file.path === "package.json"), true);
    assert.equal((await forkedVersion.files()).find((file) => file.path === "package.json")?.locked,
      true);

    const restoredVersion = await importedVersion.restore();
    assert.equal(restoredVersion.origin, "restored");
    assert.equal(restoredVersion.number, 3);
    assert.equal(restoredVersion.parentVersionId, importedVersion.id);
    assert.equal((await restoredVersion.files()).some((file) => file.path === "package.json"), true);
    assert.equal((await restoredVersion.files()).find((file) => file.path === "package.json")?.locked,
      true);
    assert.equal((await editedVersion.files()).some((file) => file.path === "docs/README.md"), true);

    const updatedChat = await persistedChat.update({
      title: "Updated Postgres integration",
      metadata: { favorite: true, labels: ["integration", "postgres"] },
    });
    assert.deepEqual((await user.chats.get(updatedChat.id)).metadata, updatedChat.metadata);

    const messagePageOne = await updatedChat.listMessages({ limit: 2 });
    assert.equal(messagePageOne.items.length, 2);
    assert.ok(messagePageOne.nextCursor);
    const messagePageTwo = await updatedChat.listMessages({
      limit: 2,
      after: messagePageOne.nextCursor,
    });
    assert.equal(messagePageTwo.items.length, 2);
    assert.equal(messagePageTwo.nextCursor, null);

    const versionPageOne = await updatedChat.listVersions({ limit: 1 });
    assert.equal(versionPageOne.items.length, 1);
    assert.ok(versionPageOne.nextCursor);
    const versionPageTwo = await updatedChat.listVersions({
      limit: 1,
      after: versionPageOne.nextCursor,
    });
    assert.equal(versionPageTwo.items.length, 1);
    assert.equal(versionPageTwo.nextCursor, null);

    const chatPage = await user.chats.list({ limit: 1 });
    assert.equal(chatPage.items[0]?.id, updatedChat.id);
    assert.ok(chatPage.nextCursor);
    const filteredChats = await user.chats.list({
      metadata: { favorite: true, labels: ["postgres"] },
    });
    assert.deepEqual(filteredChats.items.map((candidate) => candidate.id), [updatedChat.id]);

    const workerRepository = new PostgresRepository(databaseUrl);
    const workerViby = createVibyWithDependencies(
      {
        framework: "farm",
        model: "test/worker" as LanguageModel,
        skills: {},
        generation: { execution: "worker" },
      },
      {
        repository: workerRepository,
        generator: {
          async generate() {
            const content = "export const worker = true;\n";
            return {
              kind: "project",
              title: "Worker integration",
              summary: "Generated through a durable worker",
              files: [{
                path: "src/worker.ts",
                content,
                mediaType: "text/javascript",
                size: Buffer.byteLength(content),
                checksum: sha256(content),
                locked: false,
              }],
              usage,
              finishReason: "stop",
            };
          },
        },
        skillResolver: new SkillResolver({}),
      },
    );
    try {
      const workerScope = {
        tenantId: `worker-${randomUUID()}`,
        userId: `worker-${randomUUID()}`,
      };
      const queued = await (await workerViby.forUser(workerScope).chats.create())
        .start({ prompt: "Run through a durable worker" });
      assert.equal((await queued.data()).status, "queued");
      const worker = workerViby.worker({ id: "postgres-integration-worker" });
      assert.equal(await worker.runOnce(), true);
      assert.equal((await queued.wait({ pollIntervalMs: 10 })).status, "succeeded");
      const [attempt] = await queued.attempts();
      assert.equal(attempt?.workerId, "postgres-integration-worker");
      assert.ok(attempt?.heartbeatAt);
      assert.ok(attempt?.leaseExpiresAt);
    } finally {
      await workerViby.close();
    }

    const agentModel = new MockLanguageModelV4({
      doGenerate: [
        {
          content: [{
            type: "tool-call",
            toolCallId: "postgres-agent-write-1",
            toolName: "workspace_write_file",
            input: JSON.stringify({
              path: "src/agent.ts",
              content: "export const agent = true;\n",
              mediaType: "text/javascript",
            }),
          }],
          finishReason: { unified: "tool-calls", raw: undefined },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        },
        {
          content: [{
            type: "text",
            text: JSON.stringify({
              outcome: "complete",
              title: "Postgres agent project",
              summary: "Created through the bounded workspace agent.",
              task: null,
            }),
          }],
          finishReason: { unified: "stop", raw: undefined },
          usage: {
            inputTokens: { total: 5, noCache: 5, cacheRead: undefined, cacheWrite: undefined },
            outputTokens: { total: 5, text: 5, reasoning: undefined },
          },
          warnings: [],
        },
      ],
    });
    const agentRepository = new PostgresRepository(databaseUrl);
    const agentViby = createVibyWithDependencies(
      {
        framework: "farm",
        model: agentModel,
        skills: {},
        agent: { maxSteps: 4, maxDurationMs: 10_000, maxTokens: 10_000 },
      },
      {
        repository: agentRepository,
        generator: new AgentProjectGenerator(agentModel, {
          maxSteps: 4,
          maxDurationMs: 10_000,
          maxTokens: 10_000,
        }),
        skillResolver: new SkillResolver({}),
      },
    );
    try {
      const agentScope = {
        tenantId: `agent-${randomUUID()}`,
        userId: `agent-${randomUUID()}`,
      };
      const agentChat = await agentViby.forUser(agentScope).chats.create();
      const agentGeneration = await agentChat.start({ prompt: "Create through workspace tools" });
      const agentOutcome = await agentGeneration.wait({ pollIntervalMs: 10 });
      assert.equal(agentOutcome.status, "succeeded");
      if (agentOutcome.status !== "succeeded") throw new Error("Expected agent success");
      assert.equal((await agentOutcome.version.files())[0]?.path, "src/agent.ts");
      assert.equal((await agentGeneration.toolCalls())[0]?.name, "workspace.write-file");
      assert.ok((await agentChat.listMessages()).items
        .find((message) => message.role === "assistant")?.parts
        .some((part) => part.type === "tool-call"));
    } finally {
      await agentViby.close();
    }

    const approvalRepository = new PostgresRepository(databaseUrl);
    let approvalAttempt = 0;
    const approvalViby = createVibyWithDependencies(
      {
        framework: "farm",
        model: "test/approval" as LanguageModel,
        skills: {},
      },
      {
        repository: approvalRepository,
        generator: {
          async generate(): Promise<GeneratorOutput> {
            approvalAttempt += 1;
            if (approvalAttempt === 1) {
              return {
                kind: "task",
                task: {
                  kind: "permission",
                  title: "Approve sandbox command",
                  message: "A user must approve package scripts.",
                  action: "Run pnpm test",
                  permissions: ["sandbox.command.run"],
                  proposedAction: {
                    type: "sandbox-command",
                    idempotencyKey: "sandbox-command:postgres-integration",
                    provider: "integration-sandbox",
                    action: "run",
                    context: null,
                    command: {
                      command: "pnpm",
                      args: ["test"],
                      cwd: ".",
                      environment: ["CI"],
                      timeoutMs: 60_000,
                    },
                  },
                },
                usage,
                finishReason: "stop",
              };
            }
            const content = "export const approved = true;\n";
            return {
              kind: "project",
              title: "Approved Postgres project",
              summary: "Resumed after a durable permission task.",
              files: [{
                path: "src/approved.ts",
                content,
                mediaType: "text/javascript",
                size: Buffer.byteLength(content),
                checksum: sha256(content),
                locked: false,
              }],
              usage,
              finishReason: "stop",
            };
          },
        },
        skillResolver: new SkillResolver({}),
      },
    );
    try {
      const approvalScope = {
        tenantId: `approval-${randomUUID()}`,
        userId: `approval-${randomUUID()}`,
      };
      const approvalChat = await approvalViby.forUser(approvalScope).chats.create();
      const approvalGeneration = await approvalChat.start({ prompt: "Build after approval" });
      const waiting = await approvalGeneration.wait({ pollIntervalMs: 10 });
      assert.equal(waiting.status, "waiting");
      if (waiting.status !== "waiting") throw new Error("Expected durable approval task");
      const task = waiting.tasks[0];
      assert.equal(task?.kind, "permission");
      if (!task || task.kind !== "permission") throw new Error("Expected permission task");
      assert.equal(task.proposedAction?.idempotencyKey, "sandbox-command:postgres-integration");
      assert.deepEqual(task.proposedAction?.command.environment, ["CI"]);
      await approvalGeneration.resolve({
        taskId: task.id,
        resolution: { kind: "permission", decision: "allow" },
      });
      assert.equal((await approvalGeneration.wait({ pollIntervalMs: 10 })).status, "succeeded");
      const [persistedTask] = await approvalGeneration.tasks();
      assert.equal(persistedTask?.status, "resolved");
      assert.equal(
        persistedTask?.kind === "permission"
          ? persistedTask.proposedAction?.command.command
          : undefined,
        "pnpm",
      );
    } finally {
      await approvalViby.close();
    }
  } finally {
    await viby.close();
  }
});
