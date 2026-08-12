import { ConfigurationError } from "./errors.js";
import {
  resolveToolSources,
  type ToolDefinition,
  type ToolSourceCall,
  type ToolSourceContext,
} from "./tool-source.js";
import {
  defineToolSourceAdapter,
  type ToolSourceAdapter,
  type ToolSourceRegistrationData,
} from "./tool-source-registry.js";
import type { ToolSourceCredentialContext } from "./tool-source-authorization.js";
import type { FrameworkId, JsonValue } from "./types.js";

export interface ToolSourceAdapterConformanceInput<
  Framework extends FrameworkId = FrameworkId,
> {
  readonly adapter: ToolSourceAdapter<Framework>;
  /** Public durable registration owned by the caller's disposable fixture. */
  readonly source: ToolSourceRegistrationData;
  readonly context: ToolSourceContext<Framework>;
  /** A harmless call whose name must be returned by `list()`. */
  readonly call: ToolSourceCall;
  /** Optional opaque credential resolver for adapters that require authorization. */
  readonly credential?: (signal?: AbortSignal) => Promise<ToolSourceCredentialContext>;
  readonly validateTools?: (
    tools: readonly ToolDefinition[],
  ) => void | Promise<void>;
  readonly validateResult?: (
    result: JsonValue,
  ) => void | Promise<void>;
}

export type ToolSourceAdapterConformanceCheck =
  | "identity"
  | "open"
  | "list"
  | "call"
  | "credential-boundary"
  | "close";

export interface ToolSourceAdapterConformanceReport {
  readonly type: string;
  readonly sourceId: string;
  readonly toolNames: readonly string[];
  readonly credentialRequests: number;
  readonly checks: readonly ToolSourceAdapterConformanceCheck[];
}

/**
 * Runs the provider-neutral durable tool-source contract against a caller-owned
 * fixture. Credentials and provider setup remain outside the suite, and the
 * report never includes tool results or credential material.
 */
export async function verifyToolSourceAdapter<Framework extends FrameworkId>(
  input: ToolSourceAdapterConformanceInput<Framework>,
): Promise<ToolSourceAdapterConformanceReport> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Tool-source adapter conformance input is required.");
  }
  const adapter = defineToolSourceAdapter(input.adapter);
  if (!input.source || typeof input.source !== "object") {
    throw new ConfigurationError("Tool-source conformance requires a durable source registration.");
  }
  if (adapter.type !== input.source.type) {
    throw new ToolSourceAdapterConformanceError(
      "identity",
      `Adapter type ${adapter.type} does not match registration type ${input.source.type}.`,
    );
  }
  if (!input.context || typeof input.context !== "object") {
    throw new ConfigurationError("Tool-source conformance requires a generation context.");
  }
  if (!input.call || typeof input.call !== "object") {
    throw new ConfigurationError("Tool-source conformance requires a harmless call probe.");
  }

  const checks: ToolSourceAdapterConformanceCheck[] = ["identity"];
  const credentialSecrets: string[] = [];
  let toolNames: readonly string[] = [];
  let credentialRequests = 0;
  const credential = input.credential
    ? async (signal?: AbortSignal) => {
      credentialRequests += 1;
      const resolved = await input.credential!(signal);
      credentialSecrets.push(new TextDecoder().decode(resolved.credential));
      return resolved;
    }
    : undefined;

  let currentCheck: ToolSourceAdapterConformanceCheck = "open";
  let source: Awaited<ReturnType<ToolSourceAdapter<Framework>["open"]>> | null = null;
  try {
    source = await adapter.open({
      source: input.source,
      scope: {
        tenantId: input.context.tenantId,
        userId: input.context.userId,
      },
      ...(credential ? { credential } : {}),
    });
    if (source.id !== input.source.id) {
      throw new ToolSourceAdapterConformanceError(
        "open",
        `Adapter returned source id ${source.id}; expected ${input.source.id}.`,
      );
    }
    checks.push("open");

    currentCheck = "list";
    const resolved = await resolveToolSources({
      sources: { [source.id]: source },
    }, input.context);
    const tools = resolved.map(({ tool }) => tool);
    toolNames = Object.freeze(tools.map((tool) => tool.name));
    if (tools.length === 0) {
      throw new ToolSourceAdapterConformanceError("list", "Adapter returned no tools.");
    }
    assertNoCredentialLeak("list", tools, credentialSecrets);
    await input.validateTools?.(Object.freeze(tools));
    checks.push("list");

    currentCheck = "call";
    if (!tools.some((tool) => tool.name === input.call.name)) {
      throw new ToolSourceAdapterConformanceError(
        "call",
        `Call probe ${input.call.name} was not returned by list().`,
      );
    }
    const result = await source.call(input.call, input.context);
    assertJsonValue(result);
    assertNoCredentialLeak("call", result, credentialSecrets);
    await input.validateResult?.(result);
    checks.push("call");

    if (credential) {
      currentCheck = "credential-boundary";
      if (credentialRequests === 0) {
        throw new ToolSourceAdapterConformanceError(
          "credential-boundary",
          "A credential resolver was supplied but the adapter never requested it.",
        );
      }
      checks.push("credential-boundary");
    }
  } catch (error) {
    if (error instanceof ToolSourceAdapterConformanceError || error instanceof ConfigurationError) {
      throw error;
    }
    throw new ToolSourceAdapterConformanceError(
      currentCheck,
      "The adapter operation failed.",
      { cause: error },
    );
  } finally {
    if (source?.close) {
      await source.close();
      checks.push("close");
    }
  }

  return Object.freeze({
    type: adapter.type,
    sourceId: input.source.id,
    toolNames,
    credentialRequests,
    checks: Object.freeze(checks),
  });
}

export class ToolSourceAdapterConformanceError extends Error {
  override readonly name = "ToolSourceAdapterConformanceError";
  readonly check: ToolSourceAdapterConformanceCheck;

  constructor(
    check: ToolSourceAdapterConformanceCheck,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.check = check;
  }
}

function assertNoCredentialLeak(
  check: ToolSourceAdapterConformanceCheck,
  value: unknown,
  credentialSecrets: readonly string[],
): void {
  const serialized = JSON.stringify(value);
  for (const secret of credentialSecrets) {
    if (secret && serialized.includes(secret)) {
      throw new ToolSourceAdapterConformanceError(
        check,
        "Adapter exposed opaque credential material in a model-visible value.",
      );
    }
  }
}

function assertJsonValue(value: unknown): asserts value is JsonValue {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new Error("not serializable");
    JSON.parse(serialized);
  } catch (error) {
    throw new ToolSourceAdapterConformanceError(
      "call",
      "Adapter returned a value that is not JSON-serializable.",
      { cause: error },
    );
  }
}
