import { ConfigurationError, NotFoundError } from "./errors.js";
import type { SecretStore } from "./integration-store.js";
import type { UserScope } from "./types.js";

export type EnvironmentName = "development" | "preview" | "production" | (string & {});

export interface EnvironmentVariableData {
  readonly id: string;
  readonly chatId: string;
  readonly environment: EnvironmentName;
  readonly name: string;
  /** Secret values are always null on public records. */
  readonly value: string | null;
  readonly secret: boolean;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SetEnvironmentVariableInput {
  readonly environment: EnvironmentName;
  readonly name: string;
  readonly value: string;
  readonly secret?: boolean;
}

export interface ListEnvironmentVariablesInput {
  readonly environment?: EnvironmentName;
}

export interface DeleteEnvironmentVariableInput {
  readonly environment: EnvironmentName;
  readonly name: string;
}

export interface StoredEnvironmentVariable extends EnvironmentVariableData {
  readonly secretRef: string | null;
}

export interface UpsertEnvironmentVariableRecord {
  readonly id: string;
  readonly chatId: string;
  readonly environment: EnvironmentName;
  readonly name: string;
  readonly value: string | null;
  readonly secret: boolean;
  readonly secretRef: string | null;
  readonly now: Date;
}

export interface UpsertEnvironmentVariableResult {
  readonly variable: StoredEnvironmentVariable;
  readonly replacedSecretRef: string | null;
}

export interface DeletedEnvironmentVariable {
  readonly deleted: boolean;
  readonly secretRef: string | null;
}

/** Durable metadata boundary. Secret bytes remain in the independently configured SecretStore. */
export interface EnvironmentVariableStore {
  list(
    scope: UserScope,
    chatId: string,
    environment?: EnvironmentName,
  ): Promise<readonly StoredEnvironmentVariable[]>;
  upsert(
    scope: UserScope,
    input: UpsertEnvironmentVariableRecord,
  ): Promise<UpsertEnvironmentVariableResult>;
  delete(
    scope: UserScope,
    chatId: string,
    environment: EnvironmentName,
    name: string,
  ): Promise<DeletedEnvironmentVariable>;
  close(): Promise<void>;
}

export interface EnvironmentConfig {
  /** Omit to use the PostgreSQL implementation with DATABASE_URL. */
  readonly store?: EnvironmentVariableStore;
}

export interface EnvironmentVariableCollection {
  set(input: SetEnvironmentVariableInput): Promise<EnvironmentVariableData>;
  list(input?: ListEnvironmentVariablesInput): Promise<readonly EnvironmentVariableData[]>;
  delete(input: DeleteEnvironmentVariableInput): Promise<boolean>;
}

export class EnvironmentManager {
  readonly #store: EnvironmentVariableStore;
  readonly #secrets: SecretStore;

  constructor(store: EnvironmentVariableStore, secrets: SecretStore) {
    if (!isEnvironmentVariableStore(store)) {
      throw new ConfigurationError("A valid environment variable store is required.");
    }
    if (
      !secrets
      || typeof secrets.put !== "function"
      || typeof secrets.get !== "function"
      || typeof secrets.delete !== "function"
      || typeof secrets.close !== "function"
    ) {
      throw new ConfigurationError("A secret store is required for environment variables.");
    }
    this.#store = store;
    this.#secrets = secrets;
  }

  forChat(scope: UserScope, chatId: string): EnvironmentVariableCollection {
    return {
      set: (input) => this.set(scope, chatId, input),
      list: (input = {}) => this.list(scope, chatId, input),
      delete: (input) => this.delete(scope, chatId, input),
    };
  }

  async set(
    scope: UserScope,
    chatId: string,
    input: SetEnvironmentVariableInput,
  ): Promise<EnvironmentVariableData> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Environment variable input is required.");
    }
    const environment = normalizeEnvironmentName(input.environment);
    const name = normalizeEnvironmentVariableName(input.name);
    const value = normalizeEnvironmentVariableValue(input.value);
    const secret = input.secret === true;
    const secretRef = secret
      ? await this.#secrets.put(scope, {
          bytes: new TextEncoder().encode(value),
          purpose: "environment-variable",
          expiresAt: null,
        })
      : null;
    let result: UpsertEnvironmentVariableResult;
    try {
      result = await this.#store.upsert(scope, {
        id: crypto.randomUUID(),
        chatId,
        environment,
        name,
        value: secret ? null : value,
        secret,
        secretRef,
        now: new Date(),
      });
    } catch (error) {
      if (secretRef) await this.#secrets.delete(scope, secretRef).catch(() => undefined);
      throw error;
    }
    if (result.replacedSecretRef && result.replacedSecretRef !== secretRef) {
      await this.#secrets.delete(scope, result.replacedSecretRef).catch(() => undefined);
    }
    return publicVariable(result.variable);
  }

  async list(
    scope: UserScope,
    chatId: string,
    input: ListEnvironmentVariablesInput = {},
  ): Promise<readonly EnvironmentVariableData[]> {
    const environment = input.environment === undefined
      ? undefined
      : normalizeEnvironmentName(input.environment);
    return (await this.#store.list(scope, chatId, environment)).map(publicVariable);
  }

  async delete(
    scope: UserScope,
    chatId: string,
    input: DeleteEnvironmentVariableInput,
  ): Promise<boolean> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Environment variable delete input is required.");
    }
    const deleted = await this.#store.delete(
      scope,
      chatId,
      normalizeEnvironmentName(input.environment),
      normalizeEnvironmentVariableName(input.name),
    );
    if (deleted.secretRef) await this.#secrets.delete(scope, deleted.secretRef);
    return deleted.deleted;
  }

  async resolve(
    scope: UserScope,
    chatId: string,
    environment: EnvironmentName,
  ): Promise<Readonly<Record<string, string>>> {
    const records = await this.#store.list(scope, chatId, normalizeEnvironmentName(environment));
    const entries = await Promise.all(records.map(async (record): Promise<readonly [string, string]> => {
      if (!record.secret) return [record.name, record.value ?? ""];
      if (!record.secretRef) throw new ConfigurationError(`Secret ${record.name} has no secret reference.`);
      const bytes = await this.#secrets.get(scope, record.secretRef);
      if (!bytes) throw new NotFoundError(`Environment secret ${record.name}`);
      return [record.name, new TextDecoder("utf-8", { fatal: true }).decode(bytes)];
    }));
    return Object.freeze(Object.fromEntries(entries));
  }

  close(): Promise<void> {
    return this.#store.close();
  }
}

export function isEnvironmentVariableStore(value: unknown): value is EnvironmentVariableStore {
  return Boolean(
    value
    && typeof value === "object"
    && "list" in value && typeof value.list === "function"
    && "upsert" in value && typeof value.upsert === "function"
    && "delete" in value && typeof value.delete === "function"
    && "close" in value && typeof value.close === "function",
  );
}

export function normalizeEnvironmentName(value: string): EnvironmentName {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(normalized)) {
    throw new ConfigurationError(
      "Environment must contain 1-100 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return normalized;
}

export function normalizeEnvironmentVariableName(value: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(normalized)) {
    throw new ConfigurationError(
      "Environment variable name must start with a letter or underscore and contain at most 128 letters, numbers, or underscores.",
    );
  }
  return normalized;
}

function normalizeEnvironmentVariableValue(value: string): string {
  if (typeof value !== "string" || value.length > 64_000 || value.includes("\0")) {
    throw new ConfigurationError("Environment variable value must be a string up to 64,000 characters.");
  }
  return value;
}

function publicVariable(value: StoredEnvironmentVariable): EnvironmentVariableData {
  return Object.freeze({
    id: value.id,
    chatId: value.chatId,
    environment: value.environment,
    name: value.name,
    value: value.secret ? null : value.value,
    secret: value.secret,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  });
}
