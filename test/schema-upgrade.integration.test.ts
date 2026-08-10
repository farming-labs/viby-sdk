import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import postgres from "postgres";
import { getMigrationStatus, migrateDatabase } from "../src/migrations.js";
import { PostgresRepository } from "../src/postgres-repository.js";

const adminUrl = process.env.SCHEMA_UPGRADE_ADMIN_URL;

test("upgrades a historical v0.2 schema without losing tenant data", {
  skip: adminUrl ? false : "SCHEMA_UPGRADE_ADMIN_URL is not configured",
  timeout: 60_000,
}, async () => {
  assert.ok(adminUrl);
  const databaseName = `viby_upgrade_${randomUUID().replaceAll("-", "")}`;
  assert.match(databaseName, /^viby_upgrade_[a-f0-9]{32}$/);

  const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const scope = { tenantId: "fixture-tenant", userId: "fixture-user" };
  const chatId = randomUUID();
  let fixture: ReturnType<typeof postgres> | undefined;
  let repository: PostgresRepository | undefined;

  try {
    await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
    fixture = postgres(databaseUrl.toString(), { max: 1, onnotice: () => undefined });

    for (const version of [
      "0001_initial",
      "0002_durable_generations",
      "0003_source_versions",
      "0004_chat_metadata",
    ]) {
      const migration = await readFile(join(process.cwd(), "migrations", `${version}.sql`), "utf8");
      await fixture.unsafe(migration);
    }
    await fixture`
      CREATE TABLE viby.schema_migrations (
        version text PRIMARY KEY,
        applied_at timestamptz NOT NULL DEFAULT now()
      )
    `;
    for (const version of [
      "0001_initial",
      "0002_durable_generations",
      "0003_source_versions",
      "0004_chat_metadata",
    ]) {
      await fixture`INSERT INTO viby.schema_migrations (version) VALUES (${version})`;
    }
    await fixture`
      INSERT INTO viby.chats (id, tenant_id, user_id, title, framework, metadata)
      VALUES (
        ${chatId}, ${scope.tenantId}, ${scope.userId},
        'Historical project', 'farm', ${fixture.json({ release: "0.2" })}
      )
    `;
    await fixture.end({ timeout: 5 });
    fixture = undefined;

    assert.deepEqual(await migrateDatabase(databaseUrl.toString()), [
      "0005_sandbox_leases",
      "0006_generation_worker_leases",
      "0007_version_changes",
      "0008_message_parts",
      "0009_agent_trace_events",
      "0010_tool_calls",
      "0011_locked_files",
      "0012_chat_retention",
      "0013_generation_costs",
      "0014_outbound_event_deliveries",
      "0015_generation_configuration",
      "0016_attachments",
      "0017_design_evaluations",
    ]);
    assert.equal((await getMigrationStatus(databaseUrl.toString())).every((entry) => entry.applied), true);
    assert.deepEqual(await migrateDatabase(databaseUrl.toString()), []);

    repository = new PostgresRepository(databaseUrl.toString());
    await repository.assertReady();
    const chat = await repository.getChat<"farm">(scope, chatId);
    assert.ok(chat);
    assert.equal(chat.title, "Historical project");
    assert.equal(chat.framework, "farm");
    assert.deepEqual(chat.metadata, { release: "0.2" });

    const inspection = postgres(databaseUrl.toString(), { max: 1, onnotice: () => undefined });
    try {
      const [row] = await inspection<{
        deliveries: string | null;
        costColumn: boolean;
        lockedColumn: boolean;
        configurationColumn: boolean;
        attachments: string | null;
        designEvaluations: string | null;
      }[]>`
        SELECT
          to_regclass('viby.outbound_event_deliveries')::text AS deliveries,
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'viby' AND table_name = 'generations'
              AND column_name = 'estimated_cost_micros'
          ) AS "costColumn",
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'viby' AND table_name = 'version_files'
              AND column_name = 'locked'
          ) AS "lockedColumn",
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'viby' AND table_name = 'generations'
              AND column_name = 'configuration'
          ) AS "configurationColumn",
          to_regclass('viby.attachments')::text AS attachments,
          to_regclass('viby.design_evaluations')::text AS "designEvaluations"
      `;
      assert.equal(row?.deliveries, "viby.outbound_event_deliveries");
      assert.equal(row?.costColumn, true);
      assert.equal(row?.lockedColumn, true);
      assert.equal(row?.configurationColumn, true);
      assert.equal(row?.attachments, "viby.attachments");
      assert.equal(row?.designEvaluations, "viby.design_evaluations");
    } finally {
      await inspection.end({ timeout: 5 });
    }
  } finally {
    await repository?.close().catch(() => undefined);
    await fixture?.end({ timeout: 5 }).catch(() => undefined);
    await admin`
      SELECT pg_terminate_backend(pid)
      FROM pg_stat_activity
      WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
    `.catch(() => undefined);
    await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
    await admin.end({ timeout: 5 });
  }
});
