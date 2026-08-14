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
import {
  defineToolSourceAdapter,
  type ToolSourceAdapter,
  type ToolSourceRegistrationData,
} from "./tool-source-registry.js";
import type {
  ToolSourceAuthorizationAdapter,
  ToolSourceCredentialContext,
} from "./tool-source-authorization.js";

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

export interface McpAdapterConnectionInput<Framework extends FrameworkId = FrameworkId> {
  readonly source: ToolSourceRegistrationData;
  readonly context: ToolSourceContext<Framework>;
  readonly credential?: (signal?: AbortSignal) => Promise<ToolSourceCredentialContext>;
}

export interface McpAdapterHeaderInput<Framework extends FrameworkId = FrameworkId>
extends McpAdapterConnectionInput<Framework> {
  readonly signal?: AbortSignal;
}

export interface McpToolSourceAdapterOptions<Framework extends FrameworkId = FrameworkId> {
  /** Durable registration type. Defaults to `mcp`. */
  readonly type?: string;
  /** Optional provider-neutral OAuth/authorization lifecycle. */
  readonly authorization?: ToolSourceAuthorizationAdapter;
  /** Resolve public registration configuration to an MCP URL. Defaults to `configuration.url`. */
  readonly url?: (source: ToolSourceRegistrationData) => string | URL;
  /**
   * Request headers resolved inside the transport boundary. Authorized adapters
   * default to a live bearer credential when this callback is omitted.
   */
  readonly headers?: (
    input: McpAdapterHeaderInput<Framework>,
  ) => HeadersInit | Promise<HeadersInit>;
  readonly fetch?: typeof globalThis.fetch;
  /** Custom connection factory for non-HTTP transports and deterministic tests. */
  readonly connect?: (
    input: McpAdapterConnectionInput<Framework>,
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

/** Materializes durable registrations as per-chat MCP tool sources. */
export function mcpAdapter<Framework extends FrameworkId = FrameworkId>(
  options: McpToolSourceAdapterOptions<Framework> = {},
): ToolSourceAdapter<Framework> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("MCP adapter options must be an object.");
  }
  if (options.url && options.connect) {
    throw new ConfigurationError("A durable MCP adapter cannot configure both url and connect.");
  }
  const type = options.type ?? "mcp";
  return defineToolSourceAdapter({
    type,
    ...(options.authorization ? { authorization: options.authorization } : {}),
    open({ source, credential }) {
      if (options.connect) {
        return mcp({
          id: source.id,
          connect: (context) => options.connect!({ source, context, ...(credential ? { credential } : {}) }),
          ...(options.effect ? { effect: options.effect } : {}),
          ...(options.permissions ? { permissions: options.permissions } : {}),
        });
      }
      const url = options.url?.(source) ?? registeredMcpUrl(source);
      return mcp({
        id: source.id,
        url,
        headers: (context) => registeredMcpHeaders(options, source, context, credential),
        ...(options.fetch ? { fetch: options.fetch } : {}),
        ...(options.effect ? { effect: options.effect } : {}),
        ...(options.permissions ? { permissions: options.permissions } : {}),
      });
    },
  });
}

export const durableMcp = mcpAdapter;

async function openConnection<Framework extends FrameworkId>(
  options: McpToolSourceOptions<Framework>,
  context: ToolSourceContext<Framework>,
): Promise<McpClientConnection> {
  if (options.connect) return options.connect(context);
  let dynamicHeaders: ((context: ToolSourceContext<Framework>) => (
    HeadersInit | Promise<HeadersInit>
  )) | undefined;
  let headers: HeadersInit | undefined;
  if (typeof options.headers === "function") dynamicHeaders = options.headers;
  else headers = options.headers;
  const fetch_ = dynamicHeaders
    ? async (input: RequestInfo | URL, init?: RequestInit) => {
      const resolved = await dynamicHeaders(context);
      const requestHeaders = new Headers(init?.headers);
      new Headers(resolved).forEach((value, name) => requestHeaders.set(name, value));
      return (options.fetch ?? globalThis.fetch)(input, { ...init, headers: requestHeaders });
    }
    : options.fetch;
  const client = new Client({ name: "@viby/sdk", version: "1" });
  const transport = new StreamableHTTPClientTransport(new URL(options.url!), {
    ...(headers ? { requestInit: { headers } } : {}),
    ...(fetch_ ? { fetch: fetch_ } : {}),
  });
  await client.connect(transport);
  return client;
}

function registeredMcpUrl(source: ToolSourceRegistrationData): string {
  const value = source.configuration.url;
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(
      `Durable MCP source ${source.id} requires a public configuration.url.`,
    );
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch (error) {
    throw new ConfigurationError(`Durable MCP source ${source.id} has an invalid URL.`, {
      cause: error,
    });
  }
  if (url.protocol !== "https:" && !isLoopbackHttp(url)) {
    throw new ConfigurationError(
      `Durable MCP source ${source.id} must use HTTPS (HTTP is allowed only for loopback).`,
    );
  }
  url.hash = "";
  return url.toString();
}

async function registeredMcpHeaders<Framework extends FrameworkId>(
  options: McpToolSourceAdapterOptions<Framework>,
  source: ToolSourceRegistrationData,
  context: ToolSourceContext<Framework>,
  credential: ((signal?: AbortSignal) => Promise<ToolSourceCredentialContext>) | undefined,
): Promise<HeadersInit> {
  if (options.headers) {
    return options.headers({
      source,
      context,
      ...(credential ? { credential } : {}),
      ...(context.signal ? { signal: context.signal } : {}),
    });
  }
  if (!options.authorization) return {};
  if (!credential) {
    throw new ConfigurationError(`Authorized MCP adapter ${options.type ?? "mcp"} has no credential resolver.`);
  }
  const resolved = await credential(context.signal);
  return { Authorization: `Bearer ${new TextDecoder().decode(resolved.credential)}` };
}

function isLoopbackHttp(url: URL): boolean {
  return url.protocol === "http:"
    && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
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
