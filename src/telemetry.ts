import { ConfigurationError } from "./errors.js";

export type TelemetryAttribute = string | number | boolean | readonly string[] | readonly number[];
export type TelemetryAttributes = Readonly<Record<string, TelemetryAttribute>>;

export interface TelemetrySpan {
  setAttributes(attributes: TelemetryAttributes): void;
  setStatus(status: "ok" | "error", message?: string): void;
  recordException(error: unknown): void;
  end(): void;
}

export interface TelemetrySpanInput {
  readonly name: string;
  readonly attributes: TelemetryAttributes;
}

export interface TelemetryMetricInput {
  readonly name: string;
  readonly kind: "counter" | "histogram";
  readonly value: number;
  readonly unit?: string;
  readonly description?: string;
  readonly attributes: TelemetryAttributes;
}

export interface VibyTelemetry {
  startSpan(input: TelemetrySpanInput): TelemetrySpan;
  recordMetric(input: TelemetryMetricInput): void;
}

export interface GenerationCostData {
  readonly amountMicros: number;
  readonly currency: string;
}

export interface GenerationCostInput {
  readonly tenantId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly totalTokens: number | null;
}

export type GenerationCostCalculator = (
  input: GenerationCostInput,
) => number | null | Promise<number | null>;

export interface GenerationCostConfig {
  /** ISO currency or application-owned credit unit, such as USD or CREDITS. */
  readonly currency: string;
  /** Return the estimated cost in millionths of the configured unit. */
  readonly calculate: GenerationCostCalculator;
}

export interface OpenTelemetrySpanLike {
  setAttributes(attributes: Record<string, TelemetryAttribute>): unknown;
  setStatus(status: { code: number; message?: string }): unknown;
  recordException(exception: unknown): unknown;
  end(): unknown;
}

export interface OpenTelemetryTracerLike {
  startSpan(
    name: string,
    options: { attributes: Record<string, TelemetryAttribute> },
  ): OpenTelemetrySpanLike;
}

export interface OpenTelemetryCounterLike {
  add(value: number, attributes?: Record<string, TelemetryAttribute>): unknown;
}

export interface OpenTelemetryHistogramLike {
  record(value: number, attributes?: Record<string, TelemetryAttribute>): unknown;
}

export interface OpenTelemetryMeterLike {
  createCounter(
    name: string,
    options?: { unit?: string; description?: string },
  ): OpenTelemetryCounterLike;
  createHistogram(
    name: string,
    options?: { unit?: string; description?: string },
  ): OpenTelemetryHistogramLike;
}

export interface OpenTelemetryOptions {
  readonly tracer: OpenTelemetryTracerLike;
  readonly meter?: OpenTelemetryMeterLike;
}

/** Adapt OpenTelemetry API-compatible tracer and meter objects without owning global setup. */
export function openTelemetry(options: OpenTelemetryOptions): VibyTelemetry {
  if (!options?.tracer || typeof options.tracer.startSpan !== "function") {
    throw new ConfigurationError("OpenTelemetry integration requires a tracer.");
  }
  const instruments = new Map<string, OpenTelemetryCounterLike | OpenTelemetryHistogramLike>();
  return {
    startSpan(input) {
      const span = options.tracer.startSpan(input.name, {
        attributes: { ...input.attributes },
      });
      return {
        setAttributes(attributes) {
          span.setAttributes({ ...attributes });
        },
        setStatus(status, message) {
          span.setStatus({
            code: status === "ok" ? 1 : 2,
            ...(message === undefined ? {} : { message }),
          });
        },
        recordException(error) {
          span.recordException(error);
        },
        end() {
          span.end();
        },
      };
    },
    recordMetric(input) {
      if (!options.meter) return;
      const key = `${input.kind}:${input.name}:${input.unit ?? ""}`;
      let instrument = instruments.get(key);
      if (!instrument) {
        const instrumentOptions = {
          ...(input.unit === undefined ? {} : { unit: input.unit }),
          ...(input.description === undefined ? {} : { description: input.description }),
        };
        instrument = input.kind === "counter"
          ? options.meter.createCounter(input.name, instrumentOptions)
          : options.meter.createHistogram(input.name, instrumentOptions);
        instruments.set(key, instrument);
      }
      if (input.kind === "counter") {
        (instrument as OpenTelemetryCounterLike).add(input.value, { ...input.attributes });
      } else {
        (instrument as OpenTelemetryHistogramLike).record(input.value, { ...input.attributes });
      }
    },
  };
}

export function normalizeCostCurrency(value: string): string {
  const currency = value?.trim().toUpperCase();
  if (!currency || !/^[A-Z][A-Z0-9_-]{2,11}$/.test(currency)) {
    throw new ConfigurationError(
      "Cost currency must contain 3 to 12 uppercase letters, digits, underscores, or hyphens.",
    );
  }
  return currency;
}

export function normalizeCostAmount(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ConfigurationError("Calculated generation cost must be a non-negative safe integer.");
  }
  return value;
}
