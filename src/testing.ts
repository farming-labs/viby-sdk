/**
 * Published test utilities for Viby hosts and adapter authors.
 *
 * This entry point is intentionally separate from the runtime-neutral core. Conformance suites may
 * create disposable resources, and callers remain responsible for supplying safe test fixtures.
 */
export * from "./artifact-store-conformance.js";
export * from "./browser-conformance.js";
export * from "./deployment-integration-conformance.js";
export * from "./generation-engine-conformance.js";
export * from "./integration-store-conformance.js";
export * from "./persistence-conformance.js";
export * from "./repository-integration-conformance.js";
export * from "./sandbox-conformance.js";
export * from "./tool-source-conformance.js";
export { MemoryRepository, type MemoryRepositoryState } from "./memory-repository.js";

import { ConfigurationError } from "./errors.js";
import {
  defineGenerationEngine,
  type GenerationEngine,
  type GenerationEngineCapabilitiesInput,
  type GenerationEngineIdentity,
} from "./generation-engine.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
} from "./generator.js";
import type { FrameworkId } from "./types.js";

export type ScriptedGenerationStep<Framework extends FrameworkId = FrameworkId> =
  | GeneratorOutput
  | Error
  | ((
      input: GeneratorInput<Framework>,
      context: GeneratorOptions | undefined,
    ) => GeneratorOutput | Promise<GeneratorOutput>);

export interface ScriptedGenerationEngineOptions<Framework extends FrameworkId = FrameworkId> {
  readonly identity?: GenerationEngineIdentity;
  readonly capabilities?: GenerationEngineCapabilitiesInput;
  readonly steps?: readonly ScriptedGenerationStep<Framework>[];
}

export interface ScriptedGenerationEngine<Framework extends FrameworkId = FrameworkId> {
  readonly engine: GenerationEngine<Framework>;
  /** A defensive snapshot of calls received by the engine. */
  readonly calls: readonly GeneratorInput<Framework>[];
  readonly remaining: number;
  enqueue(...steps: readonly ScriptedGenerationStep<Framework>[]): void;
  clear(): void;
}

export class ScriptedGenerationEngineExhaustedError extends Error {
  override readonly name = "ScriptedGenerationEngineExhaustedError";
}

/**
 * Creates a deterministic queue-driven engine for host API, worker, and UI tests.
 *
 * It performs no network access and never supplies hidden fallback output. Every generation consumes
 * exactly one queued step, making accidental extra attempts and retries visible to the test.
 */
export function createScriptedGenerationEngine<Framework extends FrameworkId = FrameworkId>(
  options: ScriptedGenerationEngineOptions<Framework> = {},
): ScriptedGenerationEngine<Framework> {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Scripted generation engine options must be an object.");
  }
  const steps = [...(options.steps ?? [])];
  const calls: GeneratorInput<Framework>[] = [];
  const engine = defineGenerationEngine<Framework>({
    identity: options.identity ?? { provider: "viby-testing", model: "scripted" },
    ...(options.capabilities === undefined ? {} : { capabilities: options.capabilities }),
    async generate(input, context) {
      context?.signal?.throwIfAborted();
      calls.push(input);
      const step = steps.shift();
      if (step === undefined) {
        throw new ScriptedGenerationEngineExhaustedError(
          `No scripted generation step remains for attempt ${context?.run?.attemptId ?? "unknown"}.`,
        );
      }
      if (step instanceof Error) throw step;
      return typeof step === "function" ? step(input, context) : step;
    },
  });

  return {
    engine,
    get calls() {
      return Object.freeze([...calls]);
    },
    get remaining() {
      return steps.length;
    },
    enqueue(...next) {
      steps.push(...next);
    },
    clear() {
      steps.length = 0;
      calls.length = 0;
    },
  };
}
