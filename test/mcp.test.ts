import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport, McpServer } from "@modelcontextprotocol/server";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { unzipSync, strFromU8 } from "fflate";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import { registerVibyMcpTools } from "../src/mcp.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 4,
  inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 8,
  outputTokenDetails: { textTokens: 8, reasoningTokens: 0 },
  totalTokens: 12,
};

test("exposes scoped durable Viby operations through a real MCP connection", async () => {
  let generationNumber = 0;
  const generator: ProjectGenerator<"farm"> = {
    async generate(input): Promise<GeneratorOutput> {
      generationNumber += 1;
      const content = `export const version = ${generationNumber};\n`;
      const file: VersionFile = {
        path: "src/index.ts",
        content,
        mediaType: "text/javascript",
        size: Buffer.byteLength(content),
        checksum: sha256(content),
        locked: false,
      };
      if (input.previousFiles.length > 0) {
        return {
          kind: "changes",
          title: "MCP project",
          summary: "Iterated through MCP",
          changes: [{ type: "write", path: file.path, content }],
          usage,
          finishReason: "stop",
        };
      }
      return {
        kind: "project",
        title: "MCP project",
        summary: "Generated through MCP",
        files: [file],
        usage,
        finishReason: "stop",
      };
    },
  };
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    { framework: "farm", model: "test/mcp" as LanguageModel },
    { repository, generator, skillResolver: new SkillResolver({}) },
  );
  const scoped = viby.forUser({ tenantId: "tenant-mcp", userId: "user-mcp" });
  const server = new McpServer({ name: "viby-test", version: "1.0.0" });
  const registration = registerVibyMcpTools(server, { viby: scoped });
  const client = new Client({ name: "viby-test-client", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const listed = await client.listTools();
    assert.deepEqual(listed.tools.map((tool) => tool.name), registration.names);
    assert.equal(registration.names.length, 12);

    const created = await call(client, "viby_chat_create", {
      title: "MCP dashboard",
      metadata: { product: "analytics" },
    });
    const chatId = object(created.chat).id;
    assert.equal(typeof chatId, "string");

    const started = await call(client, "viby_generation_start", {
      chatId,
      prompt: "Build the dashboard",
    });
    const generationId = string(started.generationId);
    const generation = await scoped.generations.get(generationId);
    const firstOutcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(firstOutcome.status, "succeeded");
    if (firstOutcome.status !== "succeeded") throw new Error("Expected first generation success");

    const status = await call(client, "viby_generation_get", { generationId });
    assert.equal(object(status.generation).status, "succeeded");
    assert.equal(array(status.attempts).length, 1);

    const eventPage = await call(client, "viby_generation_events", {
      generationId,
      after: "0",
      limit: 100,
    });
    assert.ok(array(eventPage.events).some((event) => object(event).type === "generation.succeeded"));

    const fileResult = await call(client, "viby_version_files", {
      chatId,
      versionId: firstOutcome.version.id,
    });
    assert.equal(object(array(fileResult.files)[0]).content, "export const version = 1;\n");

    const iteration = await call(client, "viby_version_iterate", {
      chatId,
      versionId: firstOutcome.version.id,
      prompt: "Improve the hierarchy",
    });
    const iterationGeneration = await scoped.generations.get(string(iteration.generationId));
    const secondOutcome = await iterationGeneration.wait({ pollIntervalMs: 10 });
    assert.equal(secondOutcome.status, "succeeded");
    if (secondOutcome.status !== "succeeded") throw new Error("Expected iteration success");

    const download = await call(client, "viby_version_download", {
      chatId,
      versionId: secondOutcome.version.id,
    });
    const archive = unzipSync(Buffer.from(string(download.base64), "base64"));
    assert.equal(strFromU8(archive["src/index.ts"]!), "export const version = 2;\n");

    const chats = await call(client, "viby_chat_list", { metadata: { product: "analytics" } });
    assert.deepEqual(array(chats.chats).map((chat) => object(chat).id), [chatId]);
  } finally {
    await Promise.allSettled([client.close(), server.close(), viby.close()]);
  }
});

test("validates MCP registration without taking ownership of authentication", () => {
  const server = new McpServer({ name: "validation", version: "1.0.0" });
  assert.throws(
    () => registerVibyMcpTools(server, { viby: undefined as never }),
    /scoped Viby client/,
  );
  assert.throws(
    () => registerVibyMcpTools(server, { viby: {} as never, prefix: "Invalid prefix" }),
    /MCP tool prefix/,
  );
});

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({ name, arguments: args });
  assert.equal(result.isError, undefined);
  assert.ok(result.structuredContent);
  return result.structuredContent as Record<string, unknown>;
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
