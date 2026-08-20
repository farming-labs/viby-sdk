---
title: "Chats and projects"
description: "Create, import, search, update, retain, and inspect tenant-scoped project timelines."
---

# Chats and projects

A chat is the durable project boundary. It owns messages, generations, versions, attachments,
environment variables, provider histories, tool selections, and application metadata.

## `ChatCollection`

Access the collection through `viby.forUser(scope).chats`.

| Method | Returns | Behavior |
| --- | --- | --- |
| `create(input?)` | `Chat` | Creates an empty chat with optional title and JSON metadata. No generation starts. |
| `import(input)` | `Chat` | Validates files, a ZIP, or a configured source adapter and creates the chat plus its first immutable version atomically. |
| `get(id)` | `Chat` | Loads an active in-scope chat. Deleted, missing, or cross-scope records are not exposed. |
| `list(options?)` | `CursorPage<Chat>` | Lists active chats in stable order with an opaque cursor and optional nested metadata filter. |
| `snapshot(id, options?)` | chat, messages, and versions | Loads one consistent detail-view snapshot with independently paginated message and version windows. |
| `restore(id)` | `Chat` | Clears a soft-delete tombstone while the record still exists. |
| `purgeDeleted({ limit? })` | `number` | Permanently removes eligible deleted chats and their scoped durable resources in bounded batches. |

### Create and search

```ts
const chat = await user.chats.create({
  title: "Customer portal",
  metadata: { workspace: "acme", template: "saas" },
});

const page = await user.chats.list({
  limit: 20,
  after: savedCursor,
  metadata: { workspace: "acme" },
});
```

Metadata values are JSON. Filters match the requested nested structure and never bypass tenant/user
scope. Cursor strings are opaque; do not parse or synthesize them.

### Prompt-derived titles

Use the portable `titleFromPrompt()` helper when a product should show a concise sidebar title as
soon as the first prompt is submitted. It is deterministic and does not contact a model, so it adds
no provider cost or latency to chat creation:

```ts
import { titleFromPrompt } from "@viby/sdk/core";

const prompt = "Build a polished SaaS analytics dashboard with revenue charts";
const chat = await user.chats.create({
  title: titleFromPrompt(prompt),
  metadata: { titleSource: "prompt" },
});

await chat.start({ prompt });
```

The default result contains at most seven words and 48 characters. The helper removes common request
language and implementation detail clauses, preserves meaningful casing such as `SaaS` or `AI`, and
returns `New project` when no usable prompt text remains. Automatic titles remain application-owned:
products can later call `chat.update({ title })` after a user rename or an optional model-assisted
refinement.

`snapshot()` uses one aggregate PostgreSQL query when available. Custom persistence adapters can
provide `readChatSnapshot`; adapters without it use the portable fallback with the same ownership
checks and cursor semantics.

### Import files or a ZIP

```ts
const fromFiles = await user.chats.import({
  title: "Imported app",
  filePolicy: { locked: ["package.json", "farm.config.ts"] },
  source: {
    type: "files",
    files: [
      { path: "src/main.tsx", content: source },
      { type: "artifact", path: "public/logo.png", bytes, mediaType: "image/png" },
    ],
  },
});

const fromZip = await user.chats.import({
  source: { type: "zip", bytes: uploadedZip },
});
```

Paths are normalized and traversal is rejected. Text must be valid UTF-8. Binary entries are stored
through the configured artifact store. Locked paths cannot be changed by generation, workspace
tools, direct patches, moves, or deletes in descendant versions.

## `Chat`

### Properties

| Property | Meaning |
| --- | --- |
| `id` | Opaque chat identifier. |
| `title` | Current user-facing title. |
| `metadata` | Current application-owned JSON metadata snapshot. |
| `framework` | Framework identifier fixed when the chat is created or imported. |
| `createdAt` / `updatedAt` | Durable lifecycle timestamps. |
| `environment` | Chat-scoped environment-variable collection when environment support is configured. |
| `toolSources` | Explicit durable tool-source selection for this chat. |

### Lifecycle and generation

| Method | Behavior |
| --- | --- |
| `update({ title?, metadata? })` | Replaces supplied mutable fields and returns a refreshed handle. Omitted fields are preserved. |
| `delete({ retentionMs? })` | Soft-deletes the chat and returns `deletedAt` plus nullable `purgeAfter`. It does not perform an immediate provider-side cleanup. |
| `start(input)` | Persists a logical generation and first attempt, schedules according to execution mode, and returns an addressable handle. |
| `generate(input)` | Convenience method that waits for success and returns a version. It throws on failure, cancellation, or required tasks. |
| `getGeneration(id)` | Loads a generation belonging to this chat. |
| `startFromVersion(input, version)` | Starts a durable generation from an exact version snapshot. |
| `generateFromVersion(input, version)` | Synchronous convenience around `startFromVersion()` and `wait()`. |

`GenerateInput` accepts `prompt`, a configured `model` alias, host `instructions`, categorized
`skills`, JSON `metadata`, and up to the configured attachment limits. Attachments are immutable and
checksum-verified before later attempts reuse them.

### Versions and messages

| Method | Behavior |
| --- | --- |
| `latestVersion()` | Returns the newest version or `null` when the chat has no source yet. |
| `getVersion(id)` | Loads one version from this chat. |
| `listVersions({ limit?, after? })` | Returns a cursor page of immutable versions. |
| `listMessages({ limit?, after? })` | Returns durable user and assistant messages in stable order. |
| `getMessage(id)` | Loads one message by ID without scanning pages. |
| `getAttachment(id)` | Reads scoped attachment bytes and verified metadata from the artifact store. |

Assistant messages include an optional provider-neutral finish reason and ordered typed parts such as
text, status, reasoning summary, file activity, search, command, tool calls, errors, and usage.
Incomplete trace parts never become final message parts.

### Repository and deployment history

| Method | Behavior |
| --- | --- |
| `repositoryLinks()` | Lists durable links between the chat and remote repositories. |
| `repositoryPushes()` | Lists version-bound push and pull-request outcomes, including failures and conflicts. |
| `deploymentProjects()` | Lists durable links between the chat and provider projects. |
| `deployments()` | Lists deployment lifecycle records across all chat versions. |

These methods return Viby records and work after a restart. They do not query providers unless an
explicit provider operation is invoked.

## Project environment variables

Enable the feature with `environment: {}` or an application-provided store.

```ts
await chat.environment.set({
  environment: "preview",
  name: "PUBLIC_API_ORIGIN",
  value: "https://api.example.com",
});

await chat.environment.set({
  environment: "preview",
  name: "SERVICE_TOKEN",
  value: token,
  secret: true,
});

const records = await chat.environment.list({ environment: "preview" });
await chat.environment.delete({ environment: "preview", name: "SERVICE_TOKEN" });
```

Public values are returned through `value`. Secret records always return `value: null`; bytes remain
behind `storage.secrets`. Values resolve only when a sandbox, preview, build, or deployment explicitly
selects the environment.

## Deletion and retention

The default retention is 30 days. Configure `retention.deletedChatsMs`, override it on one `delete`,
and run `purgeDeleted()` from a host-owned schedule. `null` retains indefinitely. Purge is destructive
and cannot be undone; products should make that distinction explicit in their UI.
