import assert from "node:assert/strict";
import { test } from "node:test";
import { formatVibyDoctorReport, runVibyDoctor } from "../src/doctor.js";

test("reports a ready host without exposing credentials", async () => {
  const report = await runVibyDoctor({
    databaseUrl: "postgresql://operator:secret@example.test/viby",
    secretKey: "also-secret",
    nodeVersion: "24.1.0",
    inspectMigrations: async () => [
      { version: "0001_initial", applied: true },
      { version: "0002_more", applied: true },
    ],
  });

  assert.equal(report.status, "healthy");
  assert.equal(report.ok, true);
  assert.doesNotMatch(JSON.stringify(report), /operator:|also-secret|example\.test/);
  assert.match(formatVibyDoctorReport(report), /Result: healthy/);
});

test("reports pending migrations as an actionable failure", async () => {
  const report = await runVibyDoctor({
    databaseUrl: "postgresql://ignored",
    secretKey: "configured",
    nodeVersion: "20.0.0",
    inspectMigrations: async () => [
      { version: "0001_initial", applied: true },
      { version: "0002_more", applied: false },
    ],
  });

  assert.equal(report.status, "unhealthy");
  assert.match(report.checks.find((check) => check.id === "database")?.message ?? "", /viby db migrate/);
});

test("reports missing configuration and redacts inspection failures", async () => {
  const missing = await runVibyDoctor({
    databaseUrl: "",
    secretKey: "",
    nodeVersion: "18.19.0",
  });
  assert.equal(missing.status, "unhealthy");
  assert.equal(missing.checks.find((check) => check.id === "secret-key")?.status, "warning");

  const failed = await runVibyDoctor({
    databaseUrl: "postgresql://operator:secret@example.test/viby",
    secretKey: "configured",
    nodeVersion: "22.0.0",
    inspectMigrations: async () => {
      throw new Error("postgresql://operator:secret@example.test/viby");
    },
  });
  assert.equal(failed.status, "unhealthy");
  assert.doesNotMatch(JSON.stringify(failed), /operator:secret|example\.test/);
});
