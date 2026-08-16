---
title: "Versions and artifacts"
description: "Inspect, change, branch, preview, evaluate, publish, and download immutable source versions."
---

# Versions and artifacts

A version is a complete immutable project snapshot. Generation, import, direct changes, workspace
commits, restore, and iteration create new versions instead of mutating existing source.

## Version identity

| Property | Meaning |
| --- | --- |
| `id` | Opaque immutable version identifier. |
| `chatId` | Owning project timeline. |
| `generationId` | Logical generation that produced the version, or `null` for non-generation origins. |
| `parentVersionId` | Previous snapshot in this lineage, or `null` for an initial import. |
| `number` | Stable chat-local sequence number. |
| `origin` | How the version was created: generation, import, changes, restore, fork, or workspace flow. |
| `framework` | Framework identifier inherited from the chat. |
| `title` / `summary` | Generated or host-supplied version metadata. |
| `createdAt` | Durable creation timestamp. |

## Read source

| Method | Returns | Behavior |
| --- | --- | --- |
| `files()` | `VersionFile[]` | Text-only compatibility view of the source tree. |
| `entries()` | `VersionEntry[]` | Complete text and artifact-backed source entries with media type and lock state. |
| `projectArtifact(id)` | `ProjectArtifactContent` | Reads and checksum-verifies one binary project entry. |
| `changes()` | `SourceChange[]` | Ordered immutable change set that created this version. |
| `generation()` | `GenerationData \| null` | Loads the producing logical generation when one exists. |

Paths are normalized, relative, and unique. Artifact bytes stay in `storage.artifacts`; version rows
store metadata and opaque references.

## Iterate and change source

| Method | Behavior |
| --- | --- |
| `startIteration(input)` | Starts a durable generation with this exact version as its base and returns immediately. |
| `iterate(input)` | Waits for successful iteration and returns the new immutable child version. |
| `apply({ changes, title?, summary? })` | Validates an ordered write/delete/move set and atomically creates a child version. |
| `workspace()` | Returns an `AgentWorkspace` for bounded reads, search, staged changes, and atomic commit. |

```ts
const changed = await version.apply({
  title: "Update navigation",
  changes: [
    { type: "write", path: "src/navigation.ts", content: nextNavigation },
    { type: "move", from: "src/old.ts", path: "src/new.ts" },
    { type: "delete", path: "src/unused.ts" },
  ],
});
```

Locked paths reject writes, deletes, and moves. A failed validation creates no partial version.

## Fork and restore

| Method | Behavior |
| --- | --- |
| `fork({ title?, metadata? })` | Creates a new chat whose initial source equals this version. The original chat is unchanged. |
| `restore({ title?, summary? })` | Creates a new child version in the same chat whose complete source equals this historical snapshot. |

Restore does not move a mutable pointer backward. The restored source becomes a new auditable version
at the head of the current timeline.

## Sandbox and preview

| Method | Behavior |
| --- | --- |
| `sandbox(options?)` | Materializes this version in the configured sandbox and returns a live `SandboxSession`. |
| `preview(options?)` | Starts the configured long-running preview command, waits for readiness, persists the session, and returns `Preview`. |

Neither method exists as hosted magic. Without a configured adapter, sandbox methods throw
`SandboxUnavailableError` and API-host preview routes report `501 preview_not_configured`.

## Repository publishing

```ts
const github = user.integrations.repository.use("github");

const result = await version.push({
  using: github,
  repository: { owner: "acme", name: "generated-app", createIfMissing: true },
  branch: { name: "main", createIfMissing: true },
  commit: { message: "feat: publish generated app" },
  pullRequest: { title: "feat: publish generated app", base: "main" },
});
```

| Method | Behavior |
| --- | --- |
| `push(input)` | Persists a pending effect, sends the complete immutable snapshot through a repository handle, and records push/conflict/failure plus optional PR. |
| `repositoryPushes()` | Reloads durable push history for this exact version without contacting the provider. |

Push inputs accept a stable idempotency key. Repeating a completed key returns the persisted outcome.
An optimistic `expectedHead` conflict is recorded without overwriting the remote branch.

## Deployment

```ts
const hosting = user.integrations.deployment.use("vercel");

const deployment = await version.deploy({
  using: hosting,
  project: { name: "generated-app", createIfMissing: true },
  environment: "preview",
});
```

| Method | Behavior |
| --- | --- |
| `deploy(input)` | Persists a pending effect, prepares source or prebuilt output as required, invokes the provider, and records status transitions. |
| `deployments()` | Reloads durable deployment history for this version. |
| `deploymentArtifact(deploymentId)` | Reads and checksum-verifies the immutable prebuilt ZIP used for that deployment, or returns `null`. |

The URL is nullable until the provider returns one. Raw source remains separate from prebuilt output;
`download()` always returns the framework-native project.

## Design and visual evaluation

| Method | Behavior |
| --- | --- |
| `recordDesignEvaluation(input)` | Persists an immutable rubric evaluation linked to validated evidence. |
| `getDesignEvaluation(id)` | Loads one evaluation for this version. |
| `listDesignEvaluations(options?)` | Cursor-pages evaluation history. |
| `evaluateVisual(input)` | Captures configured browser pages, stores screenshots as artifacts, runs quality gates, and records evidence. |
| `visualArtifacts()` | Lists screenshot metadata for the version. |
| `getVisualArtifact(id)` | Reads and checksum-verifies one visual artifact. |

Visual evaluation requires a configured browser and a resolvable preview source. Quality gates are
host-provided and may be rule-, model-, or agent-based.

## Download

```ts
const download = await version.download();

download.filename;
download.contentType; // application/zip
download.bytes;       // Uint8Array
return download.toResponse();
```

The ZIP is deterministic for the persisted source snapshot and includes artifact-backed binary
entries. It excludes secrets, dependency directories, lockfiles, build output, and provider state.
