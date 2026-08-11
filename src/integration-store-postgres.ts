import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import postgres from "postgres";
import { ConfigurationError, DatabaseNotReadyError, NotFoundError } from "./errors.js";
import type {
  CreateIntegrationAuthorizationSessionRecord,
  IntegrationAuthorizationSessionData,
  IntegrationConnectionStatus,
  IntegrationConnectionStore,
  SecretStore,
  SecretStorePutInput,
  StoredIntegrationConnection,
  UpdateIntegrationConnectionRecord,
  UpsertIntegrationConnectionRecord,
  UpsertIntegrationConnectionResult,
} from "./integration-store.js";
import type { IntegrationCategory } from "./integrations.js";
import type { JsonValue, UserScope } from "./types.js";
import { createId } from "./utils.js";

interface AuthorizationSessionRow {
  id: string;
  tenant_id: string;
  user_id: string;
  category: IntegrationCategory;
  integration_id: string;
  provider: string;
  state_hash: string;
  callback_url: string;
  return_to: string;
  scopes: string[];
  session_secret_ref: string | null;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

interface IntegrationConnectionRow {
  id: string;
  category: IntegrationCategory;
  integration_id: string;
  provider: string;
  external_account_id: string;
  external_account_name: string;
  external_account_url: string | null;
  external_account_metadata: Record<string, JsonValue>;
  secret_ref: string | null;
  status: IntegrationConnectionStatus;
  scopes: string[];
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface SecretRow {
  reference: string;
  purpose: SecretStorePutInput["purpose"];
  ciphertext: Uint8Array;
  initialization_vector: Uint8Array;
  authentication_tag: Uint8Array;
}

export interface PostgresIntegrationStoreOptions {
  /** Defaults to `process.env.DATABASE_URL`. */
  readonly databaseUrl?: string;
}

export interface EncryptedPostgresSecretStoreOptions extends PostgresIntegrationStoreOptions {
  /** A 32-byte key encoded as 64 hexadecimal characters or base64. Defaults to `VIBY_SECRET_KEY`. */
  readonly encryptionKey?: string | Uint8Array;
}

export class PostgresIntegrationConnectionStore implements IntegrationConnectionStore {
  readonly #sql: ReturnType<typeof postgres>;
  #ready = false;

  constructor(options: PostgresIntegrationStoreOptions = {}) {
    this.#sql = createSql(options.databaseUrl);
  }

  async createAuthorizationSession(
    scope: UserScope,
    input: CreateIntegrationAuthorizationSessionRecord,
  ): Promise<IntegrationAuthorizationSessionData> {
    await this.#assertReady();
    const [row] = await this.#sql<AuthorizationSessionRow[]>`
      INSERT INTO viby.integration_authorization_sessions (
        id, tenant_id, user_id, category, integration_id, provider, state_hash,
        callback_url, return_to, scopes, session_secret_ref, expires_at, created_at
      ) VALUES (
        ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.category},
        ${input.integrationId}, ${input.provider}, ${input.stateHash},
        ${input.callbackUrl}, ${input.returnTo}, ${this.#sql.array([...input.scopes])},
        ${input.sessionSecretRef}, ${input.expiresAt}, ${input.createdAt}
      )
      RETURNING *
    `;
    if (!row) throw new Error("Postgres did not return the authorization session.");
    return mapAuthorizationSession(row);
  }

  async consumeAuthorizationSession(
    stateHash: string,
    consumedAt: Date,
  ): Promise<{ readonly scope: UserScope; readonly session: IntegrationAuthorizationSessionData } | null> {
    await this.#assertReady();
    const [row] = await this.#sql<AuthorizationSessionRow[]>`
      UPDATE viby.integration_authorization_sessions
      SET consumed_at = ${consumedAt}
      WHERE state_hash = ${stateHash}
        AND consumed_at IS NULL
        AND expires_at > ${consumedAt}
      RETURNING *
    `;
    return row ? {
      scope: { tenantId: row.tenant_id, userId: row.user_id },
      session: mapAuthorizationSession(row),
    } : null;
  }

  async getAuthorizationSession(
    stateHash: string,
    now: Date,
  ): Promise<{ readonly scope: UserScope; readonly session: IntegrationAuthorizationSessionData } | null> {
    await this.#assertReady();
    const [row] = await this.#sql<AuthorizationSessionRow[]>`
      SELECT * FROM viby.integration_authorization_sessions
      WHERE state_hash = ${stateHash}
        AND consumed_at IS NULL
        AND expires_at > ${now}
      LIMIT 1
    `;
    return row ? {
      scope: { tenantId: row.tenant_id, userId: row.user_id },
      session: mapAuthorizationSession(row),
    } : null;
  }

  async listConnections(
    scope: UserScope,
    category?: IntegrationCategory,
    integrationId?: string,
  ): Promise<readonly StoredIntegrationConnection[]> {
    await this.#assertReady();
    const rows = await this.#sql<IntegrationConnectionRow[]>`
      SELECT * FROM viby.integration_connections
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND (${category ?? null}::text IS NULL OR category = ${category ?? null})
        AND (${integrationId ?? null}::text IS NULL OR integration_id = ${integrationId ?? null})
      ORDER BY updated_at DESC, id
    `;
    return rows.map(mapConnection);
  }

  async getConnection(scope: UserScope, id: string): Promise<StoredIntegrationConnection | null> {
    await this.#assertReady();
    const [row] = await this.#sql<IntegrationConnectionRow[]>`
      SELECT * FROM viby.integration_connections
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      LIMIT 1
    `;
    return row ? mapConnection(row) : null;
  }

  async upsertConnection(
    scope: UserScope,
    input: UpsertIntegrationConnectionRecord,
  ): Promise<UpsertIntegrationConnectionResult> {
    await this.#assertReady();
    return this.#sql.begin(async (sql) => {
      const [existing] = await sql<{ secret_ref: string | null }[]>`
        SELECT secret_ref FROM viby.integration_connections
        WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
          AND category = ${input.category} AND integration_id = ${input.integrationId}
          AND external_account_id = ${input.account.id}
        FOR UPDATE
      `;
      const [row] = await sql<IntegrationConnectionRow[]>`
        INSERT INTO viby.integration_connections (
          id, tenant_id, user_id, category, integration_id, provider,
          external_account_id, external_account_name, external_account_url,
          external_account_metadata, secret_ref, status, scopes, expires_at,
          created_at, updated_at
        ) VALUES (
          ${input.id}, ${scope.tenantId}, ${scope.userId}, ${input.category},
          ${input.integrationId}, ${input.provider}, ${input.account.id},
          ${input.account.name}, ${input.account.url ?? null},
          ${sql.json(JSON.parse(JSON.stringify(input.account.metadata ?? {})))},
          ${input.secretRef}, 'active', ${sql.array([...input.scopes])},
          ${input.expiresAt}, ${input.now}, ${input.now}
        )
        ON CONFLICT (
          tenant_id, user_id, category, integration_id, external_account_id
        ) DO UPDATE SET
          provider = EXCLUDED.provider,
          external_account_name = EXCLUDED.external_account_name,
          external_account_url = EXCLUDED.external_account_url,
          external_account_metadata = EXCLUDED.external_account_metadata,
          secret_ref = EXCLUDED.secret_ref,
          status = 'active',
          scopes = EXCLUDED.scopes,
          expires_at = EXCLUDED.expires_at,
          updated_at = EXCLUDED.updated_at
        RETURNING *
      `;
      if (!row) throw new Error("Postgres did not return the integration connection.");
      return {
        connection: mapConnection(row),
        replacedSecretRef: existing?.secret_ref ?? null,
      };
    });
  }

  async updateConnection(
    scope: UserScope,
    id: string,
    input: UpdateIntegrationConnectionRecord,
  ): Promise<StoredIntegrationConnection> {
    await this.#assertReady();
    const [row] = await this.#sql<IntegrationConnectionRow[]>`
      UPDATE viby.integration_connections SET
        status = ${input.status}, secret_ref = ${input.secretRef},
        scopes = ${this.#sql.array([...input.scopes])}, expires_at = ${input.expiresAt},
        updated_at = ${input.now}
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId} AND id = ${id}
      RETURNING *
    `;
    if (!row) throw new NotFoundError("Integration connection");
    return mapConnection(row);
  }

  async close(): Promise<void> {
    await this.#sql.end({ timeout: 5 });
  }

  async #assertReady(): Promise<void> {
    if (this.#ready) return;
    const [row] = await this.#sql<{ ready: boolean }[]>`
      SELECT
        to_regclass('viby.integration_connections') IS NOT NULL
        AND to_regclass('viby.integration_authorization_sessions') IS NOT NULL AS ready
    `;
    if (!row?.ready) throw new DatabaseNotReadyError();
    this.#ready = true;
  }
}

export class EncryptedPostgresSecretStore implements SecretStore {
  readonly #sql: ReturnType<typeof postgres>;
  readonly #key: Buffer;
  #ready = false;

  constructor(options: EncryptedPostgresSecretStoreOptions = {}) {
    this.#sql = createSql(options.databaseUrl);
    this.#key = decodeEncryptionKey(options.encryptionKey ?? process.env.VIBY_SECRET_KEY);
  }

  async put(scope: UserScope, input: SecretStorePutInput): Promise<string> {
    await this.#assertReady();
    if (!(input.bytes instanceof Uint8Array) || input.bytes.byteLength === 0 || input.bytes.byteLength > 64_000) {
      throw new ConfigurationError("Integration secrets must contain between 1 and 64,000 bytes.");
    }
    const reference = createId();
    const initializationVector = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#key, initializationVector);
    cipher.setAAD(secretAad(scope, reference, input.purpose));
    const ciphertext = Buffer.concat([cipher.update(input.bytes), cipher.final()]);
    const authenticationTag = cipher.getAuthTag();
    await this.#sql`
      INSERT INTO viby.integration_secrets (
        reference, tenant_id, user_id, purpose, ciphertext,
        initialization_vector, authentication_tag, expires_at, created_at
      ) VALUES (
        ${reference}, ${scope.tenantId}, ${scope.userId}, ${input.purpose},
        ${ciphertext}, ${initializationVector}, ${authenticationTag},
        ${input.expiresAt}, ${new Date()}
      )
    `;
    return reference;
  }

  async get(scope: UserScope, reference: string): Promise<Uint8Array | null> {
    await this.#assertReady();
    const [row] = await this.#sql<SecretRow[]>`
      SELECT reference, purpose, ciphertext, initialization_vector, authentication_tag
      FROM viby.integration_secrets
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND reference = ${reference}
        AND (expires_at IS NULL OR expires_at > now())
      LIMIT 1
    `;
    if (!row) return null;
    const decipher = createDecipheriv("aes-256-gcm", this.#key, row.initialization_vector);
    decipher.setAAD(secretAad(scope, row.reference, row.purpose));
    decipher.setAuthTag(Buffer.from(row.authentication_tag));
    return new Uint8Array(Buffer.concat([
      decipher.update(row.ciphertext),
      decipher.final(),
    ]));
  }

  async delete(scope: UserScope, reference: string): Promise<void> {
    await this.#assertReady();
    await this.#sql`
      DELETE FROM viby.integration_secrets
      WHERE tenant_id = ${scope.tenantId} AND user_id = ${scope.userId}
        AND reference = ${reference}
    `;
  }

  async close(): Promise<void> {
    this.#key.fill(0);
    await this.#sql.end({ timeout: 5 });
  }

  async #assertReady(): Promise<void> {
    if (this.#ready) return;
    const [row] = await this.#sql<{ ready: boolean }[]>`
      SELECT to_regclass('viby.integration_secrets') IS NOT NULL AS ready
    `;
    if (!row?.ready) throw new DatabaseNotReadyError();
    this.#ready = true;
  }
}

function createSql(databaseUrl = process.env.DATABASE_URL): ReturnType<typeof postgres> {
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new ConfigurationError("DATABASE_URL is required for PostgreSQL integration storage.");
  }
  return postgres(databaseUrl.trim(), {
    max: 5,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
}

function decodeEncryptionKey(value: string | Uint8Array | undefined): Buffer {
  if (value instanceof Uint8Array) {
    if (value.byteLength !== 32) {
      throw new ConfigurationError("The integration secret encryption key must contain exactly 32 bytes.");
    }
    return Buffer.from(value);
  }
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(
      "VIBY_SECRET_KEY is required when integrations use the default encrypted secret store.",
    );
  }
  const normalized = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(normalized)
    ? Buffer.from(normalized, "hex")
    : Buffer.from(normalized, "base64");
  if (key.byteLength !== 32) {
    throw new ConfigurationError(
      "VIBY_SECRET_KEY must be 32 bytes encoded as 64 hexadecimal characters or base64.",
    );
  }
  return key;
}

function secretAad(
  scope: UserScope,
  reference: string,
  purpose: SecretStorePutInput["purpose"],
): Buffer {
  return Buffer.from(`${scope.tenantId}\0${scope.userId}\0${reference}\0${purpose}`);
}

function mapAuthorizationSession(row: AuthorizationSessionRow): IntegrationAuthorizationSessionData {
  return {
    id: row.id,
    category: row.category,
    integrationId: row.integration_id,
    provider: row.provider,
    stateHash: row.state_hash,
    callbackUrl: row.callback_url,
    returnTo: row.return_to,
    scopes: Object.freeze([...row.scopes]),
    sessionSecretRef: row.session_secret_ref,
    expiresAt: row.expires_at,
    consumedAt: row.consumed_at,
    createdAt: row.created_at,
  };
}

function mapConnection(row: IntegrationConnectionRow): StoredIntegrationConnection {
  return {
    id: row.id,
    category: row.category,
    integrationId: row.integration_id,
    provider: row.provider,
    account: {
      id: row.external_account_id,
      name: row.external_account_name,
      ...(row.external_account_url ? { url: row.external_account_url } : {}),
      ...(Object.keys(row.external_account_metadata).length > 0
        ? { metadata: row.external_account_metadata }
        : {}),
    },
    secretRef: row.secret_ref,
    status: row.status,
    scopes: Object.freeze([...row.scopes]),
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
