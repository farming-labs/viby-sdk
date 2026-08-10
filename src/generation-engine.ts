import { ConfigurationError } from "./errors.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "./generator.js";
import type { FrameworkId } from "./types.js";

export interface GenerationEngineIdentity {
  /** Stable runtime or provider name used for durable attribution and worker routing. */
  readonly provider: string;
  /** Stable model, agent, or orchestration identifier used for durable attribution. */
  readonly model: string;
}

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
}

export interface DefineGenerationEngineInput<Framework extends FrameworkId = FrameworkId> {
  readonly identity: GenerationEngineIdentity;
  generate(
    input: GeneratorInput<Framework>,
    options?: GeneratorOptions,
  ): Promise<GeneratorOutput>;
}

/** Defines and validates a custom generation engine without coupling it to an AI SDK model. */
export function defineGenerationEngine<Framework extends FrameworkId = FrameworkId>(
  input: DefineGenerationEngineInput<Framework>,
): GenerationEngine<Framework> {
  const identity = normalizeGenerationEngineIdentity(input?.identity);
  if (typeof input?.generate !== "function") {
    throw new ConfigurationError("A generation engine must implement generate(input, options).");
  }
  return Object.freeze({
    identity,
    generate: input.generate.bind(input),
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
