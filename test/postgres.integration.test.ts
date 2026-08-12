import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import { AgentProjectGenerator } from "../src/agent-runner.js";
import { fileSystemArtifactStore } from "../src/artifact-filesystem.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { migrateDatabase } from "../src/migrations.js";
import { verifyPersistenceAdapter } from "../src/persistence-conformance.js";
import { PostgresRepository } from "../src/postgres-repository.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { IntegrationClient } from "../src/integration-client.js";
import {
  EncryptedPostgresSecretStore,
  PostgresIntegrationConnectionStore,
} from "../src/integration-store-postgres.js";
import type { RepositoryIntegration } from "../src/integrations.js";
import { EnvironmentManager } from "../src/environment.js";
import { PostgresEnvironmentVariableStore } from "../src/environment-postgres.js";

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

test("persists redacted project environments and encrypted secret values", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);
  const repository = new PostgresRepository(databaseUrl);
  const variables = new PostgresEnvironmentVariableStore({ databaseUrl });
  const secretStore = new EncryptedPostgresSecretStore({
    databaseUrl,
    encryptionKey: new Uint8Array(32).fill(7),
  });
  const environment = new EnvironmentManager(variables, secretStore);
  const scope = {
    tenantId: `environment-${randomUUID()}`,
    userId: `environment-${randomUUID()}`,
  };
  try {
    const chat = await repository.createChat(scope, {
      id: randomUUID(),
      title: "Environment variables",
      metadata: {},
      framework: "farm",
    });
    const collection = environment.forChat(scope, chat.id);
    await collection.set({
      environment: "preview",
      name: "PUBLIC_ORIGIN",
      value: "https://preview.example",
    });
    await collection.set({
      environment: "preview",
      name: "SERVICE_TOKEN",
      value: "postgres-encrypted-secret",
      secret: true,
    });
    assert.deepEqual((await collection.list({ environment: "preview" })).map((variable) => ({
      name: variable.name,
      value: variable.value,
      secret: variable.secret,
    })), [
      { name: "PUBLIC_ORIGIN", value: "https://preview.example", secret: false },
      { name: "SERVICE_TOKEN", value: null, secret: true },
    ]);
    assert.deepEqual(await environment.resolve(scope, chat.id, "preview"), {
      PUBLIC_ORIGIN: "https://preview.example",
      SERVICE_TOKEN: "postgres-encrypted-secret",
    });
    assert.deepEqual(await environment.resolve({
      tenantId: `other-${randomUUID()}`,
      userId: scope.userId,
    }, chat.id, "preview"), {});
    await repository.deleteChat(scope, chat.id, { deletedAt: new Date(), purgeAfter: new Date() });
    await repository.purgeDeletedChats(scope, new Date(), 10);
  } finally {
    await Promise.allSettled([environment.close(), secretStore.close(), repository.close()]);
  }
});

test("persists a durable generation, iteration, events, and download in Postgres", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);

  const artifactDirectory = await mkdtemp(join(tmpdir(), "viby-postgres-artifacts-"));
  const artifactStore = fileSystemArtifactStore({ directory: artifactDirectory });
  const repository = new PostgresRepository(databaseUrl, artifactStore);
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
        artifacts: number === 1 ? [{
          kind: "image",
          filename: "generated-preview.png",
          mediaType: "image/png",
          bytes: new Uint8Array([137, 80, 78, 71]),
        }] : [],
      };
    },
  };
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/postgres" as LanguageModel,
      skills: {},
      cost: {
        currency: "USD",
        calculate: ({ totalTokens }) => (totalTokens ?? 0) * 10,
      },
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
    const generation = await chat.start({
      prompt: "Build a durable Farm project",
      instructions: "Use a compact product layout.",
      skills: { design: [] },
      metadata: { test: "postgres-generation-config" },
      attachments: [{
        filename: "reference.txt",
        mediaType: "text/plain",
        bytes: new TextEncoder().encode("durable reference"),
      }],
    });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") throw new Error("Expected a successful generation");
    assert.deepEqual(outcome.generation.cost, { amountMicros: 240, currency: "USD" });
    assert.deepEqual(outcome.generation.configuration, {
      model: "default",
      instructions: "Use a compact product layout.",
      skills: { design: [] },
      metadata: { test: "postgres-generation-config" },
      toolSources: [],
    });
    assert.equal(calls[0]?.instructions, "Use a compact product layout.");
    assert.deepEqual(calls[0]?.metadata, { test: "postgres-generation-config" });
    assert.equal(calls[0]?.attachments?.[0]?.filename, "reference.txt");
    assert.equal(new TextDecoder().decode(calls[0]?.attachments?.[0]?.bytes), "durable reference");
    assert.deepEqual((await generation.attempts())[0]?.cost, {
      amountMicros: 240,
      currency: "USD",
    });
    const generationMessages = (await chat.listMessages()).items;
    assert.equal(generationMessages.find((message) => message.role === "user")?.finishReason, null);
    assert.equal(generationMessages.find((message) => message.role === "assistant")?.finishReason, "stop");
    const generatedArtifacts = await generation.artifacts();
    assert.equal(generatedArtifacts.length, 1);
    assert.equal(generatedArtifacts[0]?.artifact.store, "filesystem");
    assert.equal(generatedArtifacts[0]?.versionId, outcome.version.id);
    assert.deepEqual(
      (await generation.getArtifact(generatedArtifacts[0]!.id)).bytes,
      new Uint8Array([137, 80, 78, 71]),
    );
    const designEvaluation = await outcome.version.recordDesignEvaluation({
      evaluator: "postgres-visual@1",
      status: "passed",
      score: 96.5,
      summary: "The generated source matches the persisted reference.",
      criteria: [{
        id: "source-quality",
        label: "Source quality",
        status: "passed",
        score: 96.5,
        summary: "The generated entry point is complete.",
        evidence: [{ type: "version-file", path: "src/index.ts" }],
      }],
      evidence: [{
        type: "attachment",
        attachmentId: generationMessages.find((message) => message.role === "user")!.attachments[0]!.id,
      }],
      metadata: { integration: true },
    });
    assert.deepEqual(await outcome.version.getDesignEvaluation(designEvaluation.id), designEvaluation);
    assert.deepEqual((await outcome.version.listDesignEvaluations()).items, [designEvaluation]);

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
      "artifact.created",
      "attempt.succeeded",
      "generation.succeeded",
    ]);
    const outboundEvent = events[0]!;
    const firstDeliveryClaim = await repository.claimOutboundEventDelivery(scope, {
      generationId: generation.id,
      eventCursor: outboundEvent.cursor,
      sinkId: "postgres-test-sink",
      leaseToken: randomUUID(),
      leaseMs: 30_000,
      maxAttempts: 2,
    });
    assert.ok(firstDeliveryClaim);
    assert.equal(firstDeliveryClaim.delivery.attemptCount, 1);
    const retryableDelivery = await repository.failOutboundEventDelivery(scope, {
      generationId: generation.id,
      eventCursor: outboundEvent.cursor,
      sinkId: "postgres-test-sink",
      leaseToken: firstDeliveryClaim.leaseToken,
      error: "temporary failure",
      retryDelayMs: 0,
    });
    assert.equal(retryableDelivery.status, "pending");
    const secondDeliveryClaim = await repository.claimOutboundEventDelivery(scope, {
      generationId: generation.id,
      eventCursor: outboundEvent.cursor,
      sinkId: "postgres-test-sink",
      leaseToken: randomUUID(),
      leaseMs: 30_000,
      maxAttempts: 2,
    });
    assert.ok(secondDeliveryClaim);
    const deadLetter = await repository.failOutboundEventDelivery(scope, {
      generationId: generation.id,
      eventCursor: outboundEvent.cursor,
      sinkId: "postgres-test-sink",
      leaseToken: secondDeliveryClaim.leaseToken,
      error: "terminal failure",
      retryDelayMs: 0,
    });
    assert.equal(deadLetter.status, "dead_lettered");
    assert.equal((await repository.listOutboundEventDeliveries(
      scope,
      generation.id,
      "postgres-test-sink",
      "dead_lettered",
    )).length, 1);
    await repository.redriveOutboundEventDelivery(
      scope,
      generation.id,
      outboundEvent.cursor,
      "postgres-test-sink",
    );
    const redriveClaim = await repository.claimOutboundEventDelivery(scope, {
      generationId: generation.id,
      eventCursor: outboundEvent.cursor,
      sinkId: "postgres-test-sink",
      leaseToken: randomUUID(),
      leaseMs: 30_000,
      maxAttempts: 2,
    });
    assert.ok(redriveClaim);
    const delivered = await repository.completeOutboundEventDelivery(
      scope,
      redriveClaim,
      new Date(),
    );
    assert.equal(delivered.status, "delivered");
    assert.deepEqual(
      (await generation.attempts()).map((attempt) => [attempt.number, attempt.status]),
      [[1, "succeeded"]],
    );

    const second = await outcome.version.iterate({ prompt: "Create a second version" });
    const persistedChat = await user.chats.get(chat.id);
    const persistedVersion = await persistedChat.getVersion(second.id);
    assert.equal(persistedVersion.number, 2);
    assert.equal(persistedVersion.parentVersionId, outcome.version.id);
    assert.deepEqual((await persistedVersion.generation())?.cost, {
      amountMicros: 240,
      currency: "USD",
    });
    assert.equal((await persistedChat.listMessages()).items.length, 4);
    const persistedMessages = (await persistedChat.listMessages()).items;
    assert.deepEqual(
      persistedMessages.map((message) => message.finishReason),
      [null, "stop", null, "stop"],
    );
    assert.equal(persistedMessages[0]?.attachments[0]?.filename, "reference.txt");
    const persistedAttachment = await persistedChat.getAttachment(
      persistedMessages[0]!.attachments[0]!.id,
    );
    assert.equal(new TextDecoder().decode(persistedAttachment.bytes), "durable reference");
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

    const pushId = randomUUID();
    const pushKey = `postgres-push-${randomUUID()}`;
    const startedPush = await repository.beginRepositoryPush(scope, {
      id: pushId,
      chatId: persistedChat.id,
      versionId: persistedVersion.id,
      integrationId: "github",
      connectionId: randomUUID(),
      provider: "github",
      target: { owner: "acme", name: "postgres-history" },
      branch: "main",
      commitMessage: "test: persist repository history",
      expectedHead: null,
      idempotencyKey: pushKey,
      now: new Date(),
    });
    assert.equal(startedPush.status, "pending");
    const completedPush = await repository.completeRepositoryPush(scope, {
      id: pushId,
      repository: {
        id: "provider-repository-1",
        owner: "acme",
        name: "postgres-history",
        defaultBranch: "main",
        visibility: "private",
        url: "https://git.example/acme/postgres-history",
      },
      result: {
        status: "pushed",
        commit: {
          id: "commit-1",
          message: "test: persist repository history",
          branch: "main",
          url: "https://git.example/acme/postgres-history/commit/commit-1",
        },
        changedFiles: 1,
        pullRequest: null,
      },
      completedAt: new Date(),
    });
    assert.equal(completedPush.status, "pushed");
    assert.equal((await persistedVersion.repositoryPushes())[0]?.commit?.id, "commit-1");
    assert.equal((await persistedChat.repositoryLinks())[0]?.repositoryId, "provider-repository-1");
    const replayedPush = await repository.beginRepositoryPush(scope, {
      id: randomUUID(),
      chatId: persistedChat.id,
      versionId: persistedVersion.id,
      integrationId: "github",
      connectionId: randomUUID(),
      provider: "github",
      target: { owner: "different", name: "ignored-by-idempotency" },
      branch: "other",
      commitMessage: "test: ignored duplicate",
      expectedHead: null,
      idempotencyKey: pushKey,
      now: new Date(),
    });
    assert.equal(replayedPush.id, pushId);
    assert.equal(replayedPush.status, "pushed");

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
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("retains, restores, and purges deleted chats in Postgres", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);
  const repository = new PostgresRepository(databaseUrl);
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/postgres-retention" as LanguageModel,
      retention: { deletedChatsMs: 60_000 },
    },
    {
      repository,
      generator: {
        async generate(): Promise<GeneratorOutput> {
          throw new Error("The retention test does not invoke generation.");
        },
      },
      skillResolver: new SkillResolver({}),
    },
  );
  try {
    const user = viby.forUser({
      tenantId: `retention-${randomUUID()}`,
      userId: `retention-${randomUUID()}`,
    });
    const chat = await user.chats.import({
      source: { type: "files", files: [{ path: "src/index.ts", content: "export {};\n" }] },
    });
    const version = await chat.latestVersion();
    assert.ok(version);
    const retained = await chat.delete();
    assert.equal(retained.purgeAfter!.getTime() - retained.deletedAt.getTime(), 60_000);
    await assert.rejects(() => user.chats.get(chat.id));
    assert.equal((await user.chats.restore(chat.id)).id, chat.id);
    await (await user.chats.get(chat.id)).delete({ retentionMs: 0 });
    assert.equal(await user.chats.purgeDeleted(), 1);
    await assert.rejects(() => user.chats.get(chat.id));
    assert.deepEqual(await repository.getVersionFiles(user.scope, version.id), []);
  } finally {
    await viby.close();
  }
});

test("passes the persistence adapter conformance suite in Postgres", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);
  const artifactDirectory = await mkdtemp(join(tmpdir(), "viby-postgres-conformance-"));
  try {
    const report = await verifyPersistenceAdapter({
      create: () => new PostgresRepository(
        databaseUrl,
        fileSystemArtifactStore({ directory: artifactDirectory }),
      ),
    });
    assert.equal(report.checks.at(-1), "close");
  } finally {
    await rm(artifactDirectory, { recursive: true, force: true });
  }
});

test("persists encrypted integration connections and single-use authorization sessions", {
  skip: databaseUrl ? false : "TEST_DATABASE_URL is not configured",
}, async () => {
  assert.ok(databaseUrl);
  await migrateDatabase(databaseUrl);
  const encryptionKey = new Uint8Array(32).fill(7);
  const integration: RepositoryIntegration = {
    provider: "fixture-git",
    displayName: "Fixture Git",
    connection: {
      async startAuthorization(input) {
        const url = new URL("https://git.example/authorize");
        url.searchParams.set("state", input.state);
        return { url: url.href, expiresAt: null };
      },
      async completeAuthorization() {
        return {
          account: { id: "installation-1", name: "Postgres fixture" },
          credential: {
            secret: new TextEncoder().encode("postgres-encrypted-token"),
            expiresAt: null,
            scopes: ["contents:write"],
          },
        };
      },
    },
    async listOwners() { return { items: [], nextCursor: null }; },
    async listRepositories() { return { items: [], nextCursor: null }; },
    async getRepository() { return null; },
    async createRepository(input) {
      return {
        id: "repository",
        owner: input.owner,
        name: input.name,
        defaultBranch: "main",
        visibility: input.visibility ?? "private",
        url: `https://git.example/${input.owner}/${input.name}`,
      };
    },
    async listBranches() { return { items: [], nextCursor: null }; },
    async getBranch() { return null; },
    async createBranch(input) { return { name: input.name, head: input.from, protected: false }; },
    async readSource(input) {
      return {
        repository: {
          id: "repository",
          ...input.repository,
          defaultBranch: "main",
          visibility: "private",
          url: `https://git.example/${input.repository.owner}/${input.repository.name}`,
        },
        ref: input.ref,
        commit: "commit",
        files: [],
      };
    },
    async pushVersion(input) {
      return {
        status: "pushed",
        commit: { id: "commit", message: input.message, branch: input.branch, url: null },
        changedFiles: input.files.length,
      };
    },
    async createPullRequest(input) {
      return {
        id: "pull-request",
        number: 1,
        title: input.title,
        head: input.head,
        base: input.base,
        status: "open",
        url: "https://git.example/pull/1",
      };
    },
  };
  const scope = {
    tenantId: `connection-${randomUUID()}`,
    userId: `connection-${randomUUID()}`,
  };

  const first = new IntegrationClient(
    { repository: { fixture: integration } },
    new PostgresIntegrationConnectionStore({ databaseUrl }),
    new EncryptedPostgresSecretStore({ databaseUrl, encryptionKey }),
  );
  const started = await first.forUser(scope).repository.connect("fixture", {
    callbackUrl: "https://app.example/integrations/callback",
    returnTo: "/project",
  });
  assert.equal(started.status, "authorization-required");
  const state = new URL(started.url).searchParams.get("state");
  assert.ok(state);
  const completed = await first.callback(
    `https://app.example/integrations/callback?state=${encodeURIComponent(state)}&code=ok`,
  );
  await first.close();

  const restarted = new IntegrationClient(
    { repository: { fixture: integration } },
    new PostgresIntegrationConnectionStore({ databaseUrl }),
    new EncryptedPostgresSecretStore({ databaseUrl, encryptionKey }),
  );
  try {
    const [configured] = await restarted.forUser(scope).repository.list();
    assert.equal(configured?.connected, true);
    const context = await restarted.operationContext(
      scope,
      "repository",
      "fixture",
      completed.connection.id,
    );
    assert.equal(new TextDecoder().decode(context.credential), "postgres-encrypted-token");
    assert.deepEqual(await restarted.forUser({
      tenantId: `other-${randomUUID()}`,
      userId: scope.userId,
    }).repository.connections(), []);
    await assert.rejects(() => restarted.callback(
      `https://app.example/integrations/callback?state=${encodeURIComponent(state)}&code=ok`,
    ));
  } finally {
    await restarted.close();
  }
});
