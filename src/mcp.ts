import { McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { z } from "zod";
import type {
  Chat,
  Generation,
  ScopedViby,
  Version,
} from "./client.js";
import type {
  FrameworkId,
  GenerationTaskResolution,
  JsonValue,
} from "./types.js";
import { ConfigurationError } from "./errors.js";

const DEFAULT_PREFIX = "viby_";
const jsonObject = z.record(z.string(), z.json());
const page = {
  limit: z.number().int().min(1).max(100).optional(),
  after: z.string().optional(),
};

export interface VibyMcpToolsOptions<Framework extends FrameworkId = FrameworkId> {
  /** A tenant- and user-scoped SDK. Authentication remains owned by the host. */
  readonly viby: ScopedViby<Framework>;
  /** Tool-name prefix. Defaults to `viby_`. */
  readonly prefix?: string;
}

export interface VibyMcpToolRegistration {
  readonly names: readonly string[];
}

/**
 * Register transport-neutral Viby tools on an MCP server.
 *
 * Create one registration for the authenticated scope attached to the current
 * MCP connection or request. This adapter never accepts, resolves, or stores credentials.
 */
export function registerVibyMcpTools<Framework extends FrameworkId>(
  server: McpServer,
  options: VibyMcpToolsOptions<Framework>,
): VibyMcpToolRegistration {
  if (!(server instanceof McpServer)) {
    throw new ConfigurationError("registerVibyMcpTools requires an MCP McpServer instance.");
  }
  if (!options?.viby) {
    throw new ConfigurationError("registerVibyMcpTools requires a scoped Viby client.");
  }
  const prefix = normalizePrefix(options.prefix);
  const names: string[] = [];
  const name = (suffix: string): string => {
    const value = `${prefix}${suffix}`;
    names.push(value);
    return value;
  };

  server.registerTool(name("chat_list"), {
    title: "List Viby chats",
    description: "List chats in the authenticated tenant and user scope.",
    inputSchema: z.object({
      ...page,
      metadata: jsonObject.optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async (input) => {
    const result = await options.viby.chats.list({
      ...(input.limit === undefined ? {} : { limit: input.limit }),
      ...(input.after === undefined ? {} : { after: input.after }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata as Record<string, JsonValue> }),
    });
    return resultValue({
      chats: result.items.map(chatValue),
      nextCursor: result.nextCursor,
    });
  });

  server.registerTool(name("chat_create"), {
    title: "Create a Viby chat",
    description: "Create an empty durable chat for a new generated project.",
    inputSchema: z.object({
      title: z.string().min(1).max(200).optional(),
      metadata: jsonObject.optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async (input) => resultValue({
    chat: chatValue(await options.viby.chats.create({
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.metadata === undefined ? {} : { metadata: input.metadata as Record<string, JsonValue> }),
    })),
  }));

  server.registerTool(name("chat_get"), {
    title: "Get a Viby chat",
    description: "Get one chat and its latest immutable source version.",
    inputSchema: z.object({ chatId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ chatId }) => {
    const chat = await options.viby.chats.get(chatId);
    const latestVersion = await chat.latestVersion();
    return resultValue({
      chat: chatValue(chat),
      latestVersion: latestVersion ? versionValue(latestVersion) : null,
    });
  });

  server.registerTool(name("generation_start"), {
    title: "Start Viby generation",
    description: "Start an asynchronous generation in a chat and return its durable id immediately.",
    inputSchema: z.object({
      chatId: z.string().min(1),
      prompt: z.string().min(1),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ chatId, prompt }) => {
    const generation = await (await options.viby.chats.get(chatId)).start({ prompt });
    return resultValue({
      chatId,
      generationId: generation.id,
      generation: await generation.data(),
    });
  });

  server.registerTool(name("generation_get"), {
    title: "Get Viby generation",
    description: "Get durable generation status, attempts, tasks, and tool calls.",
    inputSchema: z.object({ generationId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ generationId }) => {
    const generation = await options.viby.generations.get(generationId);
    const [data, attempts, tasks, toolCalls] = await Promise.all([
      generation.data(),
      generation.attempts(),
      generation.tasks(),
      generation.toolCalls(),
    ]);
    return resultValue({ generation: data, attempts, tasks, toolCalls });
  });

  server.registerTool(name("generation_events"), {
    title: "List Viby generation events",
    description: "Read resumable durable generation and agent-trace events after a cursor.",
    inputSchema: z.object({
      generationId: z.string().min(1),
      after: z.string().regex(/^\d+$/).optional(),
      limit: z.number().int().min(1).max(500).optional(),
    }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ generationId, after, limit }) => {
    const generation = await options.viby.generations.get(generationId);
    const result = await generation.events({
      ...(after === undefined ? {} : { after }),
      ...(limit === undefined ? {} : { limit }),
    });
    return resultValue({ events: result.events, nextCursor: result.nextCursor });
  });

  server.registerTool(name("generation_cancel"), {
    title: "Cancel Viby generation",
    description: "Cancel a queued or running generation without deleting its durable history.",
    inputSchema: z.object({
      generationId: z.string().min(1),
      reason: z.string().min(1).max(2_000).optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  }, async ({ generationId, reason }) => {
    const generation = await options.viby.generations.get(generationId);
    return resultValue({ generation: await generation.cancel(reason) });
  });

  server.registerTool(name("generation_task_resolve"), {
    title: "Resolve Viby generation task",
    description: "Resolve a persisted plan, question, or permission task and safely resume generation.",
    inputSchema: z.object({
      generationId: z.string().min(1),
      taskId: z.string().min(1),
      resolution: z.discriminatedUnion("kind", [
        z.object({
          kind: z.literal("plan"),
          decision: z.enum(["approve", "revise"]),
          feedback: z.string().max(10_000).optional(),
        }),
        z.object({ kind: z.literal("question"), answer: z.string().min(1).max(10_000) }),
        z.object({
          kind: z.literal("permission"),
          decision: z.enum(["allow", "deny"]),
          note: z.string().max(10_000).optional(),
        }),
      ]),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ generationId, taskId, resolution }) => {
    const generation = await options.viby.generations.get(generationId);
    await generation.resolve({
      taskId,
      resolution: resolution as GenerationTaskResolution,
    });
    return resultValue({ generation: await generation.data() });
  });

  server.registerTool(name("version_list"), {
    title: "List Viby versions",
    description: "List immutable source versions in a chat.",
    inputSchema: z.object({ chatId: z.string().min(1), ...page }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ chatId, ...pagination }) => {
    const result = await (await options.viby.chats.get(chatId)).listVersions({
      ...(pagination.limit === undefined ? {} : { limit: pagination.limit }),
      ...(pagination.after === undefined ? {} : { after: pagination.after }),
    });
    return resultValue({
      versions: result.items.map(versionValue),
      nextCursor: result.nextCursor,
    });
  });

  server.registerTool(name("version_files"), {
    title: "Read Viby version files",
    description: "Read the complete framework-native files from one immutable version.",
    inputSchema: z.object({ chatId: z.string().min(1), versionId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ chatId, versionId }) => {
    const version = await (await options.viby.chats.get(chatId)).getVersion(versionId);
    return resultValue({ version: versionValue(version), files: await version.files() });
  });

  server.registerTool(name("version_iterate"), {
    title: "Iterate a Viby version",
    description: "Start an asynchronous iteration from an exact immutable source version.",
    inputSchema: z.object({
      chatId: z.string().min(1),
      versionId: z.string().min(1),
      prompt: z.string().min(1),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  }, async ({ chatId, versionId, prompt }) => {
    const version = await (await options.viby.chats.get(chatId)).getVersion(versionId);
    const generation = await version.startIteration({ prompt });
    return resultValue({
      chatId,
      baseVersionId: versionId,
      generationId: generation.id,
      generation: await generation.data(),
    });
  });

  server.registerTool(name("version_download"), {
    title: "Download Viby version",
    description: "Build a ZIP artifact from one immutable source version and return it as base64.",
    inputSchema: z.object({ chatId: z.string().min(1), versionId: z.string().min(1) }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ chatId, versionId }) => {
    const version = await (await options.viby.chats.get(chatId)).getVersion(versionId);
    const artifact = await version.download();
    return resultValue({
      filename: artifact.filename,
      contentType: artifact.contentType,
      size: artifact.bytes.byteLength,
      base64: Buffer.from(artifact.bytes).toString("base64"),
    });
  });

  return Object.freeze({ names: Object.freeze(names) });
}

function normalizePrefix(value: string | undefined): string {
  const prefix = value ?? DEFAULT_PREFIX;
  if (!/^[a-z][a-z0-9_-]{0,31}$/.test(prefix)) {
    throw new ConfigurationError(
      "An MCP tool prefix must start with a lowercase letter and contain at most 32 lowercase letters, digits, underscores, or hyphens.",
    );
  }
  return prefix;
}

function chatValue<Framework extends FrameworkId>(chat: Chat<Framework>) {
  return {
    id: chat.id,
    title: chat.title,
    metadata: chat.metadata,
    framework: chat.framework,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

function versionValue<Framework extends FrameworkId>(version: Version<Framework>) {
  return {
    id: version.id,
    chatId: version.chatId,
    generationId: version.generationId,
    parentVersionId: version.parentVersionId,
    number: version.number,
    origin: version.origin,
    framework: version.framework,
    title: version.title,
    summary: version.summary,
    createdAt: version.createdAt,
  };
}

function resultValue(value: Record<string, unknown>): CallToolResult {
  const structuredContent = JSON.parse(JSON.stringify(value)) as Record<string, JsonValue>;
  return {
    content: [{ type: "text", text: JSON.stringify(structuredContent, null, 2) }],
    structuredContent,
  };
}
