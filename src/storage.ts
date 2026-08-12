import type { ArtifactStore } from "./artifact-store.js";
import { ConfigurationError } from "./errors.js";
import type { IntegrationConnectionStore, SecretStore } from "./integration-store.js";
import type { PersistenceAdapter } from "./persistence.js";

/** Runtime dependencies supplied when opening a structured Viby database adapter. */
export interface DatabaseAdapterContext {
  readonly artifacts?: ArtifactStore;
}

/**
 * Provider-neutral structured-data factory.
 *
 * The factory boundary lets Viby connect one independently configured artifact
 * store to databases that persist artifact references and ownership metadata.
 */
export interface DatabaseAdapter {
  readonly id: string;
  open(context: DatabaseAdapterContext): PersistenceAdapter;
}

export interface DefineDatabaseAdapterInput {
  readonly id: string;
  readonly open: (context: DatabaseAdapterContext) => PersistenceAdapter;
}

/** Defines a custom structured database implementation without prescribing its technology. */
export function defineDatabaseAdapter(input: DefineDatabaseAdapterInput): DatabaseAdapter {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Database adapter configuration is required.");
  }
  const id = normalizeDatabaseAdapterId(input.id);
  if (typeof input.open !== "function") {
    throw new ConfigurationError(`Database adapter ${id} must provide open(context).`);
  }
  return Object.freeze({ id, open: input.open });
}

/** Storage categories used by Viby. All entries are optional and have existing defaults. */
export interface VibyStorage {
  /** Structured durable records such as chats, messages, generations, and versions. */
  readonly database?: DatabaseAdapter | PersistenceAdapter;
  /** Binary attachments, generated media, project entries, screenshots, and build output. */
  readonly artifacts?: ArtifactStore;
  /** Durable provider-connection metadata. PostgreSQL is the default when integrations exist. */
  readonly connections?: IntegrationConnectionStore;
  /** Opaque provider credentials and project secret values. */
  readonly secrets?: SecretStore;
}

export function isDatabaseAdapter(value: DatabaseAdapter | PersistenceAdapter): value is DatabaseAdapter {
  return Boolean(value && typeof value === "object" && "open" in value && typeof value.open === "function");
}

function normalizeDatabaseAdapterId(value: string): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new ConfigurationError(
      "Database adapter id must contain 1-100 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return id;
}
