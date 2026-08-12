import { sha256 } from "@noble/hashes/sha2";
import type {
  ChatMetadata,
  FrameworkId,
  JsonValue,
  ToolCallEffect,
  UserScope,
} from "./types.js";
import { ConfigurationError } from "./errors.js";
import type { ToolSourceAdapter } from "./tool-source-registry.js";

export interface ToolSourceContext<Framework extends FrameworkId = FrameworkId>
extends UserScope {
  readonly chatId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly framework: Framework;
  readonly metadata: ChatMetadata;
  readonly signal?: AbortSignal;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly effect: ToolCallEffect;
  readonly permissions?: readonly string[];
}

export interface ToolSourceCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly idempotencyKey: string;
}

/** A credential-free source of tools. Credentials belong in adapter closures. */
export interface ToolSource<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  list(context: ToolSourceContext<Framework>): Promise<readonly ToolDefinition[]>;
  call(call: ToolSourceCall, context: ToolSourceContext<Framework>): Promise<JsonValue>;
  close?(): Promise<void>;
}

export type ToolSourcePolicyDecision = "allow" | "deny" | "approval-required";

export interface ToolSourcePolicyRequest<Framework extends FrameworkId = FrameworkId> {
  readonly source: string;
  readonly tool: ToolDefinition;
  readonly arguments: Readonly<Record<string, JsonValue>>;
  readonly context: ToolSourceContext<Framework>;
}

export type ToolSourcePolicy<Framework extends FrameworkId = FrameworkId> = (
  request: ToolSourcePolicyRequest<Framework>,
) => ToolSourcePolicyDecision | Promise<ToolSourcePolicyDecision>;

export interface ToolSourceSelectionContext<Framework extends FrameworkId = FrameworkId> {
  readonly available: readonly string[];
  readonly context: ToolSourceContext<Framework>;
}

export interface ToolSourceResolver<Framework extends FrameworkId = FrameworkId> {
  resolve(context: ToolSourceContext<Framework>): Promise<readonly ToolSource<Framework>[]>;
}

export interface ToolSourcesConfig<Framework extends FrameworkId = FrameworkId> {
  /** Shared, process-configured sources. Existing applications may keep using only this path. */
  readonly sources?: Readonly<Record<string, ToolSource<Framework>>>;
  /** Registration types available to tenant-scoped durable sources. */
  readonly adapters?: Readonly<Record<string, ToolSourceAdapter<Framework>>>;
  /** Select sources for each chat. Omit to expose every configured source. */
  readonly select?: (
    input: ToolSourceSelectionContext<Framework>,
  ) => readonly string[] | Promise<readonly string[]>;
  /** Defaults to allowing reads and requiring approval for writes/external effects. */
  readonly policy?: ToolSourcePolicy<Framework>;
}

export interface ToolSourcesRuntimeConfig<Framework extends FrameworkId = FrameworkId>
extends ToolSourcesConfig<Framework> {
  readonly registry?: ToolSourceResolver<Framework>;
}

export interface ResolvedToolSource<Framework extends FrameworkId = FrameworkId> {
  readonly key: string;
  readonly source: ToolSource<Framework>;
  readonly tool: ToolDefinition;
}

export interface ToolSourceProposedAction {
  readonly type: "tool-source-call";
  readonly idempotencyKey: string;
  readonly source: string;
  readonly tool: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export function defineToolSource<Framework extends FrameworkId = FrameworkId>(
  source: ToolSource<Framework>,
): ToolSource<Framework> {
  assertToolSource(source);
  return source;
}

export async function resolveToolSources<Framework extends FrameworkId>(
  config: ToolSourcesRuntimeConfig<Framework> | undefined,
  context: ToolSourceContext<Framework>,
): Promise<readonly ResolvedToolSource<Framework>[]> {
  if (!config) return [];
  const durable = await config.registry?.resolve(context) ?? [];
  const entries = [
    ...Object.entries(config.sources ?? {}),
    ...durable.map((source) => [source.id, source] as const),
  ];
  if (new Set(entries.map(([id]) => id)).size !== entries.length) {
    throw new ConfigurationError("Static and durable tool source ids must be unique.");
  }
  const available = entries.map(([id]) => id);
  const selected = config.select
    ? await config.select({ available: Object.freeze(available), context })
    : available;
  if (!Array.isArray(selected)) {
    throw new ConfigurationError("tools.select must return an array of source ids.");
  }
  const selectedIds = new Set(selected);
  for (const id of selectedIds) {
    if (!entries.some(([availableId]) => availableId === id)) {
      throw new ConfigurationError(`tools.select returned an unknown source id: ${id}`);
    }
  }
  const names = new Set<string>();
  const resolved: ResolvedToolSource<Framework>[] = [];
  for (const [id, source] of entries) {
    if (!selectedIds.has(id)) continue;
    assertToolSource(source);
    if (source.id !== id) {
      throw new ConfigurationError(`Tool source key ${id} must match source.id ${source.id}.`);
    }
    for (const definition of await source.list(context)) {
      assertToolDefinition(id, definition);
      const key = toolKey(id, definition.name);
      if (names.has(key)) throw new ConfigurationError(`Duplicate inbound tool name: ${key}`);
      names.add(key);
      resolved.push({ key, source, tool: definition });
    }
  }
  return Object.freeze(resolved);
}

export function resolveToolSourcePolicy<Framework extends FrameworkId>(
  config: ToolSourcesConfig<Framework>,
  request: ToolSourcePolicyRequest<Framework>,
): ToolSourcePolicyDecision | Promise<ToolSourcePolicyDecision> {
  return config.policy?.(request)
    ?? (request.tool.effect === "read" ? "allow" : "approval-required");
}

export function createToolSourceProposedAction(
  source: string,
  tool: string,
  arguments_: Readonly<Record<string, JsonValue>>,
  context: Pick<ToolSourceContext, "tenantId" | "userId" | "chatId">,
): ToolSourceProposedAction {
  const canonical = stableStringify({
    tenantId: context.tenantId,
    userId: context.userId,
    chatId: context.chatId,
    source,
    tool,
    arguments: arguments_,
  });
  return {
    type: "tool-source-call",
    idempotencyKey: `tool-source:${bytesToHex(sha256(new TextEncoder().encode(canonical)))}`,
    source,
    tool,
    arguments: arguments_,
  };
}

function toolKey(source: string, name: string): string {
  const key = `${source}__${name}`.replace(/[^a-zA-Z0-9_-]/g, "_");
  if (key.length > 128) throw new ConfigurationError(`Inbound tool name is too long: ${key}`);
  return key;
}

function assertToolSource(source: ToolSource): void {
  if (!source || typeof source !== "object" || !/^[a-zA-Z0-9_-]{1,64}$/.test(source.id)) {
    throw new ConfigurationError("A tool source requires an alphanumeric id (hyphen and underscore allowed).");
  }
  if (typeof source.list !== "function" || typeof source.call !== "function") {
    throw new ConfigurationError(`Tool source ${source.id} must implement list() and call().`);
  }
}

function assertToolDefinition(source: string, tool: ToolDefinition): void {
  if (!tool || typeof tool !== "object" || !/^[a-zA-Z0-9_.-]{1,96}$/.test(tool.name)) {
    throw new ConfigurationError(`Tool source ${source} returned an invalid tool name.`);
  }
  if (!tool.description?.trim()) {
    throw new ConfigurationError(`Tool ${source}.${tool.name} requires a description.`);
  }
  if (!tool.inputSchema || typeof tool.inputSchema !== "object" || Array.isArray(tool.inputSchema)) {
    throw new ConfigurationError(`Tool ${source}.${tool.name} requires an object JSON schema.`);
  }
  if (!(["read", "write", "external"] as const).includes(tool.effect)) {
    throw new ConfigurationError(`Tool ${source}.${tool.name} has an invalid effect.`);
  }
}

function stableStringify(value: JsonValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(value[key]!)}`
  )).join(",")}}`;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}
