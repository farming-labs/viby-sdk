#!/usr/bin/env node
import { getMigrationStatus, migrateDatabase } from "./migrations.js";
import { formatVibyDoctorReport, runVibyDoctor } from "./doctor.js";
import { errorMessage } from "./utils.js";

async function main(): Promise<void> {
  const [, , group, command] = process.argv;

  if (group === "doctor") {
    const report = await runVibyDoctor();
    if (process.argv.includes("--json")) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      console.log(formatVibyDoctorReport(report));
    }
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (group === "db" && command === "migrate") {
    const applied = await migrateDatabase();
    if (applied.length === 0) {
      console.log("Viby database is already up to date.");
    } else {
      for (const version of applied) console.log(`Applied ${version}`);
    }
    return;
  }

  if (group === "db" && command === "status") {
    const statuses = await getMigrationStatus();
    for (const status of statuses) {
      console.log(`${status.applied ? "applied" : "pending"}  ${status.version}`);
    }
    return;
  }

  console.log(`Viby SDK

Usage:
  viby doctor       Inspect runtime, database migrations, and secret configuration
  viby doctor --json  Print machine-readable diagnostics
  viby db migrate   Apply pending Viby database migrations
  viby db status    Show the state of Viby database migrations`);
}

main().catch((error: unknown) => {
  console.error(`viby: ${errorMessage(error)}`);
  process.exitCode = 1;
});
