---
title: "Generation engines"
description: "Replace Viby's built-in model harness with another agent, runtime, or orchestration system without giving up durable project state."
---

# Generation engines

Most applications should pass `model`. Viby then owns the coding loop, skills, workspace tools,
steering, permissions, traces, immutable source commits, retries, and usage records.

Use a generation engine only when another runtime must own model execution or orchestration. The
engine is a replacement boundary, not a second agent nested inside Viby's default harness.

```ts
import { createViby } from "@viby/sdk";
import { defineGenerationEngine } from "@viby/sdk/core";

const engine = defineGenerationEngine({
  identity: {
    provider: "acme-runtime",
    model: "frontend-agent-v3",
  },
  capabilities: {
    operations: ["change", "inspect"],
    streaming: true,
    steering: true,
    traces: true,
    toolCalls: true,
    artifacts: true,
  },
  async generate(input, context) {
    return runtime.run({ input, context });
  },
  async close() {
    await runtime.close();
  },
});

const viby = createViby({
  framework: "farmjs",
  generation: {
    engine,
    engines: {
      fast: fastEngine,
    },
  },
});
```

`model` and `generation.engine` are mutually exclusive. The older top-level `engine` and `engines`
fields remain as deprecated compatibility aliases.

## Ownership boundary

| Viby owns | The generation engine owns |
| --- | --- |
| tenant and user isolation | model and provider requests |
| chats, messages, attempts, and ordered events | its internal reasoning loop |
| retries, cancellation, resume, and workers | provider-specific sessions and caches |
| tasks, permissions, steering records, and tool-call records | when to consume a supported steering channel |
| immutable source validation, policies, versions, and downloads | producing one valid provider-neutral result |
| sandbox, preview, artifacts, telemetry, and cost attribution | translating its native output into Viby contracts |

This split lets the engine be local, remote, single-step, multi-agent, or backed by a proprietary
runtime. It never needs direct access to Viby's database tables.

## Contract

```ts
interface GenerationEngine<Framework extends FrameworkId = FrameworkId> {
  readonly identity: {
    readonly provider: string;
    readonly model: string;
  };
  readonly capabilities?: Partial<GenerationEngineCapabilities>;

  generate(
    input: GenerationEngineInput<Framework>,
    context?: GenerationEngineContext,
  ): Promise<GenerationEngineOutput>;

  close?(): Promise<void>;
}
```

`defineGenerationEngine()` validates and freezes the public identity and capabilities. Viby calls
`close()` once for every distinct configured engine when `viby.close()` runs, even if the same
object is registered under several aliases.

### Input

`GenerationEngineInput` contains only the material for the current attempt:

- framework, operation, prompt, host instructions, and JSON metadata;
- durable conversation messages and blocking-task resolutions;
- the exact previous immutable source entries;
- resolved immutable skill snapshots and attachments;
- an optional capability-gated sandbox session;
- a scoped tool-source context when the host configured inbound tools.

An inspection operation receives the selected source version but may return only a `message`.
Viby rejects source-producing inspection results.

### Context

`GenerationEngineContext` provides run-scoped controls and durable writers:

```ts
interface GenerationEngineContext {
  readonly signal?: AbortSignal;
  readonly run?: {
    readonly tenantId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly generationId: string;
    readonly attemptId: string;
  };
  readonly onDelta?: (delta: string) => void | Promise<void>;
  readonly trace?: AgentTraceWriter;
  readonly toolCalls?: AgentToolCallWriter;
  readonly steering?: GenerationSteeringChannel;
}
```

Use `run.attemptId` as the idempotency boundary for a remote execution. A retry creates a new
attempt ID; reconnecting the same attempt keeps the same ID. Honor `signal` promptly. Consume
steering only at safe boundaries and only when `steering` is advertised.

### Output

Every run returns exactly one result:

- `project` — a complete initial text-source tree;
- `changes` — immutable writes, moves, and deletes against the previous version;
- `task` — a durable plan, question, or permission request that pauses generation;
- `message` — a read-only inspection response.

All results include normalized usage and a finish reason. Source outputs add a title and summary.
Engines that advertise artifacts may also return binary generated artifacts. Viby validates the
result before it writes a message, commits a version, or exposes it to preview and download APIs.

## Capability discovery

Capabilities prevent a product from discovering unsupported behavior in the middle of a run:

| Capability | Meaning |
| --- | --- |
| `operations` | accepted operations; defaults to only `change` |
| `streaming` | sends text deltas through `onDelta` |
| `steering` | consumes durable steering updates |
| `traces` | emits typed reasoning, search, command, and file trace parts |
| `toolCalls` | records calls and results through the durable tool-call writer |
| `artifacts` | may return generated binary outputs |

Viby capability-gates an operation before calling the engine. Capability values describe public
behavior; they do not reveal a provider-specific implementation.

## Selecting an engine

The configured `generation.engine` is the default. Aliases under `generation.engines` are selected
per request:

```ts
const generation = await chat.start({
  prompt: "Make the dashboard denser",
  engine: "fast",
});
```

Viby stores the selected provider/model identity on the attempt, not the engine object or its
credentials. Durable workers use the same identities to route a queued attempt to a compatible
configured engine.

## Conformance

Use the reusable suite before exposing an engine in production:

```ts
import { verifyGenerationEngine } from "@viby/sdk/generation/conformance";

await verifyGenerationEngine({
  engine,
  scenarios: [
    {
      name: "initial-project",
      input: fixtureInput,
      expected: "project",
    },
  ],
});
```

The suite validates identity, advertised operations, output shape, usage, finish reason,
cancellation, and steering when advertised. Provider live tests should additionally verify remote
authentication, reconnect behavior, timeouts, and cleanup.

## Authorized engine tools

An engine that advertises `toolCalls: true` receives `context.tools` when the host configured tool
sources. The descriptors are provider-neutral JSON Schema values, so a harness can translate them
to its native tool format:

```ts
const engine = defineGenerationEngine({
  identity: { provider: "acme-runtime", model: "coding-agent-v2" },
  capabilities: { toolCalls: true },
  async generate(input, context) {
    const tools = await context.tools?.list();
    const result = await context.tools?.invoke({
      name: "github__create_issue",
      providerCallId: "provider-call-42",
      arguments: { title: "Generated follow-up" },
    });
    return finishProject(input, result);
  },
});
```

Viby applies the host's tool selection and policy before invocation. Read-only inspection exposes
only read tools. Approved calls use the existing durable tool-call record, redaction, exact
idempotency key, and attempt ownership. An approval-required call automatically pauses the
generation with a typed permission task; after the host resolves it, the next attempt sees that
decision and can safely invoke the exact proposed action. Credentials remain inside tool-source
adapter closures and are never placed in an engine descriptor or result.

## Remote runs

`defineRemoteGenerationEngine()` adapts an asynchronous provider run to the same validated output
contract. It is useful when a harness executes behind another service rather than inside the Viby
worker process:

```ts
const engine = defineRemoteGenerationEngine({
  identity: { provider: "acme-runtime", model: "frontend-agent-v4" },
  async start(input, context) {
    return acme.start({
      input,
      idempotencyKey: context.run!.attemptId,
    });
  },
  events(run, { after, signal }) {
    return acme.events(run.id, { after, signal });
  },
  async cancel(run) {
    await acme.cancel(run.id);
  },
});
```

`start` must be idempotent for the durable Viby attempt ID: a reclaimed worker may invoke it again
and must receive the same external run. `events` emits unique opaque cursors and terminates with
exactly one `completed` or `failed` event. Output deltas flow through the ordinary durable Viby
event cursor. Aborting the attempt invokes `cancel` when supplied. Remote metadata must remain
credential-free.

When the configured persistence adapter supports the Viby contract, the wrapper stores the remote
run identity and latest provider cursor through `context.checkpoint`. A reclaimed worker loads that
checkpoint, skips `start`, and calls `events` with the last durable cursor. Completion, provider
failure, and cancellation clear the checkpoint. An interrupted stream retains it for recovery.

Custom engines use the same attempt-scoped API directly:

```ts
const previous = await context.checkpoint?.load();
await context.checkpoint?.save({
  cursor: providerCursor,
  state: { phase: "editing", providerRunId },
});
await context.checkpoint?.clear();
```

Checkpoint writes are accepted only from the active fenced worker lease. State is JSON, capped at
256 KB, and secret-looking values are redacted before persistence. Store credential references,
never credentials, in engine state.

## From prompt to live URL

A generation engine produces source; it does not produce the preview URL directly. The complete
flow remains provider-neutral:

1. The application creates a chat and starts a prompt.
2. Viby runs the selected model harness or generation engine and persists events.
3. Viby validates the result and commits an immutable version.
4. `version.preview()` materializes that version in the configured sandbox.
5. The sandbox starts the framework server and exposes a port URL.
6. Viby persists the preview status and URL for reconnect after a process restart.

Without a sandbox that supports background processes and port URLs, generation and download still
work, but no live preview URL is promised.

## Deliberate follow-up boundaries

The current contract covers embedded calls, remote event streams, and durable Viby workers. Broader harness
support should be added as small provider-neutral contracts rather than provider switches:

- structured delegation records for parent/child agent work;
- engine health and capability negotiation before a worker claims an attempt;
- engine-reported cost estimates and provider request IDs.

These are roadmap boundaries, not shipped behavior. They can be added without moving chat,
version, preview, or storage ownership out of Viby.
