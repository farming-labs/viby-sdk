---
title: "Generations and events"
description: "Durable generation states, attempts, resumable streams, tasks, workers, artifacts, and recovery."
---

# Generations and events

A `Generation` is an addressable logical request. Attempts are immutable executions appended for
initial work, retry, resume, or task resolution.

## Start a generation

```ts
const generation = await chat.start({
  prompt: "Add a billing settings page",
  model: "fast",
  instructions: "Preserve the existing navigation contract.",
  skills: { security: ["company/skills/billing-security"] },
});
```

`chat.start()` commits the generation before execution begins. `user.generations.get(id)` or
`chat.getGeneration(id)` can rehydrate the same handle after a request, reload, or process restart.

## Queue follow-up prompts

Products can accept the next prompt while a generation is still running without guessing which
source snapshot it should edit:

```ts
const first = await chat.start({ prompt: "Build the analytics dashboard" });
const followUp = await chat.enqueue({
  prompt: "Add a compact revenue trend",
  afterGenerationId: first.id,
});

const waiting = await chat.queuedGenerations();
```

`enqueue()` atomically persists the follow-up generation, attempt, user message, and predecessor
reference. It remains `queued` and cannot be claimed until the predecessor succeeds. At claim time,
Viby resolves the predecessor's immutable version as `baseVersionId`, so a chain such as A → B → C
always edits the intended result. This contract is identical for embedded and external workers.

If a predecessor fails or is cancelled, its dependents remain durably queued. The application may
retry the predecessor or explicitly cancel the dependent; Viby never silently skips or rebases it.
`GET /chats/{chatId}/queue` and `POST /chats/{chatId}/queue` expose the same behavior through the
Web API, and the portable client provides `client.chats.queue.list()` and `.create()`.

## Status model

| Generation status | Meaning |
| --- | --- |
| `queued` | Durable work exists but no active attempt currently owns execution; a follow-up may also be waiting for its predecessor. |
| `running` | An embedded runner or leased worker owns the active attempt. |
| `waiting` | A typed plan, question, or permission task must be resolved. |
| `succeeded` | A final assistant message and immutable version were committed. |
| `failed` | The active attempt ended with a durable safe error. |
| `cancelled` | Cancellation was committed with a reason. |

Attempt statuses also include `interrupted`. Retrying, resuming, or resolving a task never overwrites
an older attempt.

## `GenerationCollection`

| Method | Behavior |
| --- | --- |
| `get(id)` | Loads an in-scope generation by ID and returns a live handle over its durable state. |

## `Generation`

### Read state

| Method | Returns | Behavior |
| --- | --- | --- |
| `data()` | `GenerationData` | Current logical status, active attempt, configuration, base/result versions, usage, cost, and timestamps. |
| `attempts()` | `GenerationAttemptData[]` | Immutable execution history in order. |
| `tasks()` | `GenerationTaskData[]` | All proposed and resolved typed tasks for the generation. |
| `toolCalls()` | `ToolCallData[]` | Redacted durable arguments, results, ownership, status, and idempotency. |
| `providerRequests()` | `ProviderRequestAttributionData[]` | Ordered provider request IDs, routed model identity, outcome, latency, token/cache usage, engine cost estimate, and credential-free metadata across all attempts. |
| `artifacts()` | `GeneratedArtifactData[]` | Metadata for generated images, audio, video, documents, or binary outputs. |
| `getArtifact(id)` | `GeneratedArtifactContent` | Checksum-verifies and returns one scoped artifact's bytes. |
| `events({ after?, limit? })` | `GenerationEventPage` | Reads one durable event page after an opaque cursor. |
| `outboundDeliveries({ sink, status? })` | delivery records | Inspects persisted delivery attempts and dead letters for one configured sink. |

### Subscribe and wait

| Method | Behavior |
| --- | --- |
| `stream({ after?, pollIntervalMs?, signal? })` | Yields durable events after the cursor and ends at `waiting`, `succeeded`, `failed`, or `cancelled`. Aborting only stops this subscriber. |
| `toEventStreamResponse(options?)` | Returns a Web-standard SSE `Response`, reading `Last-Event-ID` unless `after` is explicit. |
| `wait({ pollIntervalMs?, signal? })` | Waits for a terminal or waiting state and returns a discriminated `GenerationOutcome`. Aborting does not cancel work. |

```ts
for await (const event of generation.stream({ after: lastCursor })) {
  lastCursor = event.cursor;
  await persistAcknowledgedCursor(lastCursor);
  publishToUi(event);
}
```

Events are persisted in cursor order. Lifecycle events, structured output, usage, generated artifacts,
and agent trace parts share the same cursor; no provider stream ID is required for recovery.

### Control execution

| Method | Valid states and behavior |
| --- | --- |
| `cancel(reason?)` | Commits cancellation for active work, then aborts a local model signal when present. Repeated cancellation returns durable state. |
| `retry()` | Appends a retry attempt for failed or cancelled work and schedules it according to execution mode. |
| `resume()` | Appends a resume attempt for waiting or orphaned queued/running work. An unexpired worker lease cannot be stolen. |
| `resolve(input)` | Validates a task-specific resolution, commits it with a new attempt, and resumes the same logical generation. |

Invalid transitions throw `GenerationStateError`. `chat.generate()` translates waiting to
`GenerationTaskRequiredError`, failure to `GenerationError`, and cancellation to
`GenerationCancelledError`.

## Typed tasks

| Kind | Request | Resolution |
| --- | --- | --- |
| `plan` | Proposed ordered steps | `approve`, or `revise` with feedback |
| `question` | Prompt plus optional choices | An explicit answer |
| `permission` | Proposed effect and permissions | `allow` or `deny`, with optional note |

Permission tasks may include a normalized sandbox or tool action. Secret values are omitted from the
proposal. Resolving approval reuses the proposed action's idempotency identity so a completed
external effect is not silently repeated.

## Agent trace events

Trace parts use four event phases:

- `part.started` assigns a stable part ID, type, and position;
- `part.delta` appends incremental content for that ID;
- `part.completed` stores the typed final part on the assistant message;
- `part.failed` records a safe error and retryability without creating a final message part.

Supported final message-part types are `text`, `status`, `reasoning-summary`, `file-read`,
`file-edit`, `search`, `command`, `tool-call`, `error`, and `usage`.
Completed `file-edit` parts distinguish `create`, `update`, `delete`, and `move` operations. The
legacy `write` operation remains part of the readable contract for older persisted messages.

## Outbound delivery

`deliverEvents({ sink, after?, limit?, retry?, signal? })` sends one ordered page through a configured
sink, persisting claims, receipts, retry schedule, and dead-letter state. It returns delivered records,
the safe resume cursor, `hasMore`, dead letters, and the earliest retry time.

`redriveOutboundEvent({ sink, cursor })` explicitly makes one dead letter eligible again. Delivery
failure never changes generation state. Receivers must deduplicate stable event IDs because a remote
endpoint may accept a request before the sender observes a transport failure.

## Generated-source quality gates

Configure provider-neutral quality commands when generated source must install, typecheck, test,
or build before it becomes an immutable version:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  preview: {
    prepare: [{ command: "pnpm", args: ["install", "--prefer-offline"] }],
    start: { command: "pnpm", args: ["dev", "--host", "0.0.0.0"] },
    port: 3000,
  },
  generation: {
    workspace: { preview: "eager" },
    quality: {
      prepare: [{ id: "install", command: "pnpm", args: ["install", "--prefer-offline"] }],
      checks: [
        { id: "typecheck", command: "pnpm", args: ["typecheck"] },
        { id: "build", command: "pnpm", args: ["build"] },
      ],
      checkConcurrency: 2,
    },
  },
});
```

With `workspace.preview: "eager"`, Viby opens the immutable base version immediately, starts preview
preparation while the model works, and emits `workspace.started`, `workspace.prepared`,
`preview.ready`, or `preview.failed` through the normal resumable generation cursor. The preview URL
does not wait for typecheck or production build. Viby synchronizes the final candidate into the same
sandbox, runs preparation, and executes up to `checkConcurrency` independent checks concurrently.
The durable preview record is then retargeted to the committed version without reinstalling or
restarting its server.

Without an eager workspace, quality gates continue to use a fresh sandbox. In either mode, Viby
commits only after every check succeeds. Failures end the attempt without persisting a partial
version. Command output is deliberately not persisted because it may contain secrets, and the
configured command policy applies to every preview and quality command.

## Worker execution

Set `generation: { execution: "worker" }`, then run a worker in any suitable process:

```ts
const worker = viby.worker({ id: "worker-1", concurrency: 4 });
await worker.run({ signal });
```

Claims are database-backed, scoped to compatible framework and model/engine identities, and fenced
with lease tokens. The runtime provides at-least-once execution; provider effects must remain
idempotent.
