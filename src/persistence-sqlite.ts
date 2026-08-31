import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { deserialize, serialize } from "node:v8";
import { ConfigurationError } from "./errors.js";
import { MemoryRepository, type MemoryRepositoryState } from "./memory-repository.js";
import type { PersistenceAdapter } from "./persistence.js";
import { defineDatabaseAdapter, type DatabaseAdapter } from "./storage.js";

export interface SqlitePersistenceOptions {
  /** SQLite filename or :memory:. Parent directories are created automatically. */
  readonly path: string;
  /** Wait for another writer before returning SQLITE_BUSY. Defaults to 5 seconds. */
  readonly busyTimeoutMs?: number;
  /** Enable write-ahead logging for file databases. Defaults to true. */
  readonly wal?: boolean;
}

/**
 * Open the embedded SQLite persistence adapter.
 *
 * This explicit Node-only adapter requires Node.js 22.5 or newer. PostgreSQL remains the default
 * and recommended multi-service production database.
 */
export function sqlitePersistence(options: SqlitePersistenceOptions): PersistenceAdapter {
  const normalized = normalizeOptions(options);
  const Database = loadDatabaseSync();
  if (normalized.path !== ":memory:") mkdirSync(dirname(normalized.path), { recursive: true });
  const database = new Database(normalized.path);
  try {
    database.exec(`PRAGMA busy_timeout = ${normalized.busyTimeoutMs}`);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA synchronous = FULL");
    if (normalized.wal && normalized.path !== ":memory:") database.exec("PRAGMA journal_mode = WAL");
    database.exec(`
      CREATE TABLE IF NOT EXISTS viby_state (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        revision INTEGER NOT NULL CHECK (revision >= 0),
        snapshot BLOB NOT NULL,
        updated_at TEXT NOT NULL
      ) STRICT
    `);
    const existing = readState(database);
    if (!existing) {
      database.prepare(`
        INSERT INTO viby_state (id, revision, snapshot, updated_at)
        VALUES (1, 0, ?, ?)
      `).run(serialize(new MemoryRepository().exportState()), new Date().toISOString());
    }
    return createSqliteAdapter(database);
  } catch (error) {
    database.close();
    throw error;
  }
}

/** Configure SQLite through the categorized `storage.database` surface. */
export function sqlite(options: SqlitePersistenceOptions): DatabaseAdapter {
  const normalized = normalizeOptions(options);
  return defineDatabaseAdapter({
    id: "sqlite",
    open({ artifacts }) {
      if (artifacts) {
        throw new ConfigurationError(
          "The SQLite snapshot adapter owns its embedded artifact bytes and cannot be combined with storage.artifacts.",
        );
      }
      return sqlitePersistence(normalized);
    },
  });
}

export const sqliteDatabase = sqlite;

interface NormalizedSqliteOptions {
  readonly path: string;
  readonly busyTimeoutMs: number;
  readonly wal: boolean;
}

interface StoredState {
  readonly revision: number;
  readonly snapshot: Uint8Array;
}

function createSqliteAdapter(database: DatabaseSync): PersistenceAdapter {
  let closed = false;
  let delegate = new MemoryRepository();
  let localRevision = -1;
  let queue = Promise.resolve();
  loadLatest();

  const exclusive = <T>(work: () => T | Promise<T>): Promise<T> => {
    const run = queue.then(work, work);
    queue = run.then(() => undefined, () => undefined);
    return run;
  };

  const assertOpen = () => {
    if (closed) throw new ConfigurationError("SQLite persistence is closed.");
  };

  function loadLatest(): void {
    const stored = readState(database);
    if (!stored) throw new ConfigurationError("SQLite persistence state is missing.");
    if (stored.revision === localRevision) return;
    let state: unknown;
    try {
      state = deserialize(Buffer.from(stored.snapshot));
    } catch {
      throw new ConfigurationError("SQLite persistence state could not be decoded.");
    }
    const next = new MemoryRepository();
    next.importState(state as MemoryRepositoryState);
    delegate = next;
    localRevision = stored.revision;
  }

  async function read(property: PropertyKey, args: unknown[]): Promise<unknown> {
    return exclusive(async () => {
      assertOpen();
      loadLatest();
      const method = Reflect.get(delegate, property, delegate) as (...values: unknown[]) => unknown;
      return method.apply(delegate, args);
    });
  }

  async function mutate(property: PropertyKey, args: unknown[]): Promise<unknown> {
    return exclusive(async () => {
      assertOpen();
      database.exec("BEGIN IMMEDIATE");
      try {
        loadLatest();
        const method = Reflect.get(delegate, property, delegate) as (...values: unknown[]) => unknown;
        const result = await method.apply(delegate, args);
        const revision = localRevision + 1;
        database.prepare(`
          UPDATE viby_state
          SET revision = ?, snapshot = ?, updated_at = ?
          WHERE id = 1
        `).run(revision, serialize(delegate.exportState()), new Date().toISOString());
        database.exec("COMMIT");
        localRevision = revision;
        return result;
      } catch (error) {
        try { database.exec("ROLLBACK"); } catch { /* transaction already ended */ }
        localRevision = -1;
        throw error;
      }
    });
  }

  return new Proxy(delegate as PersistenceAdapter, {
    get(_target, property) {
      if (property === "close") {
        return () => exclusive(() => {
          if (closed) return;
          database.close();
          closed = true;
        });
      }
      if (property === "exportState" || property === "importState") return undefined;
      const value = Reflect.get(delegate, property, delegate);
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => isReadMethod(property)
        ? read(property, args)
        : mutate(property, args);
    },
  });
}

function readState(database: DatabaseSync): StoredState | null {
  const row = database.prepare("SELECT revision, snapshot FROM viby_state WHERE id = 1").get() as
    | { revision: number | bigint; snapshot: Uint8Array }
    | undefined;
  if (!row) return null;
  const revision = Number(row.revision);
  if (!Number.isSafeInteger(revision) || revision < 0 || !(row.snapshot instanceof Uint8Array)) {
    throw new ConfigurationError("SQLite persistence state is invalid.");
  }
  return { revision, snapshot: row.snapshot };
}

function isReadMethod(property: PropertyKey): boolean {
  if (typeof property !== "string") return true;
  return property === "assertReady" || property.startsWith("get") || property.startsWith("list");
}

function normalizeOptions(options: SqlitePersistenceOptions): NormalizedSqliteOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("SQLite persistence options are required.");
  }
  if (typeof options.path !== "string" || !options.path.trim() || options.path.includes("\0")) {
    throw new ConfigurationError("SQLite persistence path must be a non-empty filename or :memory:.");
  }
  const busyTimeoutMs = options.busyTimeoutMs ?? 5_000;
  if (!Number.isInteger(busyTimeoutMs) || busyTimeoutMs < 0 || busyTimeoutMs > 60_000) {
    throw new ConfigurationError("SQLite busyTimeoutMs must be an integer between 0 and 60000.");
  }
  return {
    path: options.path.trim() === ":memory:" ? ":memory:" : resolve(options.path.trim()),
    busyTimeoutMs,
    wal: options.wal ?? true,
  };
}

function loadDatabaseSync(): typeof DatabaseSync {
  const require = createRequire(import.meta.url);
  try {
    const sqliteModule = require("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
    return sqliteModule.DatabaseSync;
  } catch (error) {
    throw new ConfigurationError(
      "The SQLite persistence adapter requires Node.js 22.5 or newer.",
      { cause: error },
    );
  }
}
