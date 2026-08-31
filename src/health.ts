import type { Repository } from "./repository.js";
import { ConfigurationError } from "./errors.js";

export type VibyHealthStatus = "healthy" | "degraded" | "unhealthy";
export type VibyHealthCheckStatus = "pass" | "warning" | "fail" | "skipped";

export interface VibyHealthCheckData {
  readonly id: string;
  readonly label: string;
  readonly status: VibyHealthCheckStatus;
  /** Credential-free operator guidance. */
  readonly message: string;
  readonly durationMs: number;
}

export interface VibyHealthReport {
  readonly status: VibyHealthStatus;
  readonly ok: boolean;
  readonly checks: readonly VibyHealthCheckData[];
  readonly checkedAt: Date;
  readonly durationMs: number;
}

export interface VibyHealthProbeResult {
  readonly status: Exclude<VibyHealthCheckStatus, "skipped">;
  readonly message: string;
}

export interface VibyHealthProbe {
  readonly id: string;
  readonly label: string;
  /** Thrown probe errors fail readiness by default. Set false for optional dependencies. */
  readonly critical?: boolean;
  check(signal: AbortSignal): VibyHealthProbeResult | Promise<VibyHealthProbeResult>;
}

export interface VibyHealthConfig {
  /** Maximum time for each active readiness probe. Defaults to 5 seconds. */
  readonly timeoutMs?: number;
  /** Product-owned checks such as a queue or private model gateway. */
  readonly checks?: readonly VibyHealthProbe[];
}

export interface VibyHealthCheckOptions {
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export interface VibyHealth {
  check(options?: VibyHealthCheckOptions): Promise<VibyHealthReport>;
}

interface VibyHealthDependencies {
  readonly repository: Repository;
  readonly framework: string;
  readonly modelCount: number;
  readonly sandbox: boolean;
  readonly preview: boolean;
  readonly browser: boolean;
  readonly environment: boolean;
  readonly repositoryIntegrations: number;
  readonly deploymentIntegrations: number;
  readonly config?: VibyHealthConfig;
}

const DEFAULT_TIMEOUT_MS = 5_000;

export class VibyHealthService implements VibyHealth {
  readonly #dependencies: VibyHealthDependencies;

  constructor(dependencies: VibyHealthDependencies) {
    this.#dependencies = dependencies;
    validateHealthConfig(dependencies.config);
  }

  async check(options: VibyHealthCheckOptions = {}): Promise<VibyHealthReport> {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Viby health check options must be an object.");
    }
    const timeoutMs = normalizeTimeout(options.timeoutMs ?? this.#dependencies.config?.timeoutMs);
    options.signal?.throwIfAborted();
    const startedAt = Date.now();
    const checks = await Promise.all([
      runProbe({
        id: "database",
        label: "Structured database",
        critical: true,
        check: async () => {
          await this.#dependencies.repository.assertReady();
          return { status: "pass", message: "Persistence is reachable and its schema is ready." };
        },
      }, timeoutMs, options.signal),
      ...this.#configurationChecks(),
      ...(this.#dependencies.config?.checks ?? []).map((probe) =>
        runProbe(probe, timeoutMs, options.signal)
      ),
    ]);
    const status: VibyHealthStatus = checks.some((check) => check.status === "fail")
      ? "unhealthy"
      : checks.some((check) => check.status === "warning")
        ? "degraded"
        : "healthy";
    return Object.freeze({
      status,
      ok: status !== "unhealthy",
      checks: Object.freeze(checks),
      checkedAt: new Date(),
      durationMs: Date.now() - startedAt,
    });
  }

  #configurationChecks(): VibyHealthCheckData[] {
    const ready = (id: string, label: string, configured: boolean, message: string) => ({
      id,
      label,
      status: configured ? "pass" as const : "skipped" as const,
      message: configured ? message : `${label} is not configured.`,
      durationMs: 0,
    });
    return [
      {
        id: "generation",
        label: "Generation",
        status: "pass",
        message: `${this.#dependencies.modelCount} generation binding(s) are configured for ${this.#dependencies.framework}.`,
        durationMs: 0,
      },
      ready("sandbox", "Sandbox", this.#dependencies.sandbox, "A sandbox adapter is configured."),
      ready("preview", "Preview", this.#dependencies.preview, "A preview contract is configured."),
      ready("browser", "Browser", this.#dependencies.browser, "A browser adapter is configured."),
      ready(
        "environment",
        "Project environment",
        this.#dependencies.environment,
        "Project environment storage is configured.",
      ),
      ready(
        "repository-integrations",
        "Repository integrations",
        this.#dependencies.repositoryIntegrations > 0,
        `${this.#dependencies.repositoryIntegrations} repository integration(s) are configured.`,
      ),
      ready(
        "deployment-integrations",
        "Deployment integrations",
        this.#dependencies.deploymentIntegrations > 0,
        `${this.#dependencies.deploymentIntegrations} deployment integration(s) are configured.`,
      ),
    ];
  }
}

async function runProbe(
  probe: VibyHealthProbe,
  timeoutMs: number,
  parentSignal?: AbortSignal,
): Promise<VibyHealthCheckData> {
  validateProbe(probe);
  const startedAt = Date.now();
  const controller = new AbortController();
  const abort = () => controller.abort(parentSignal?.reason);
  parentSignal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => {
    controller.abort(new DOMException(`Health probe timed out after ${timeoutMs}ms.`, "TimeoutError"));
  }, timeoutMs);
  try {
    const result = await Promise.race([
      Promise.resolve().then(() => probe.check(controller.signal)),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener("abort", () => reject(controller.signal.reason), {
          once: true,
        });
      }),
    ]);
    if (!result || !["pass", "warning", "fail"].includes(result.status)) {
      throw new Error("Health probe returned an invalid result.");
    }
    return {
      id: probe.id,
      label: probe.label,
      status: result.status,
      message: normalizeProbeMessage(result.message),
      durationMs: Date.now() - startedAt,
    };
  } catch {
    if (parentSignal?.aborted) parentSignal.throwIfAborted();
    const reason = controller.signal.reason;
    return {
      id: probe.id,
      label: probe.label,
      status: probe.critical === false ? "warning" : "fail",
      message: reason instanceof DOMException && reason.name === "TimeoutError"
        ? `Probe timed out after ${timeoutMs}ms.`
        : "Probe is unavailable. Inspect the host logs for the underlying error.",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    clearTimeout(timer);
    parentSignal?.removeEventListener("abort", abort);
  }
}

function validateHealthConfig(config: VibyHealthConfig | undefined): void {
  if (config === undefined) return;
  if (!config || typeof config !== "object") {
    throw new ConfigurationError("health must be an object.");
  }
  normalizeTimeout(config.timeoutMs);
  const seen = new Set(["database", "generation", "sandbox", "preview", "browser", "environment", "repository-integrations", "deployment-integrations"]);
  for (const probe of config.checks ?? []) {
    validateProbe(probe);
    if (seen.has(probe.id)) {
      throw new ConfigurationError(`Health check id is duplicated: ${probe.id}`);
    }
    seen.add(probe.id);
  }
}

function validateProbe(probe: VibyHealthProbe): void {
  if (!probe || typeof probe !== "object") {
    throw new ConfigurationError("Health probe must be an object.");
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,99}$/.test(probe.id)) {
    throw new ConfigurationError("Health probe id must contain 1-100 lowercase letters, numbers, dots, underscores, or hyphens.");
  }
  if (typeof probe.label !== "string" || !probe.label.trim() || probe.label.length > 100) {
    throw new ConfigurationError("Health probe label must contain 1-100 characters.");
  }
  if (typeof probe.check !== "function") {
    throw new ConfigurationError(`Health probe ${probe.id} requires check().`);
  }
}

function normalizeTimeout(value: number | undefined): number {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(value) || value < 50 || value > 60_000) {
    throw new ConfigurationError("Health probe timeout must be an integer between 50 and 60000 milliseconds.");
  }
  return value;
}

function normalizeProbeMessage(value: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 500) {
    throw new Error("Health probe message must contain 1-500 characters.");
  }
  return value.trim();
}
