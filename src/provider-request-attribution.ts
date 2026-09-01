import { ConfigurationError } from "./errors.js";
import { normalizeChatMetadata } from "./metadata.js";
import type { ChatMetadata } from "./types.js";
import type { GenerationCostData } from "./telemetry.js";
import { normalizeCostAmount, normalizeCostCurrency } from "./telemetry.js";

export type ProviderRequestOutcome = "succeeded" | "failed";

/** One provider call reported by a model runtime or orchestration engine. */
export interface ProviderRequestAttributionInput {
  /** Stable within the durable attempt so a reclaimed worker cannot duplicate the record. */
  readonly idempotencyKey: string;
  /** Provider-native request identity used by support teams. */
  readonly providerRequestId?: string | null;
  /** Override the selected engine/model identity when a harness routes this call elsewhere. */
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly outcome: ProviderRequestOutcome;
  readonly inputTokens?: number | null;
  readonly outputTokens?: number | null;
  readonly totalTokens?: number | null;
  readonly cacheReadTokens?: number | null;
  readonly cacheWriteTokens?: number | null;
  readonly latencyMs?: number | null;
  /** Engine-reported estimate. Viby does not apply pricing to this value. */
  readonly cost?: GenerationCostData | null;
  /** Credential-free model/provider metadata safe to retain for support and billing. */
  readonly modelMetadata?: ChatMetadata;
}

export interface ProviderRequestAttributionData {
  readonly id: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly sequence: number;
  readonly idempotencyKey: string;
  readonly providerRequestId: string | null;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly outcome: ProviderRequestOutcome;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly latencyMs: number | null;
  readonly cost: GenerationCostData | null;
  readonly modelMetadata: ChatMetadata;
  readonly createdAt: Date;
}

export interface ProviderRequestAttributionWriter {
  record(input: ProviderRequestAttributionInput): Promise<ProviderRequestAttributionData>;
}

export interface NormalizedProviderRequestAttributionInput {
  readonly idempotencyKey: string;
  readonly providerRequestId: string | null;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly outcome: ProviderRequestOutcome;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
  readonly cacheReadTokens: number | null;
  readonly cacheWriteTokens: number | null;
  readonly latencyMs: number | null;
  readonly cost: GenerationCostData | null;
  readonly modelMetadata: ChatMetadata;
}

export function normalizeProviderRequestAttribution(
  input: ProviderRequestAttributionInput,
): NormalizedProviderRequestAttributionInput {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Provider request attribution must be an object.");
  }
  if (input.outcome !== "succeeded" && input.outcome !== "failed") {
    throw new ConfigurationError("Provider request outcome must be succeeded or failed.");
  }
  const cost = input.cost === undefined || input.cost === null
    ? null
    : {
        amountMicros: normalizeCostAmount(input.cost.amountMicros)!,
        currency: normalizeCostCurrency(input.cost.currency),
      };
  return {
    idempotencyKey: text(input.idempotencyKey, "idempotency key", 200),
    providerRequestId: nullableText(input.providerRequestId, "provider request id", 500),
    modelProvider: optionalText(input.modelProvider, "model provider", 200),
    modelId: optionalText(input.modelId, "model id", 500),
    outcome: input.outcome,
    inputTokens: count(input.inputTokens, "input tokens"),
    outputTokens: count(input.outputTokens, "output tokens"),
    totalTokens: count(input.totalTokens, "total tokens"),
    cacheReadTokens: count(input.cacheReadTokens, "cache read tokens"),
    cacheWriteTokens: count(input.cacheWriteTokens, "cache write tokens"),
    latencyMs: count(input.latencyMs, "latency"),
    cost,
    modelMetadata: normalizeChatMetadata(input.modelMetadata),
  };
}

function count(value: number | null | undefined, label: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError(`Provider request ${label} must be a non-negative safe integer.`);
  }
  return value;
}

function nullableText(
  value: string | null | undefined,
  label: string,
  maxLength: number,
): string | null {
  if (value === undefined || value === null) return null;
  return text(value, label, maxLength);
}

function optionalText(
  value: string | undefined,
  label: string,
  maxLength: number,
): string | null {
  return value === undefined ? null : text(value, label, maxLength);
}

function text(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`Provider request ${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConfigurationError(
      `Provider request ${label} must contain 1-${maxLength} characters.`,
    );
  }
  return normalized;
}
