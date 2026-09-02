import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import postgres from "postgres";
import { getMigrationStatus, migrateDatabase } from "../src/migrations.js";
import { PostgresRepository } from "../src/postgres-repository.js";

const adminUrl = process.env.SCHEMA_UPGRADE_ADMIN_URL;

test(
  "upgrades a historical v0.2 schema without losing tenant data",
  {
    skip: adminUrl ? false : "SCHEMA_UPGRADE_ADMIN_URL is not configured",
    timeout: 60_000,
  },
  async () => {
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
        const migration = await readFile(
          join(process.cwd(), "migrations", `${version}.sql`),
          "utf8",
        );
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
        "0018_artifact_storage",
        "0019_generated_artifacts",
        "0020_visual_artifacts",
        "0021_project_artifacts",
        "0022_integration_connections",
        "0023_repository_push_history",
        "0024_deployment_history",
        "0025_deployment_artifacts",
        "0026_message_finish_reasons",
        "0027_provider_neutral_skill_sources",
        "0028_environment_variables",
        "0029_preview_sessions",
        "0030_tool_source_registry",
        "0031_tool_source_authorization",
        "0032_generation_quality_events",
        "0033_generation_steering",
        "0034_generation_workspace_events",
        "0035_generation_engine_checkpoints",
        "0036_message_feedback",
        "0037_provider_request_attribution",
        "0038_feedback_analytics",
        "0039_follow_up_prompt_queue",
        "0040_durable_webhooks",
        "0041_webhook_worker_discovery",
      ]);
      assert.equal(
        (await getMigrationStatus(databaseUrl.toString())).every((entry) => entry.applied),
        true,
      );
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
        const [row] = await inspection<
          {
            deliveries: string | null;
            costColumn: boolean;
            lockedColumn: boolean;
            configurationColumn: boolean;
            attachments: string | null;
            designEvaluations: string | null;
            artifactKeyColumn: boolean;
            generatedArtifacts: string | null;
            visualArtifacts: string | null;
            projectArtifacts: string | null;
            projectArtifactColumn: boolean;
            integrationConnections: string | null;
            integrationSecrets: string | null;
            messageFinishReasonColumn: boolean;
            environmentVariables: string | null;
            toolSourceConnections: string | null;
            toolSourceAuthorizationSessions: string | null;
          }[]
        >`
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
          to_regclass('viby.design_evaluations')::text AS "designEvaluations",
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'viby' AND table_name = 'attachments'
              AND column_name = 'artifact_key'
          ) AS "artifactKeyColumn",
          to_regclass('viby.generated_artifacts')::text AS "generatedArtifacts",
          to_regclass('viby.visual_artifacts')::text AS "visualArtifacts",
          to_regclass('viby.project_artifacts')::text AS "projectArtifacts",
          to_regclass('viby.integration_connections')::text AS "integrationConnections",
          to_regclass('viby.integration_secrets')::text AS "integrationSecrets",
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'viby' AND table_name = 'messages'
              AND column_name = 'finish_reason'
          ) AS "messageFinishReasonColumn",
          to_regclass('viby.environment_variables')::text AS "environmentVariables",
          to_regclass('viby.tool_source_connections')::text AS "toolSourceConnections",
          to_regclass('viby.tool_source_authorization_sessions')::text
            AS "toolSourceAuthorizationSessions",
          EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'viby' AND table_name = 'version_files'
              AND column_name = 'artifact_id'
          ) AS "projectArtifactColumn"
      `;
        assert.equal(row?.deliveries, "viby.outbound_event_deliveries");
        assert.equal(row?.costColumn, true);
        assert.equal(row?.lockedColumn, true);
        assert.equal(row?.configurationColumn, true);
        assert.equal(row?.attachments, "viby.attachments");
        assert.equal(row?.designEvaluations, "viby.design_evaluations");
        assert.equal(row?.artifactKeyColumn, true);
        assert.equal(row?.generatedArtifacts, "viby.generated_artifacts");
        assert.equal(row?.visualArtifacts, "viby.visual_artifacts");
        assert.equal(row?.projectArtifacts, "viby.project_artifacts");
        assert.equal(row?.projectArtifactColumn, true);
        assert.equal(row?.integrationConnections, "viby.integration_connections");
        assert.equal(row?.integrationSecrets, "viby.integration_secrets");
        assert.equal(row?.messageFinishReasonColumn, true);
        assert.equal(row?.environmentVariables, "viby.environment_variables");
        assert.equal(row?.toolSourceConnections, "viby.tool_source_connections");
        assert.equal(
          row?.toolSourceAuthorizationSessions,
          "viby.tool_source_authorization_sessions",
        );
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
  },
);

test(
  "webhook worker migration preserves historical events and installs discovery index",
  {
    skip: adminUrl ? false : "SCHEMA_UPGRADE_ADMIN_URL is not configured",
    timeout: 60_000,
  },
  async () => {
    assert.ok(adminUrl);
    const databaseName = `viby_webhook_upgrade_${randomUUID().replaceAll("-", "")}`;
    assert.match(databaseName, /^viby_webhook_upgrade_[a-f0-9]{32}$/);
    const admin = postgres(adminUrl, { max: 1, onnotice: () => undefined });
    const databaseUrl = new URL(adminUrl);
    databaseUrl.pathname = `/${databaseName}`;
    let fixture: ReturnType<typeof postgres> | undefined;

    try {
      await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
      fixture = postgres(databaseUrl.toString(), { max: 1, onnotice: () => undefined });
      await fixture.unsafe(`
        CREATE SCHEMA viby;
        CREATE TABLE viby.webhooks (
          id uuid PRIMARY KEY,
          tenant_id text NOT NULL,
          user_id text NOT NULL,
          created_at timestamptz NOT NULL
        );
        CREATE TABLE viby.generation_events (
          cursor bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
          tenant_id text NOT NULL,
          user_id text NOT NULL,
          generation_id uuid NOT NULL,
          created_at timestamptz NOT NULL
        );
      `);
      const webhookId = randomUUID();
      const generationId = randomUUID();
      const webhookCreatedAt = new Date("2026-08-01T12:00:00.000Z");
      await fixture`
        INSERT INTO viby.webhooks (id, tenant_id, user_id, created_at)
        VALUES (${webhookId}, 'tenant', 'user', ${webhookCreatedAt})
      `;
      await fixture`
        INSERT INTO viby.generation_events (
          tenant_id, user_id, generation_id, created_at
        ) VALUES (
          'tenant', 'user', ${generationId}, ${new Date("2026-08-01T11:59:00.000Z")}
        )
      `;

      const migration = await readFile(
        join(process.cwd(), "migrations", "0041_webhook_worker_discovery.sql"),
        "utf8",
      );
      await fixture.unsafe(migration);
      const [webhook] = await fixture<{
        delivery_start_cursor: string | number | bigint;
      }[]>`
        SELECT delivery_start_cursor
        FROM viby.webhooks
        WHERE id = ${webhookId}
      `;
      const [index] = await fixture<{ indexdef: string }[]>`
        SELECT indexdef
        FROM pg_indexes
        WHERE schemaname = 'viby'
          AND indexname = 'generation_events_webhook_discovery_idx'
      `;
      assert.equal(String(webhook?.delivery_start_cursor), "0");
      assert.match(
        index?.indexdef ?? "",
        /\(tenant_id, user_id, cursor, generation_id\)/,
      );
    } finally {
      await fixture?.end({ timeout: 5 }).catch(() => undefined);
      await admin`
        SELECT pg_terminate_backend(pid)
        FROM pg_stat_activity
        WHERE datname = ${databaseName} AND pid <> pg_backend_pid()
      `.catch(() => undefined);
      await admin.unsafe(`DROP DATABASE IF EXISTS "${databaseName}"`).catch(() => undefined);
      await admin.end({ timeout: 5 });
    }
  },
);
