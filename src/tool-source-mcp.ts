import {
  Client,
  StreamableHTTPClientTransport,
  type CallToolResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/client";
import { ConfigurationError } from "./errors.js";
import { defineToolSource } from "./tool-source.js";
import type {
  ToolDefinition,
  ToolSource,
  ToolSourceContext,
} from "./tool-source.js";
import type { FrameworkId, JsonValue, ToolCallEffect } from "./types.js";

export interface McpClientConnection {
  listTools(): Promise<{ readonly tools: readonly McpTool[] }>;
  callTool(input: {
    readonly name: string;
    readonly arguments?: Readonly<Record<string, unknown>>;
  }): Promise<CallToolResult>;
  close(): Promise<void>;
}

export interface McpToolSourceOptions<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly url?: string | URL;
  /** Resolved inside the transport and never included in model or durable records. */
  readonly headers?: HeadersInit | ((context: ToolSourceContext<Framework>) => (
    HeadersInit | Promise<HeadersInit>
  ));
  readonly fetch?: typeof globalThis.fetch;
  /** Custom connection factory for non-HTTP transports and tests. */
  readonly connect?: (
    context: ToolSourceContext<Framework>,
  ) => McpClientConnection | Promise<McpClientConnection>;
  readonly effect?: ToolCallEffect | ((tool: McpTool) => ToolCallEffect);
  readonly permissions?: (tool: McpTool) => readonly string[];
}

/** Creates a per-chat MCP client source using Streamable HTTP or a custom transport. */
export function mcp<Framework extends FrameworkId = FrameworkId>(
  options: McpToolSourceOptions<Framework>,
): ToolSource<Framework> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("MCP tool source options must be an object.");
  }
  if ((options.url === undefined) === (options.connect === undefined)) {
    throw new ConfigurationError("An MCP tool source requires exactly one of url or connect.");
  }
  const connections = new Map<string, Promise<McpClientConnection>>();
  const connection = (context: ToolSourceContext<Framework>) => {
    const key = `${context.tenantId}\u0000${context.userId}\u0000${context.chatId}`;
    let pending = connections.get(key);
    if (!pending) {
      pending = openConnection(options, context).catch((error) => {
        connections.delete(key);
        throw error;
      });
      connections.set(key, pending);
    }
    return pending;
  };
  return defineToolSource({
    id: options.id,
    async list(context) {
      const result = await (await connection(context)).listTools();
      return result.tools.map((tool) => normalizeTool(options, tool));
    },
    async call(call, context) {
      const result = await (await connection(context)).callTool({
        name: call.name,
        arguments: call.arguments,
      });
      return normalizeCallResult(result);
    },
    async close() {
      const settled = await Promise.allSettled(connections.values());
      connections.clear();
      await Promise.allSettled(settled.flatMap((result) => (
        result.status === "fulfilled" ? [result.value.close()] : []
      )));
    },
  });
}

export const mcpToolSource = mcp;

async function openConnection<Framework extends FrameworkId>(
  options: McpToolSourceOptions<Framework>,
  context: ToolSourceContext<Framework>,
): Promise<McpClientConnection> {
  if (options.connect) return options.connect(context);
  const headers = typeof options.headers === "function"
    ? await options.headers(context)
    : options.headers;
  const client = new Client({ name: "@viby/sdk", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url!), {
    ...(headers ? { requestInit: { headers } } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
  });
  await client.connect(transport);
  return client;
}

function normalizeTool<Framework extends FrameworkId>(
  options: McpToolSourceOptions<Framework>,
  tool: McpTool,
): ToolDefinition {
  const effect = typeof options.effect === "function"
    ? options.effect(tool)
    : options.effect ?? (tool.annotations?.readOnlyHint === true ? "read" : "external");
  return {
    name: tool.name,
    ...(tool.title ? { title: tool.title } : {}),
    description: tool.description?.trim() || `Call the ${tool.name} MCP tool.`,
    inputSchema: normalizeJsonObject(tool.inputSchema, `${tool.name} input schema`),
    effect,
    permissions: options.permissions?.(tool) ?? [`mcp.${options.id}.${tool.name}`],
  };
}

function normalizeCallResult(result: CallToolResult): JsonValue {
  return normalizeJson({
    content: result.content,
    ...(result.structuredContent !== undefined
      ? { structuredContent: result.structuredContent }
      : {}),
    isError: result.isError ?? false,
  }, "MCP tool result");
}

function normalizeJsonObject(value: unknown, label: string): Readonly<Record<string, JsonValue>> {
  const normalized = normalizeJson(value, label);
  if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
    throw new ConfigurationError(`${label} must be a JSON object.`);
  }
  return normalized;
}

function normalizeJson(value: unknown, label: string): JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("undefined");
    return JSON.parse(serialized) as JsonValue;
  } catch (error) {
    throw new ConfigurationError(`${label} must be JSON serializable.`, { cause: error });
  }
}
