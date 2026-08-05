import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import postgres from "postgres";
import { ConfigurationError } from "./errors.js";

export interface MigrationStatus {
  readonly version: string;
  readonly applied: boolean;
}

export async function migrateDatabase(databaseUrl = process.env.DATABASE_URL): Promise<string[]> {
  if (!databaseUrl) {
    throw new ConfigurationError("DATABASE_URL is required to run Viby migrations.");
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  const appliedNow: string[] = [];

  try {
    await sql`SELECT pg_advisory_lock(hashtext('viby:migrations'))`;
    await ensureMigrationTable(sql);
    const migrations = await readMigrations();
    const appliedRows = await sql<{ version: string }[]>`
      SELECT version FROM viby.schema_migrations
    `;
    const applied = new Set(appliedRows.map((row) => row.version));

    for (const migration of migrations) {
      if (applied.has(migration.version)) continue;
      await sql.begin(async (transaction) => {
        await transaction.unsafe(migration.sql);
        await transaction`
          INSERT INTO viby.schema_migrations (version) VALUES (${migration.version})
        `;
      });
      appliedNow.push(migration.version);
    }
  } finally {
    await sql`SELECT pg_advisory_unlock(hashtext('viby:migrations'))`.catch(() => undefined);
    await sql.end({ timeout: 5 });
  }

  return appliedNow;
}

export async function getMigrationStatus(
  databaseUrl = process.env.DATABASE_URL,
): Promise<MigrationStatus[]> {
  if (!databaseUrl) {
    throw new ConfigurationError("DATABASE_URL is required to inspect Viby migrations.");
  }
  const sql = postgres(databaseUrl, { max: 1, onnotice: () => undefined });
  try {
    await ensureMigrationTable(sql);
    const migrations = await readMigrations();
    const appliedRows = await sql<{ version: string }[]>`
      SELECT version FROM viby.schema_migrations
    `;
    const applied = new Set(appliedRows.map((row) => row.version));
    return migrations.map((migration) => ({
      version: migration.version,
      applied: applied.has(migration.version),
    }));
  } finally {
    await sql.end({ timeout: 5 });
  }
}

async function ensureMigrationTable(sql: ReturnType<typeof postgres>): Promise<void> {
  await sql`CREATE SCHEMA IF NOT EXISTS viby`;
  await sql`
    CREATE TABLE IF NOT EXISTS viby.schema_migrations (
      version text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;
}

async function readMigrations(): Promise<Array<{ version: string; sql: string }>> {
  const directory = fileURLToPath(new URL("../migrations", import.meta.url));
  const names = (await readdir(directory))
    .filter((name) => /^\d+_[a-z0-9_-]+\.sql$/.test(name))
    .sort();
  return Promise.all(
    names.map(async (name) => ({
      version: name.replace(/\.sql$/, ""),
      sql: await readFile(join(directory, name), "utf8"),
    })),
  );
}
