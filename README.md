# Viby SDK

`@viby/sdk` is a framework-agnostic TypeScript SDK for building persistent, skill-guided vibe coding products. Your application owns authentication, model credentials, and Postgres. Viby owns chats, durable generation attempts and events, typed tasks, immutable source versions, iteration, and source downloads.

## Install

```bash
npm install @viby/sdk ai
```

Add your Postgres connection and model-provider credentials to the server environment:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/viby
```

Run the Viby-owned migrations:

```bash
npx viby db migrate
```

Viby creates and maintains a dedicated `viby` Postgres schema. Your existing authentication and user tables remain the source of truth.

## Create the SDK

Pass one framework, one AI SDK model, and categorized skills:

```ts
import { createViby, skillRead } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";

export const viby = createViby({
  framework: "farm",
  model: openai("your-model-id"),
  retention: { deletedChatsMs: 30 * 24 * 60 * 60 * 1_000 },
  agent: {
    maxSteps: 20,
    maxDurationMs: 300_000,
    maxTokens: 200_000,
    maxCommands: 20,
    commandTimeoutMs: 60_000,
    sandboxPorts: [3000],
  },
  skills: {
    core: [skillRead("./skills/company")],
    design: [skillRead("./skills/design-engineer")],
    frontend: ["owner/repository/frontend-skill"],
    security: ["owner/repository/security-skill"],
  },
});
```

The model provider reads its own credential from your environment. Viby does not receive or store it. The default generator is a bounded AI SDK tool-loop agent: it reads and changes source through `AgentWorkspace`, emits durable tool and trace records, and returns either an immutable project result or a typed blocking task.

Remote skill strings use the stable skills.sh `owner/repository/slug` form. Local skills can point at a directory containing `SKILL.md` or at the file itself. Remote skills are resolved through the authenticated skills.sh API when Vercel OIDC is available, with public GitHub repositories as the portable fallback. Set `GITHUB_TOKEN` only when you need higher GitHub API limits.

## Generate and iterate

Scope every operation to IDs from your authentication system:

```ts
const userViby = viby.forUser({
  tenantId: organization.id,
  userId: session.user.id,
});

const chat = await userViby.chats.create({
  title: "Analytics dashboard",
});

let version = await chat.generate({
  prompt: "Build a polished SaaS analytics dashboard",
});

version = await version.iterate({
  prompt: "Make the sidebar more compact and improve empty states",
});
```

## Import an existing project

Create a durable chat and first immutable version directly from UTF-8 source files or ZIP bytes. Importing never invokes the model.

```ts
const imported = await userViby.chats.import({
  title: "Existing Farm app",
  filePolicy: { locked: ["package.json", "farm.config.ts"] },
  source: {
    type: "files",
    files: [
      { path: "package.json", content: packageJson },
      { path: "src/index.ts", content: source },
    ],
  },
});

const importedVersion = await imported.latestVersion();
```

Use `{ type: "zip", bytes }` for a ZIP archive. Imports reject unsafe paths, duplicate files, encrypted or oversized archives, symbolic links, binary content, and ZIP bombs before persistence.

`filePolicy.locked` accepts `"all"` or normalized project paths. File-list imports may also set `locked: true` on individual files. A lock becomes immutable version metadata: direct changes, generated changes, and agent workspace tools cannot write, delete, or move the file. Forks, restores, and child snapshots preserve it.

External sources use the same import pipeline through a provider-neutral adapter:

```ts
import type { SourceImportAdapter } from "@viby/sdk";

const source: SourceImportAdapter<{ projectId: string }> = {
  name: "company-source",
  async import({ projectId }, { signal }) {
    const bytes = await companyClient.downloadZip(projectId, { signal });
    return {
      title: `Imported ${projectId}`,
      source: { type: "zip", bytes },
    };
  },
};

const imported = await userViby.chats.import({
  source: {
    type: "adapter",
    adapter: source,
    input: { projectId: "project_123" },
  },
});
```

The application owns adapter credentials and transport. Viby passes only tenant/user scope, framework, and an optional abort signal; it never stores adapter input. Returned files or ZIP bytes still pass every normal size, archive, path, UTF-8, and locked-file validation before one immutable version is committed.

Apply deterministic source changes without invoking the model:

```ts
const editedVersion = await importedVersion!.apply({
  changes: [
    { type: "write", path: "src/index.ts", content: updatedSource },
    { type: "move", from: "README.md", to: "docs/README.md" },
    { type: "delete", path: "src/legacy.ts" },
  ],
});
```

`apply` creates a complete immutable child snapshot. It never changes the selected version in place and rejects changes to locked files before persistence.

The default agent uses the same workspace primitives automatically. Advanced consumers can also open an in-memory workspace over an immutable version and expose its portable tools to a custom model runtime:

```ts
const workspace = await importedVersion!.workspace();

await workspace.tools.readFile({ path: "src/index.ts" });
await workspace.tools.search({ query: "legacy", prefix: "src" });
await workspace.tools.writeFile({
  path: "src/index.ts",
  content: updatedSource,
});
await workspace.tools.moveFile({ from: "README.md", to: "docs/README.md" });
await workspace.tools.deleteFile({ path: "src/legacy.ts" });

const proposedChanges = workspace.changes();
const nextVersion = await workspace.commit({
  title: "Agent-refined project",
  summary: "Reviewed and committed the staged source changes.",
});
```

The functions are ordinary typed JavaScript functions, so they can be mapped into any model provider's tool format without importing provider concepts into Viby. Reads and writes operate only on the in-memory workspace. `commit` validates the complete change set and atomically creates one immutable child version; it never mutates the base version or performs external effects.

The built-in agent enforces total step, wall-clock, observed-token, sandbox-command, per-command timeout, and command-output limits. Its workspace tools are always portable. During an iteration, a configured sandbox adapter may materialize the immutable base version; read, command, streaming-output, and port URL tools are exposed only when that session declares the matching capability. Viby checks capabilities, not provider names. New projects have no persisted base version yet, so they start with workspace tools and no sandbox session.

Fork or restore any historical snapshot without a model request:

```ts
const experiment = await importedVersion!.fork({
  title: "Import experiment",
});

const restored = await importedVersion!.restore();
```

`fork` creates a new chat whose first version points back to the selected source version. `restore` copies the selected files into a new latest version in the same chat.

Every generation attempt is stored, including failures and token usage. Initial generations produce a complete source tree. Iterations produce typed `write`, `delete`, and `move` operations, which Viby validates against the selected base and stores alongside the resulting complete immutable snapshot. `version.changes()` returns those ordered operations; imported, forked, and restored versions return an empty list.

## Run a version in an isolated sandbox

Pass any compatible sandbox adapter when constructing Viby. The core SDK does not own provider credentials and does not require a particular sandbox vendor.

```ts
const viby = createViby({
  framework: "farm",
  model,
  sandbox: yourSandboxAdapter,
});

const sandbox = await version.sandbox({
  timeoutMs: 5 * 60_000,
  ports: [3000],
});

try {
  const install = await sandbox.run({ command: "pnpm", args: ["install"] });
  const build = await sandbox.run({ command: "pnpm", args: ["build"] });

  if (install.exitCode !== 0 || build.exitCode !== 0) {
    throw new Error(build.stderr || install.stderr);
  }
} finally {
  await sandbox.stop();
}
```

Commands use a separate executable and argument list instead of an interpolated shell command. Sessions support streamed output, relative file reads and writes, optional public port URLs, abort signals, and idempotent cleanup. `viby.close()` stops any session the application left open.

Inspect `sandbox.capabilities` or call `sandbox.supports("portUrls")` before using optional behavior. The typed capability record is provider-neutral and reports what the configured adapter implements; unsupported primitives remain `false` until the adapter exposes them through Viby.

Adapters with `backgroundProcesses` can start a long-running server without blocking the request. Readiness works across any adapter with `portUrls` and accepts a custom check for authenticated or nonstandard preview routes:

```ts
const server = await sandbox.start({
  command: "pnpm",
  args: ["dev", "--host", "0.0.0.0"],
  onOutput: ({ stream, data }) => console.log(stream, data),
});

const previewUrl = await sandbox.waitForPort(3000, { path: "/health" });

// Later:
await server.kill();
```

E2B, Vercel Sandbox, and Cloudflare currently expose native background handles. Other adapters report the capability as `false`; Viby never detaches a process through an untracked shell workaround.

Every opened sandbox receives a tenant- and user-scoped durable lease. Keep its Viby-owned lease id and reconnect after a request or process restart:

```ts
const leaseId = sandbox.leaseId;
const reconnected = await userViby.sandboxes.reconnect(leaseId);
```

`userViby.sandboxes.get(leaseId)` returns the portable lease metadata. Viby stores the provider name, opaque provider sandbox id, source version, framework, declared ports, state, and expiration. It never stores provider credentials, environment values, or vendor response payloads. E2B, Vercel Sandbox, and Cloudflare implement native reconnect today; other adapters fail through the capability gate.

Enforce one command policy across every adapter in the session core:

```ts
import { sandboxCommandPolicy } from "@viby/sdk";

const viby = createViby({
  framework: "farm",
  model,
  sandbox,
  sandboxPolicy: sandboxCommandPolicy({
    allowCommands: ["node", "pnpm"],
    denyCommands: ["sudo"],
    actions: ["run", "start"],
    environment: ["CI", "NODE_ENV"],
    maxTimeoutMs: 5 * 60_000,
    maxArgs: 100,
  }),
});
```

`sandboxPolicy` may also be an async function returning `{ decision: "allow" }`, `{ decision: "deny", reason }`, or `{ decision: "approval-required", reason }`. The earlier `{ allow: true | false, reason? }` form remains accepted for compatibility. Viby authorizes normalized command metadata before calling `run` or `start`; a denial, thrown policy error, or malformed decision is fail-closed. Policy requests and persisted approval tasks include environment variable names but never their values. Keep credentials out of command arguments as well, since arguments are necessarily visible to command authorization.

When the default agent receives `approval-required`, it stops before adapter execution and persists the exact proposed action on a permission task. Resolve that task through the normal durable generation API:

```ts
const outcome = await generation.wait();

if (outcome.status === "waiting") {
  const task = outcome.tasks.find((candidate) => candidate.kind === "permission");
  if (task?.kind === "permission" && task.proposedAction) {
    await generation.resolve({
      taskId: task.id,
      resolution: { kind: "permission", decision: "allow" },
    });
  }
}
```

The resumed attempt can execute only the approved action fingerprint. Agent commands are recorded as external effects under the same stable idempotency key, so a completed call is reused and a pending, uncertain call must be reconciled instead of repeated. A denied task keeps that exact action denied for the generation.

Adapter authors can import `verifySandboxAdapter` from `@viby/sdk/sandbox/conformance` in their own test suite. The caller supplies a harmless runtime-specific command and fixture credentials; Viby verifies capability declarations, text and binary file roundtrips, commands, streaming, port URLs, and idempotent cleanup without assuming a framework, image, or provider.

### E2B

Install E2B only when that is the provider your product uses:

```bash
npm install e2b
```

```ts
import { e2bSandbox } from "@viby/sdk/sandbox/e2b";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: e2bSandbox({
    apiKey: process.env.E2B_API_KEY,
    template: "base",
  }),
});
```

The adapter maps Viby timeouts, environment variables, file operations, abort signals, output callbacks, and port URLs to the E2B SDK. Arguments are POSIX-quoted before reaching E2B's shell command API.

### Vercel Sandbox

Install the provider peer:

```bash
npm install @vercel/sandbox
```

```ts
import { vercelSandbox } from "@viby/sdk/sandbox/vercel";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: vercelSandbox({
    image: "vercel/sandbox/universal:latest",
  }),
});
```

Vercel OIDC authentication is automatic in a linked Vercel project. Outside Vercel, pass `token`, `teamId`, and `projectId` together. Viby creates non-persistent execution sandboxes, declares requested preview ports at creation, and maps command output streams into the common callback.

### Daytona

Install the provider peer:

```bash
npm install @daytona/sdk
```

```ts
import { daytonaSandbox } from "@viby/sdk/sandbox/daytona";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: daytonaSandbox({
    apiKey: process.env.DAYTONA_API_KEY,
    image: "node:24",
    resources: { cpu: 2, memory: 4 },
  }),
});
```

Without explicit credentials, the Daytona SDK reads `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET`. The adapter creates ephemeral sandboxes with a TTL matching the Viby session, supports images or snapshots, streams command output through Daytona sessions, and returns signed preview URLs that can be opened directly. Network allowlists, secrets, labels, resources, and custom names remain provider options rather than leaking into Viby’s shared contract.

### Modal

Install the provider peer in a server-side Node.js 22 or newer application:

```bash
npm install modal
```

```ts
import { modalSandbox } from "@viby/sdk/sandbox/modal";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: modalSandbox({
    appName: "viby",
    image: "node:24-bookworm-slim",
    cpu: 2,
    memoryMiB: 2048,
  }),
});
```

Modal reads `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` by default or accepts the pair explicitly. The adapter passes command arguments directly as an argv array, streams stdout and stderr concurrently, uses Modal's binary filesystem API, declares encrypted preview tunnels at creation, and terminates the sandbox when the Viby session stops. Provider options include registry or named Modal images, GPU and resource controls, named secrets, regions, cloud placement, network allowlists, tags, OIDC identity tokens, and idle timeouts.

### Cloudflare Sandbox

Install the provider peer in a Cloudflare Worker project:

```bash
npm install @cloudflare/sandbox
```

Export Cloudflare's Durable Object class and pass its configured binding to Viby inside the Worker:

```ts
export { Sandbox } from "@cloudflare/sandbox";

import { cloudflareSandbox } from "@viby/sdk/sandbox/cloudflare";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: cloudflareSandbox({
    binding: env.Sandbox,
    preview: "tunnel",
  }),
});

const session = await version.sandbox({ ports: [5173] });
```

The Worker must configure the `Sandbox` container, Durable Object binding, and migration in `wrangler.jsonc`. The adapter defaults to sessionless RPC execution, writes binary files without host filesystem access, maps command streaming and abort signals, creates zero-config quick-tunnel previews, and destroys the container on cleanup. For stable previews, pass `{ hostname, token?, name? }` instead of `"tunnel"`. Preview URLs are public, port `3000` is reserved by Cloudflare's internal control server, and local container development requires Docker.

### Local Docker

Docker requires no JavaScript provider dependency:

```ts
import { dockerSandbox } from "@viby/sdk/sandbox/docker";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: dockerSandbox({
    image: "node:24-bookworm-slim",
    cpus: 2,
    memoryMb: 2048,
  }),
});
```

The adapter uses the local Docker CLI and daemon. It never bind-mounts generated source: files are streamed into a labeled, read-only-root container with dropped capabilities, `no-new-privileges`, PID/CPU/memory limits, and a size-limited temporary workspace. Use it for trusted local or single-tenant infrastructure; a Docker daemon is not a substitute for a hardened multi-tenant cloud sandbox.

## Run and stream asynchronously

`chat.start` persists a queued generation and its first attempt before model execution begins, then immediately returns an addressable generation handle:

```ts
const generation = await chat.start({
  prompt: "Build a polished SaaS analytics dashboard",
});

for await (const event of generation.stream()) {
  if (event.type.startsWith("part.")) {
    sendToBrowser(event);
  }
}

const outcome = await generation.wait();
if (outcome.status === "succeeded") {
  const version = outcome.version;
}
```

Events are committed to Postgres with monotonically increasing string cursors. A reconnecting client can continue without replaying acknowledged events:

```ts
const page = await generation.events({ after: lastCursor });

for await (const event of generation.stream({ after: lastCursor })) {
  lastCursor = event.cursor;
}
```

Agent trace parts use four lifecycle events: `part.started`, `part.delta`, `part.completed`, and `part.failed`. Started events establish a stable part id, type, and trace position; deltas append live display data; completion carries the typed durable part; and failures carry a redaction-safe error. Completed trace parts retain the same id in the final assistant message. Saving the normal generation cursor is sufficient to resume both lifecycle and trace events.

Send those same durable events to any application-owned transport with signed envelopes:

```ts
import { signedOutboundEventSink } from "@viby/sdk";

const productEvents = signedOutboundEventSink({
  id: "product-events",
  keyId: "events-2026-08",
  secret: process.env.VIBY_EVENT_SECRET!,
  send: (request) => fetch(process.env.EVENT_ENDPOINT!, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    signal: request.signal,
  }),
});

const viby = createViby({
  framework: "farm",
  model,
  events: { sinks: [productEvents] },
});

const page = await generation.deliverEvents({
  sink: "product-events",
  after: savedCursor,
  limit: 100,
});
savedCursor = page.cursor;
```

`deliverEvents` is explicit so the host can run it in its own request, cron, queue, or workflow system and persist one cursor per sink. Delivery is at least once. Event IDs are stable as `<generationId>:<cursor>`, so receivers should deduplicate them. A transport failure throws `OutboundEventDeliveryError` with `lastDeliveredCursor`, allowing an exact retry without changing generation state.

The helper emits a CloudEvents-style JSON envelope and signs `timestamp.eventId.body` with HMAC-SHA256. It includes key ID, timestamp, event ID, and `v1` signature headers. Rotate keys through `keyId`, keep signing secrets server-side, reject timestamps outside your chosen replay window, and use `verifySignedOutboundEvent` for constant-time verification. Neither secrets nor transport responses are persisted.

Tool executions are provider-neutral records owned by their immutable attempt and, after completion, their assistant message:

```ts
const toolCalls = await generation.toolCalls();

for (const call of toolCalls) {
  console.log(call.name, call.status, call.arguments, call.result);
}
```

Arguments and results are validated as bounded JSON and redact common credential fields before persistence. Read, write, and external effects share one contract. External effects require an idempotency key, and replaying the same tenant/tool/key returns the original record instead of authorizing the effect again.

Stopping an event iterator only disconnects that subscriber. Explicitly cancel the underlying model call with:

```ts
await generation.cancel("Stopped from the product UI");
```

Failures and interrupted processes retain their original attempts. Recovery creates a new attempt on the same generation:

```ts
const generation = await userViby.generations.get(generationId);

await generation.retry();  // failed or cancelled generation
await generation.resume(); // interrupted, failed, or cancelled generation
```

`chat.generate` and `version.iterate` remain synchronous convenience methods built on this durable lifecycle.

For request-scoped or horizontally scaled hosts, queue generation in Postgres and run the portable worker loop separately:

```ts
const viby = createViby({
  framework: "farm",
  model,
  skills,
  generation: { execution: "worker" },
});

const worker = viby.worker({
  id: process.env.WORKER_ID!,
  concurrency: 4,
});

await worker.run({ signal: shutdownSignal });
```

`worker.runOnce()` processes at most one available attempt, which is useful for cron jobs and host-owned workflow systems. Viby claims work with Postgres row locks, expiring leases, and periodic heartbeats; no queue, runtime, or deployment vendor is required. Claims are filtered by the configured framework and model. Lease tokens fence streamed events, skill attachment, task pauses, failures, and final version commits, so a stale worker cannot write after another worker reclaims an expired attempt. Delivery is at least once: generated tools and model calls should remain safe to retry around a process crash.

## Resolve typed tasks

A generation can pause when it genuinely requires plan approval, critical information, or permission for a sensitive action. `wait` returns the typed pending task instead of losing the model state:

```ts
const outcome = await generation.wait();

if (outcome.status === "waiting") {
  const task = outcome.tasks[0];

  if (task?.kind === "question") {
    await generation.resolve({
      taskId: task.id,
      resolution: {
        kind: "question",
        answer: "Use our existing Postgres database",
      },
    });
  }
}
```

Plan resolutions use `approve` or `revise`; permission resolutions use `allow` or `deny`. Permission tasks created by the default sandbox agent also carry the exact secret-free `proposedAction`. Resolution starts a new durable attempt, and the complete task history remains available through `generation.tasks()`.

## Download framework source

```ts
const download = await version.download();

return download.toResponse();
```

Or consume the portable artifact directly:

```ts
download.filename;
download.contentType;
download.bytes;
```

The ZIP is the raw framework-native source project. It contains no deployment vendor configuration, credentials, dependency folders, or build output.

## Resume history

```ts
const chat = await userViby.chats.get(chatId);
const latest = await chat.latestVersion();
const messages = await chat.listMessages({ limit: 20 });
const message = await chat.getMessage(messages.items[0]!.id);
const versions = await chat.listVersions({ limit: 20 });

const nextMessages = messages.nextCursor
  ? await chat.listMessages({ after: messages.nextCursor, limit: 20 })
  : null;
```

Chat metadata is application-defined JSON and can store product state such as favorites, tags, or workspace references:

```ts
const updated = await chat.update({
  title: "Customer analytics",
  metadata: { favorite: true, workspaceId: "workspace_123" },
});

const workspaceChats = await userViby.chats.list({
  metadata: { workspaceId: "workspace_123" },
  limit: 20,
});
```

Metadata filters use JSON containment, including nested objects and array members, and are applied before pagination. Pagination cursors are opaque and stable for the resource ordering. Reuse the same filter with later cursors. All reads and writes remain constrained by both `tenantId` and `userId`.

Delete a chat without making recovery or data-retention behavior implicit:

```ts
const deletion = await chat.delete(); // uses retention.deletedChatsMs
await userViby.chats.restore(deletion.chatId); // only before purgeAfter

await chat.delete({ retentionMs: 0 });
const purged = await userViby.chats.purgeDeleted({ limit: 100 });
```

Deleted chats disappear from normal reads immediately. The default retention is 30 days; set `deletedChatsMs: null` (or `retentionMs: null` for one deletion) to retain a tombstone indefinitely. A value of `0` makes it eligible for immediate purge. Deletion refuses chats with queued, running, or waiting generations, so cancel or resolve active work first. `purgeDeleted` is an explicit, tenant-scoped maintenance primitive suitable for the host application's cron or worker and relies on database cascades for permanent removal.

## Render typed message parts

Every message retains its plain `content` for simple transcripts and also exposes ordered, discriminated `parts` for richer agent interfaces:

```ts
const { items: messages } = await chat.listMessages();

for (const message of messages) {
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        console.log(part.data.text);
        break;
      case "file-edit":
        console.log(part.data.operation);
        break;
      case "usage":
        console.log(part.data.totalTokens);
        break;
    }
  }
}
```

The durable part types are `text`, `status`, `reasoning-summary`, `file-read`, `file-edit`, `search`, `command`, `tool-call`, `error`, and `usage`. Each part is linked to its message and, when applicable, the logical generation and immutable attempt. `reasoning-summary` is provider-safe summary text; Viby does not expose or promise hidden model reasoning.

## Skill categories

Built-in categories are `core`, `product`, `design`, `frontend`, `backend`, `data`, `ai`, `testing`, `security`, `accessibility`, `performance`, and `delivery`. Custom category names are accepted.

`core` and `frontend` are active for every project generation. Other categories are selected from the current request. Viby snapshots the exact resolved skill files and content hash used by each generation.

Remote skills are untrusted instructions. Review them before use and pin your application dependencies. Viby limits skill files and sizes, snapshots their content, and never passes model-provider credentials into skill instructions.

## Database commands

```bash
npx viby db status
npx viby db migrate
```

Migrations use a Postgres advisory lock and run transactionally. Viby never silently migrates production during an application request.

## Current boundary

Included now:

- AI SDK model injection
- categorized local and skills.sh-compatible skills
- tenant- and user-scoped Postgres persistence
- Viby-owned migrations
- chats and messages
- ordered typed message parts with generation and attempt ownership
- asynchronous generation handles
- resumable event cursors and streamed output deltas
- resumable started, delta, completed, and failed agent trace events
- provider-neutral typed tool calls, results, secret redaction, and external-effect idempotency
- cancellation, retry, and process recovery
- embedded or durable generation-worker execution with fenced leases and heartbeats
- immutable attempt history and usage
- typed plan, question, and permission tasks
- immutable versions and iteration
- portable agent workspace tools and durable immutable change sets
- a bounded default workspace agent with capability-gated sandbox tools
- raw source ZIP downloads
- sandboxed execution, durable leases, and preview URLs when an adapter supports them
- enforced provider-neutral sandbox command authorization
- durable approval-gated sandbox actions with exact-action, idempotent resume

Planned as separate capabilities later:

- deployment presets and provider connections
- GitHub export and pull requests
- managed Viby infrastructure

## Development

```bash
npm ci
npm run check
npm run test:package
```

Run the [persistent OpenAI example](./examples/basic) to exercise chat creation, generation, optional iteration, Postgres reload, and source download end to end.

The CI workflow tests supported Node releases, the compiled package and CLI, the example's public types, and a durable lifecycle against PostgreSQL. See [RELEASING.md](./RELEASING.md) for versioning commands and the [npm publishing guide](./docs/publishing.md) for trusted-publisher setup.

## License

MIT
