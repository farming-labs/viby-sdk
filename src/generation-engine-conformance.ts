import { ConfigurationError } from "./errors.js";
import type { GeneratorInput, GeneratorOutput } from "./generator.js";
import {
  normalizeGenerationEngineCapabilities,
  normalizeGenerationEngineIdentity,
  type GenerationEngineCapabilities,
  type GenerationEngine,
} from "./generation-engine.js";
import type { FrameworkId } from "./types.js";

export interface GenerationEngineConformanceScenario<
  Framework extends FrameworkId = FrameworkId,
> {
  readonly name: string;
  readonly input: GeneratorInput<Framework>;
  readonly expected: GeneratorOutput["kind"];
  readonly validate?: (output: GeneratorOutput) => void | Promise<void>;
}

export interface GenerationEngineConformanceInput<
  Framework extends FrameworkId = FrameworkId,
> {
  readonly engine: GenerationEngine<Framework>;
  /** Caller-owned deterministic prompts and fixtures for the engine under test. */
  readonly scenarios: readonly GenerationEngineConformanceScenario<Framework>[];
}

export interface GenerationEngineConformanceReport {
  readonly identity: { readonly provider: string; readonly model: string };
  readonly capabilities: GenerationEngineCapabilities;
  readonly checks: readonly string[];
}

/** Runs portable output and cancellation checks without assuming an engine implementation. */
export async function verifyGenerationEngine<Framework extends FrameworkId = FrameworkId>(
  input: GenerationEngineConformanceInput<Framework>,
): Promise<GenerationEngineConformanceReport> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Generation engine conformance input is required.");
  }
  const identity = normalizeGenerationEngineIdentity(input.engine?.identity);
  const capabilities = normalizeGenerationEngineCapabilities(input.engine?.capabilities);
  if (typeof input.engine?.generate !== "function") {
    throw new ConfigurationError("A generation engine must implement generate(input, options).");
  }
  if (!Array.isArray(input.scenarios) || input.scenarios.length === 0) {
    throw new ConfigurationError("Generation engine conformance requires at least one scenario.");
  }

  const checks = ["identity"];
  for (const scenario of input.scenarios) {
    const name = scenario.name?.trim();
    if (!name) throw new ConfigurationError("Every generation engine scenario requires a name.");
    const operation = scenario.input.operation ?? "change";
    if (!capabilities.operations.includes(operation)) {
      throw new GenerationEngineConformanceError(
        `Generation engine scenario ${name} uses unadvertised operation ${operation}.`,
      );
    }
    const output = await input.engine.generate(scenario.input);
    validateOutput(output, scenario.expected, name);
    await scenario.validate?.(output);
    checks.push(name);
  }

  if (capabilities.steering) {
    let steeringConsumed = false;
    const steeringOutput = await input.engine.generate(input.scenarios[0]!.input, {
      steering: {
        async consume() {
          steeringConsumed = true;
          return [];
        },
      },
    });
    validateOutput(steeringOutput, input.scenarios[0]!.expected, "steering");
    if (!steeringConsumed) {
      throw new GenerationEngineConformanceError(
        "Generation engine advertises steering but did not consume the provider-neutral channel.",
      );
    }
    checks.push("steering");
  }

  const cancelled = new AbortController();
  cancelled.abort(new DOMException("Conformance cancellation probe.", "AbortError"));
  await Promise.resolve(
    input.engine.generate(input.scenarios[0]!.input, { signal: cancelled.signal }),
  ).then(
    () => {
      throw new GenerationEngineConformanceError(
        "Generation engine ignored an already-aborted signal.",
      );
    },
    () => undefined,
  );
  checks.push("cancellation");

  return Object.freeze({ identity, capabilities, checks: Object.freeze(checks) });
}

export class GenerationEngineConformanceError extends Error {
  override readonly name = "GenerationEngineConformanceError";
}

function validateOutput(
  output: GeneratorOutput,
  expected: GeneratorOutput["kind"],
  scenario: string,
): void {
  if (!output || typeof output !== "object" || output.kind !== expected) {
    throw new GenerationEngineConformanceError(
      `Generation engine scenario ${scenario} returned ${output?.kind ?? "no output"}; expected ${expected}.`,
    );
  }
  if (typeof output.finishReason !== "string" || output.finishReason.length === 0) {
    throw new GenerationEngineConformanceError(
      `Generation engine scenario ${scenario} returned no finish reason.`,
    );
  }
  const usage = output.usage;
  if (!usage || typeof usage !== "object") {
    throw new GenerationEngineConformanceError(
      `Generation engine scenario ${scenario} returned no usage record.`,
    );
  }
  if (output.kind === "project" && output.files.length === 0) {
    throw new GenerationEngineConformanceError(
      `Generation engine scenario ${scenario} returned an empty project.`,
    );
  }
  if (output.kind === "changes" && output.changes.length === 0) {
    throw new GenerationEngineConformanceError(
      `Generation engine scenario ${scenario} returned no source changes.`,
    );
  }
}
