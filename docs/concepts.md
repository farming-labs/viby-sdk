---
title: "Core concepts"
description: "The ownership, durability, identity, versioning, and adapter model behind Viby."
---

# Core concepts

Viby is an embeddable product SDK, not a hosted control plane. Its contracts separate durable
software-generation state from the application and infrastructure choices around it.

## Host-owned and SDK-owned concerns

| The host application owns | Viby owns |
| --- | --- |
| authentication, authorization, billing, and product UI | tenant/user-scoped chats and messages |
| model, provider, and infrastructure credentials | logical generations, immutable attempts, and ordered events |
| PostgreSQL, object storage, sandboxes, browsers, and cloud accounts | typed tasks, tool records, and idempotency state |
| framework instructions and product policy | immutable source versions, lineage, artifacts, and histories |
| HTTP routes, queues, workers, cron, and observability backends | migrations for the dedicated `viby` schema |

This division is intentional. Viby can coordinate a provider connection, for example, but the host
still registers the provider application, authenticates the user starting the flow, and supplies the
secret-storage boundary.

## Identity is explicit

The root client has no ambient user. An authenticated product request must call:

```ts
const user = viby.forUser({ tenantId, userId });
```

The returned `ScopedViby` is the only entry to chats, generations, previews, tool registrations,
and user-scoped integrations. Passing identity explicitly makes the same SDK safe to use from HTTP
handlers, queues, workers, scripts, and tests.

## A chat is a durable project timeline

A chat contains messages and an ordered graph of immutable source versions. It may begin empty,
from a file list, from a ZIP, or through a source-import adapter. Chat metadata is application-owned
JSON and can be used for search and product state; it must not contain credentials.

Deleting a chat creates a retention tombstone. `restore()` is available until the record is purged.
Permanent purge removes scoped child records and associated artifact bytes according to the
configured retention policy.

## A generation is logical; an attempt is physical

A generation represents one user intent. Initial execution, retry, resume, and task resolution each
append an immutable attempt to that logical generation. This preserves failures, model attribution,
usage, cost, and worker ownership instead of rewriting history.

Generation events are persisted before subscribers see them. Cursors are opaque and monotonically
ordered within a generation. A client can reconnect from its last acknowledged cursor without
depending on a provider's transient stream identifier.

## A version never changes

Successful generation, direct source changes, imports, restore, and workspace commits create new
versions. A version records its parent, origin, complete source tree, ordered change set, and any
artifact-backed binary entries. Pushes, deployments, previews, evaluation, and downloads always
name an immutable version.

This gives the product stable provenance: a deployment or pull request can be traced to the exact
source the user approved.

## Adapters are capability boundaries

The core contracts use provider-neutral interfaces for generation engines, persistence, artifacts,
skill resolution, source import, tool sources, sandboxes, browsers, repositories, and deployments.
Provider packages implement those interfaces behind explicit subpath exports.

Application code should branch on declared capability or returned state, not provider names. For
example, `session.supports("backgroundProcesses")` is portable; checking for `provider === "e2b"`
is not.

## Secrets never become ordinary records

Provider tokens and secret project variables live behind `storage.secrets`. Public records retain
only redacted metadata and opaque references. Resolved secret bytes may enter a selected sandbox,
build, deployment, or adapter call at runtime, but they do not enter prompts, messages, event logs,
telemetry attributes, repository history, deployment history, or command records.

## Preview and deployment are different

A preview is a durable Viby record around a sandbox process and its readiness state. It has a URL
only when the selected sandbox can expose a port. A deployment is a provider-owned release result
recorded through a deployment adapter. Viby does not invent either URL when no provider exists.

## Embedded and worker execution

Embedded execution starts work in the application process after the durable attempt is created.
Worker execution leaves attempts queued for a separately run `GenerationWorker`. Worker claims use
leases, heartbeats, and fencing so a stale process cannot commit after another worker takes over.

The contract is at-least-once. External effects must use Viby idempotency keys or an equivalent
provider mechanism.

See [Generations and events](/docs/api/generations) for lifecycle semantics and
[Package entry points](/docs/api/entry-points) for runtime boundaries.
