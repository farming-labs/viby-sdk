import { ConfigurationError } from "./errors.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "./generator.js";
import type { FrameworkId, GenerationOperation } from "./types.js";

export type GenerationEngineInput<Framework extends FrameworkId = FrameworkId> =
  GeneratorInput<Framework>;
export type GenerationEngineContext = GeneratorOptions;
export type GenerationEngineOutput = GeneratorOutput;

export interface GenerationEngineIdentity {
  /** Stable runtime or provider name used for durable attribution and worker routing. */
  readonly provider: string;
  /** Stable model, agent, or orchestration identifier used for durable attribution. */
  readonly model: string;
}

/**
 * Optional behavior an engine can expose beyond producing immutable source.
 *
 * Viby capability-gates optional operations instead of assuming every remote
 * harness supports inspection, live steering, durable traces, or artifacts.
 */
export interface GenerationEngineCapabilities {
  /** Operations accepted by the engine. `change` is the compatibility default. */
  readonly operations: readonly GenerationOperation[];
  /** Emits incremental assistant text through `context.onDelta`. */
  readonly streaming: boolean;
  /** Consumes durable steering updates at engine-defined safe boundaries. */
  readonly steering: boolean;
  /** Emits typed reasoning, command, search, and file events through `context.trace`. */
  readonly traces: boolean;
  /** Persists provider-neutral tool calls through `context.toolCalls`. */
  readonly toolCalls: boolean;
  /** May return generated binary artifacts in its final output. */
  readonly artifacts: boolean;
}

export type GenerationEngineCapabilitiesInput = Partial<GenerationEngineCapabilities>;

const DEFAULT_GENERATION_ENGINE_CAPABILITIES: GenerationEngineCapabilities = Object.freeze({
  operations: Object.freeze(["change"] as const),
  streaming: false,
  steering: false,
  traces: false,
  toolCalls: false,
  artifacts: false,
});

/**
 * Provider-neutral execution boundary for one Viby generation attempt.
 *
 * Engines may call a model directly, run a multi-step agent, delegate to a
 * remote runtime, or coordinate their own orchestration system. Viby retains
 * ownership of durable attempts, events, tasks, source versions, and usage.
 */
export interface GenerationEngine<Framework extends FrameworkId = FrameworkId>
extends ProjectGenerator<Framework> {
  readonly identity: GenerationEngineIdentity;
  readonly capabilities?: GenerationEngineCapabilitiesInput;
  /** Releases an optional remote client, session pool, or orchestration runtime. */
  close?(): Promise<void>;
}

export interface DefineGenerationEngineInput<Framework extends FrameworkId = FrameworkId> {
  readonly identity: GenerationEngineIdentity;
  readonly capabilities?: GenerationEngineCapabilitiesInput;
  generate(
    input: GeneratorInput<Framework>,
    options?: GeneratorOptions,
  ): Promise<GeneratorOutput>;
  close?(): Promise<void>;
}

/** Defines and validates a custom generation engine without coupling it to an AI SDK model. */
export function defineGenerationEngine<Framework extends FrameworkId = FrameworkId>(
  input: DefineGenerationEngineInput<Framework>,
): GenerationEngine<Framework> {
  const identity = normalizeGenerationEngineIdentity(input?.identity);
  const capabilities = normalizeGenerationEngineCapabilities(input?.capabilities);
  if (typeof input?.generate !== "function") {
    throw new ConfigurationError("A generation engine must implement generate(input, options).");
  }
  return Object.freeze({
    identity,
    capabilities,
    generate: input.generate.bind(input),
    ...(typeof input.close === "function" ? { close: input.close.bind(input) } : {}),
  });
}

export function normalizeGenerationEngineCapabilities(
  capabilities: GenerationEngineCapabilitiesInput | undefined,
): GenerationEngineCapabilities {
  if (capabilities !== undefined && (!capabilities || typeof capabilities !== "object")) {
    throw new ConfigurationError("Generation engine capabilities must be an object.");
  }
  const operations = capabilities?.operations ?? DEFAULT_GENERATION_ENGINE_CAPABILITIES.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ConfigurationError("Generation engine capabilities.operations cannot be empty.");
  }
  const normalizedOperations = [...new Set(operations)];
  if (normalizedOperations.some((operation) => operation !== "change" && operation !== "inspect")) {
    throw new ConfigurationError(
      "Generation engine capabilities.operations may contain only change or inspect.",
    );
  }
  return Object.freeze({
    operations: Object.freeze(normalizedOperations),
    streaming: booleanCapability(capabilities?.streaming, "streaming"),
    steering: booleanCapability(capabilities?.steering, "steering"),
    traces: booleanCapability(capabilities?.traces, "traces"),
    toolCalls: booleanCapability(capabilities?.toolCalls, "toolCalls"),
    artifacts: booleanCapability(capabilities?.artifacts, "artifacts"),
  });
}

export function normalizeGenerationEngineIdentity(
  identity: GenerationEngineIdentity | undefined,
): GenerationEngineIdentity {
  if (!identity || typeof identity !== "object") {
    throw new ConfigurationError("A generation engine identity is required.");
  }
  return Object.freeze({
    provider: normalizeIdentityPart(identity.provider, "provider"),
    model: normalizeIdentityPart(identity.model, "model"),
  });
}

function normalizeIdentityPart(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`Generation engine ${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new ConfigurationError(
      `Generation engine ${label} must contain between 1 and 200 characters.`,
    );
  }
  return normalized;
}

function booleanCapability(value: boolean | undefined, name: string): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ConfigurationError(`Generation engine capability ${name} must be a boolean.`);
  }
  return value ?? false;
}
