import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DefaultChatTransport,
  type LanguageModel,
  type LanguageModelUsage,
  type UIMessage,
  type UIMessageChunk,
} from "ai";
import { createVibyAIChatHandler } from "../src/ai-sdk.js";
import { createVibyWithDependencies, type Generation } from "../src/client.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "../src/generator.js";
import { SkillResolver } from "../src/skills.js";
import type { VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const scope = { tenantId: "ai-sdk-tenant", userId: "ai-sdk-user" };
const usage: LanguageModelUsage = {
  inputTokens: 3,
  inputTokenDetails: { noCacheTokens: 3, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: 8,
};

const project = (): GeneratorOutput => {
  const content = "export const ready = true;\n";
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
    title: "AI SDK project",
    summary: "Generated through the AI SDK bridge.",
    files: [file],
    usage,
    finishReason: "stop",
  };
};

const vibyFor = (generator: ProjectGenerator<"farm">) =>
  createVibyWithDependencies(
    { framework: "farm", model: "test/ai-sdk" as LanguageModel },
    {
      repository: new MemoryRepository(),
      generator,
      skillResolver: new SkillResolver({}),
    },
  );

const messages = (prompt: string): UIMessage[] => [{
  id: "user-message-1",
  role: "user",
  parts: [{ type: "text", text: prompt }],
}];

const collect = async (stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> => {
  const chunks: UIMessageChunk[] = [];
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) return chunks;
    chunks.push(value);
  }
};

const send = async (
  handler: ReturnType<typeof createVibyAIChatHandler>,
  value: UIMessage[],
): Promise<UIMessageChunk[]> => {
  const transport = new DefaultChatTransport<UIMessage>({
    api: "https://app.example/api/chat",
    fetch: (input, init) => handler(new Request(input, init)),
  });
  return collect(await transport.sendMessages({
    chatId: "harness-thread-1",
    messages: value,
    abortSignal: undefined,
    trigger: "submit-message",
    messageId: undefined,
  }));
};

test("streams a Viby generation through the AI SDK UI message protocol", async () => {
  let received: GeneratorInput<"farm"> | undefined;
  const viby = vibyFor({
    async generate(input, options?: GeneratorOptions): Promise<GeneratorOutput> {
      received = input;
      await options?.onDelta?.("Built ");
      await options?.onDelta?.("the project.");
      return project();
    },
  });
  const chat = await viby.forUser(scope).chats.create({ title: "AI SDK chat" });
  let conversationId: string | undefined;
  const handler = createVibyAIChatHandler({
    resolveChat: (request) => {
      conversationId = request.conversationId;
      return chat;
    },
  });

  const chunks = await send(handler, messages("Build a starter project"));

  assert.equal(conversationId, "harness-thread-1");
  assert.equal(received?.prompt, "Build a starter project");
  assert.deepEqual(
    chunks.filter((chunk) => chunk.type === "text-delta").map((chunk) => chunk.delta),
    ["Built ", "the project."],
  );
  const start = chunks.find((chunk) => chunk.type === "start");
  assert.equal(start?.type, "start");
  assert.ok(start && start.type === "start");
  const metadata = start.messageMetadata as {
    viby: { chatId: string; generationId: string };
  };
  assert.equal(metadata.viby.chatId, chat.id);
  assert.equal(typeof metadata.viby.generationId, "string");
  assert.deepEqual(chunks.at(-1), {
    type: "finish",
    finishReason: "stop",
    messageMetadata: metadata,
  });
});

test("cancels the Viby generation when the AI SDK request is aborted", async () => {
  let started!: () => void;
  const generating = new Promise<void>((resolve) => {
    started = resolve;
  });
  const viby = vibyFor({
    async generate(_input, options?: GeneratorOptions): Promise<GeneratorOutput> {
      started();
      await new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
      return project();
    },
  });
  const chat = await viby.forUser(scope).chats.create({ title: "Cancelled AI SDK chat" });
  let generation: Generation<"farm"> | undefined;
  const handler = createVibyAIChatHandler({
    resolveChat: () => chat,
    startGeneration: async (input) => {
      generation = await input.chat.start(input.generationInput);
      return generation;
    },
  });
  const controller = new AbortController();
  const response = await handler(new Request("https://app.example/api/chat", {
    method: "POST",
    signal: controller.signal,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "harness-thread-1",
      messages: messages("Build a starter project"),
      trigger: "submit-message",
    }),
  }));

  await generating;
  controller.abort();

  const body = await response.text();
  assert.match(body, /"type":"abort"/);
  assert.equal((await generation!.wait({ pollIntervalMs: 10 })).status, "cancelled");
});

test("exposes a Viby generation failure as an AI SDK stream error", async () => {
  const viby = vibyFor({
    async generate(): Promise<GeneratorOutput> {
      throw new Error("Model provider unavailable");
    },
  });
  const chat = await viby.forUser(scope).chats.create({ title: "Failed AI SDK chat" });
  const handler = createVibyAIChatHandler({ resolveChat: () => chat });

  const chunks = await send(handler, messages("Build a starter project"));

  assert.deepEqual(chunks.at(-1), {
    type: "error",
    errorText: "Model provider unavailable",
  });
});

test("rejects malformed AI SDK chat requests", async () => {
  const viby = vibyFor({
    async generate(): Promise<GeneratorOutput> {
      return project();
    },
  });
  const chat = await viby.forUser(scope).chats.create({ title: "Invalid request chat" });
  const handler = createVibyAIChatHandler({ resolveChat: () => chat });

  const response = await handler(new Request("https://app.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id: "harness-thread-1", messages: [] }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "AI SDK chat request trigger is invalid.",
    code: "invalid_request",
  });
});

test("rejects non-text messages until the product maps them to a Viby input", async () => {
  const viby = vibyFor({
    async generate(): Promise<GeneratorOutput> {
      return project();
    },
  });
  const chat = await viby.forUser(scope).chats.create({ title: "File input chat" });
  const handler = createVibyAIChatHandler({ resolveChat: () => chat });

  const response = await handler(new Request("https://app.example/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: "harness-thread-1",
      messages: [{
        id: "user-message-1",
        role: "user",
        parts: [{
          type: "file",
          mediaType: "text/plain",
          url: "https://app.example/brief.txt",
        }],
      }],
      trigger: "submit-message",
    }),
  }));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "AI SDK file and custom parts require createGenerationInput(request).",
    code: "invalid_request",
  });
});
