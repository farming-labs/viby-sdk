import { inspectMigrationStatus, type MigrationStatus } from "./migrations.js";
import type {
  VibyHealthCheckData,
  VibyHealthReport,
  VibyHealthStatus,
} from "./health.js";

export type VibyDoctorReport = VibyHealthReport;

export interface VibyDoctorOptions {
  /** Defaults to DATABASE_URL. The value is never included in the report. */
  readonly databaseUrl?: string;
  /** Defaults to VIBY_SECRET_KEY. The value is never included in the report. */
  readonly secretKey?: string;
  /** Testing and embedded-host override. Defaults to process.versions.node. */
  readonly nodeVersion?: string;
  /** Testing or custom migration-inspection hook. */
  readonly inspectMigrations?: (databaseUrl: string) => Promise<readonly MigrationStatus[]>;
}

/** Run credential-safe, read-only operator diagnostics for a Viby host. */
export async function runVibyDoctor(
  options: VibyDoctorOptions = {},
): Promise<VibyDoctorReport> {
  const startedAt = Date.now();
  const checks: VibyHealthCheckData[] = [];
  const nodeVersion = options.nodeVersion ?? process.versions.node;
  const nodeMajor = Number.parseInt(nodeVersion.split(".")[0] ?? "", 10);
  checks.push({
    id: "runtime",
    label: "Node.js runtime",
    status: Number.isInteger(nodeMajor) && nodeMajor >= 20 ? "pass" : "fail",
    message: Number.isInteger(nodeMajor) && nodeMajor >= 20
      ? `Node.js ${nodeVersion} satisfies the supported runtime range.`
      : "Viby requires Node.js 20 or newer.",
    durationMs: 0,
  });

  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (!databaseUrl) {
    checks.push({
      id: "database",
      label: "Structured database",
      status: "fail",
      message: "DATABASE_URL is not configured.",
      durationMs: 0,
    });
  } else {
    const migrationStartedAt = Date.now();
    try {
      const inspect = options.inspectMigrations ?? inspectMigrationStatus;
      const statuses = await inspect(databaseUrl);
      const pending = statuses.filter((status) => !status.applied);
      checks.push({
        id: "database",
        label: "Structured database",
        status: pending.length === 0 ? "pass" : "fail",
        message: pending.length === 0
          ? `Persistence is reachable and ${statuses.length} migration(s) are applied.`
          : `${pending.length} migration(s) are pending. Run \`npx viby db migrate\`.`,
        durationMs: Date.now() - migrationStartedAt,
      });
    } catch {
      checks.push({
        id: "database",
        label: "Structured database",
        status: "fail",
        message: "Persistence could not be inspected. Check host logs and database connectivity.",
        durationMs: Date.now() - migrationStartedAt,
      });
    }
  }

  const secretKey = options.secretKey ?? process.env.VIBY_SECRET_KEY;
  checks.push({
    id: "secret-key",
    label: "Secret encryption",
    status: secretKey ? "pass" : "warning",
    message: secretKey
      ? "VIBY_SECRET_KEY is configured for encrypted provider credentials."
      : "VIBY_SECRET_KEY is not configured. It is required when using encrypted default stores.",
    durationMs: 0,
  });

  const status = aggregateStatus(checks);
  return Object.freeze({
    status,
    ok: status !== "unhealthy",
    checks: Object.freeze(checks),
    checkedAt: new Date(),
    durationMs: Date.now() - startedAt,
  });
}

export function formatVibyDoctorReport(report: VibyDoctorReport): string {
  const marker = (check: VibyHealthCheckData) => {
    if (check.status === "pass") return "PASS";
    if (check.status === "warning") return "WARN";
    if (check.status === "skipped") return "SKIP";
    return "FAIL";
  };
  return [
    "Viby doctor",
    "",
    ...report.checks.map((check) => `${marker(check).padEnd(4)}  ${check.label}: ${check.message}`),
    "",
    `Result: ${report.status}`,
  ].join("\n");
}

function aggregateStatus(checks: readonly VibyHealthCheckData[]): VibyHealthStatus {
  if (checks.some((check) => check.status === "fail")) return "unhealthy";
  if (checks.some((check) => check.status === "warning")) return "degraded";
  return "healthy";
}
