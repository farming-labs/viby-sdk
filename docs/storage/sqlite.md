---
title: "SQLite"
description: "Use the embedded SQLite persistence adapter for local products, desktop hosts, examples, and tests."
---

# SQLite

`@viby/sdk/storage/sqlite` is a zero-service structured database for local products, desktop
applications, examples, and integration tests. It implements the complete `PersistenceAdapter`
contract and passes the same durability, isolation, history, artifact, feedback, worker, and
preview conformance suite as other adapters.

```ts
import { createViby } from "@viby/sdk/node";
import { sqlite } from "@viby/sdk/storage/sqlite";

const viby = createViby({
  framework: "farmjs",
  model,
  storage: {
    database: sqlite({ path: ".viby/viby.sqlite" }),
  },
});
```

The adapter creates parent directories, initializes its table automatically, enables foreign-key
checks and full synchronous durability, and uses WAL for file databases by default. Each successful
mutation replaces one versioned embedded state snapshot inside an immediate SQLite transaction.
Separate SDK processes refresh that revision before reads and serialize writers through SQLite's
locking protocol. `busyTimeoutMs` controls how long a writer waits; it defaults to five seconds.

## Runtime and ownership

The adapter uses the built-in `node:sqlite` module and therefore requires Node.js 22.5 or newer.
Import it only from its explicit subpath. The portable core and the package's Node 20 baseline do
not load SQLite.

SQLite stores structured records and binary bytes together in the local database. Consequently,
this adapter deliberately rejects a separate `storage.artifacts` value instead of silently
duplicating or ignoring it. Use PostgreSQL with an external filesystem or S3-compatible artifact
store when binaries must live independently.

## Low-level persistence

Use the raw adapter when defining a custom host composition:

```ts
import { sqlitePersistence } from "@viby/sdk/persistence/sqlite";

const persistence = sqlitePersistence({
  path: ".viby/viby.sqlite",
  busyTimeoutMs: 10_000,
  wal: true,
});
```

`:memory:` is supported for tests. File databases persist across process restarts and multiple
handles observe committed revisions. `close()` is idempotent; using an adapter after it closes is
an explicit configuration error.

## Production guidance

The snapshot layout favors portability and complete local behavior over high write throughput. It
is appropriate for one-user desktop tools, local development, demos, and bounded single-host
deployments. PostgreSQL remains the zero-configuration default and recommended choice for
multi-service production systems, large histories, independently scaled workers, or external
artifact storage.
