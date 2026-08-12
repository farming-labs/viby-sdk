import postgres from "postgres";
import type {
  DeletedEnvironmentVariable,
  EnvironmentName,
  EnvironmentVariableStore,
  StoredEnvironmentVariable,
  UpsertEnvironmentVariableRecord,
  UpsertEnvironmentVariableResult,
} from "./environment.js";
import { ConfigurationError, DatabaseNotReadyError, NotFoundError } from "./errors.js";
import type { UserScope } from "./types.js";

interface EnvironmentVariableRow {
  id: string;
  chat_id: string;
  environment: EnvironmentName;
  name: string;
  plain_value: string | null;
  secret: boolean;
  secret_ref: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface PostgresEnvironmentVariableStoreOptions {
  /** Defaults to `process.env.DATABASE_URL`. */
  readonly databaseUrl?: string;
}

export class PostgresEnvironmentVariableStore implements EnvironmentVariableStore {
  readonly #sql: ReturnType<typeof postgres>;
  #ready = false;

  constructor(options: PostgresEnvironmentVariableStoreOptions = {}) {
    const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
    if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
      throw new ConfigurationError("DATABASE_URL is required for PostgreSQL environment storage.");
    }
    this.#sql = postgres(databaseUrl.trim(), {
      max: 5,
      idle_timeout: 20,
      connect_timeout: 10,
      onnotice: () => undefined,
    });
  }

  async list(
    scope: UserScope,
    chatId: string,
    environment?: EnvironmentName,
  ): Promise<readonly StoredEnvironmentVariable[]> {
    await this.#assertReady();
    const rows = await this.#sql<EnvironmentVariableRow[]>`
      SELECT variable.* FROM viby.environment_variables AS variable
      JOIN viby.chats AS chat ON chat.id = variable.chat_id
      WHERE variable.tenant_id = ${scope.tenantId} AND variable.user_id = ${scope.userId}
        AND variable.chat_id = ${chatId} AND chat.deleted_at IS NULL
        AND (${environment ?? null}::text IS NULL OR variable.environment = ${environment ?? null})
      ORDER BY variable.environment, variable.name
    `;
    return rows.map(mapEnvironmentVariable);
  }

  async upsert(
    scope: UserScope,
    input: UpsertEnvironmentVariableRecord,
  ): Promise<UpsertEnvironmentVariableResult> {
    await this.#assertReady();
    return this.#sql.begin(async (sql) => {
      const [chat] = await sql<{ id: string }[]>`
        SELECT id FROM viby.chats
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND id = ${input.chatId} AND deleted_at IS NULL
        FOR UPDATE
      `;
      if (!chat) throw new NotFoundError("Chat");
      const [existing] = await sql<{ secret_ref: string | null }[]>`
        SELECT secret_ref FROM viby.environment_variables
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND chat_id = ${input.chatId} AND environment = ${input.environment}
          AND name = ${input.name}
        FOR UPDATE
      `;
      const [row] = await sql<EnvironmentVariableRow[]>`
        INSERT INTO viby.environment_variables (
          id, tenant_id, user_id, chat_id, environment, name,
          plain_value, secret, secret_ref, created_at, updated_at
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.chatId},
          ${input.environment}, ${input.name}, ${input.value}, ${input.secret},
          ${input.secretRef}, ${input.now}, ${input.now}
        )
        ON CONFLICT (tenant_id, user_id, chat_id, environment, name)
        DO UPDATE SET
          plain_value = EXCLUDED.plain_value,
          secret = EXCLUDED.secret,
          secret_ref = EXCLUDED.secret_ref,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      if (!row) throw new Error("Postgres did not return the environment variable.");
      return {
        variable: mapEnvironmentVariable(row),
        replacedSecretRef: existing?.secret_ref ?? null,
      };
    });
  }

  async delete(
    scope: UserScope,
    chatId: string,
    environment: EnvironmentName,
    name: string,
  ): Promise<DeletedEnvironmentVariable> {
    await this.#assertReady();
    const [row] = await this.#sql<{ secret_ref: string | null }[]>`
      DELETE FROM viby.environment_variables AS variable
      USING viby.chats AS chat
      WHERE variable.tenant_id = ${scope.tenantId} AND variable.user_id = ${scope.userId}
        AND variable.chat_id = ${chatId} AND variable.environment = ${environment}
        AND variable.name = ${name} AND chat.id = variable.chat_id
        AND chat.tenant_id = ${scope.tenantId} AND chat.user_id = ${scope.userId}
        AND chat.deleted_at IS NULL
      RETURNING variable.secret_ref
    `;
    return { deleted: Boolean(row), secretRef: row?.secret_ref ?? null };
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #assertReady(): Promise<void> {
    if (this.#ready) return;
    const [row] = await this.#sql<{ ready: boolean }[]>`
      SELECT to_regclass('viby.environment_variables') IS NOT NULL AS ready
    `;
    if (!row?.ready) throw new DatabaseNotReadyError();
    this.#ready = true;
  }
}

export function postgresEnvironmentVariables(
  options: PostgresEnvironmentVariableStoreOptions = {},
): PostgresEnvironmentVariableStore {
  return new PostgresEnvironmentVariableStore(options);
}

function mapEnvironmentVariable(row: EnvironmentVariableRow): StoredEnvironmentVariable {
  return {
    id: row.id,
    chatId: row.chat_id,
    environment: row.environment,
    name: row.name,
    value: row.secret ? null : row.plain_value,
    secret: row.secret,
    secretRef: row.secret_ref,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
