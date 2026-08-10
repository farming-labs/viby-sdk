import type { ArtifactStore } from "./artifact-store.js";
import { ConfigurationError } from "./errors.js";
import type { PersistenceAdapter } from "./persistence.js";
import { PostgresRepository } from "./postgres-repository.js";

export interface PostgresPersistenceOptions {
  /** Defaults to `process.env.DATABASE_URL`. */
  readonly databaseUrl?: string;
  /** External byte store used for attachments and generated artifacts. */
  readonly artifactStore?: ArtifactStore;
}

/** Creates the built-in PostgreSQL persistence adapter explicitly. */
export function postgresPersistence(
  options: PostgresPersistenceOptions = {},
): PersistenceAdapter {
  const databaseUrl = options.databaseUrl ?? process.env.DATABASE_URL;
  if (typeof databaseUrl !== "string" || databaseUrl.trim().length === 0) {
    throw new ConfigurationError(
      "DATABASE_URL is required when PostgreSQL is the Viby persistence adapter.",
    );
  }
  return new PostgresRepository(databaseUrl.trim(), options.artifactStore);
}
