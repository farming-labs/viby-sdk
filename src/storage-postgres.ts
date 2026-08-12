import { postgresPersistence, type PostgresPersistenceOptions } from "./persistence-postgres.js";
import { defineDatabaseAdapter, type DatabaseAdapter } from "./storage.js";
import { ConfigurationError } from "./errors.js";

export interface PostgresDatabaseOptions extends Omit<PostgresPersistenceOptions, "artifactStore"> {
  /** Alias for databaseUrl. Omit both to use process.env.DATABASE_URL. */
  readonly url?: string;
}

/** Creates the built-in PostgreSQL structured database for `storage.database`. */
export function postgres(options: PostgresDatabaseOptions = {}): DatabaseAdapter {
  if (options.url !== undefined && options.databaseUrl !== undefined) {
    throw new ConfigurationError("PostgreSQL database options cannot provide both url and databaseUrl.");
  }
  return defineDatabaseAdapter({
    id: "postgres",
    open: ({ artifacts }) => postgresPersistence({
      ...(options.url !== undefined
        ? { databaseUrl: options.url }
        : options.databaseUrl !== undefined
          ? { databaseUrl: options.databaseUrl }
          : {}),
      ...(artifacts ? { artifactStore: artifacts } : {}),
    }),
  });
}
