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

## Status model

| Generation status | Meaning |
| --- | --- |
| `queued` | Durable work exists but no active attempt currently owns execution. |
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
  generation: {
    quality: {
      prepare: [{ id: "install", command: "npm", args: ["install", "--ignore-scripts"] }],
      checks: [
        { id: "typecheck", command: "npm", args: ["run", "typecheck"] },
        { id: "build", command: "npm", args: ["run", "build"] },
      ],
    },
  },
});
```

Viby materializes the complete candidate in a fresh sandbox and commits it only after every check
exits successfully. Failures end the attempt without persisting a partial version. Start and finish
events use the normal resumable cursor, while command output is deliberately not persisted because
it may contain secrets. The configured command policy applies to every quality command.

## Worker execution

Set `generation: { execution: "worker" }`, then run a worker in any suitable process:

```ts
const worker = viby.worker({ id: "worker-1", concurrency: 4 });
await worker.run({ signal });
```

Claims are database-backed, scoped to compatible framework and model/engine identities, and fenced
with lease tokens. The runtime provides at-least-once execution; provider effects must remain
idempotent.
