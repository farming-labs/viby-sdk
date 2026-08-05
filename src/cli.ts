#!/usr/bin/env node
import { getMigrationStatus, migrateDatabase } from "./migrations.js";
import { errorMessage } from "./utils.js";

async function main(): Promise<void> {
  const [, , group, command] = process.argv;

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
  viby db migrate   Apply pending Viby database migrations
  viby db status    Show the state of Viby database migrations`);
}

main().catch((error: unknown) => {
  console.error(`viby: ${errorMessage(error)}`);
  process.exitCode = 1;
});
