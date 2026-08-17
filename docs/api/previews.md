---
title: "Previews and sandboxes"
description: "Run immutable source safely with provider-neutral capabilities, policies, leases, and readiness."
---

# Previews and sandboxes

Sandboxes execute one immutable version. Previews add a durable lifecycle around a long-running
sandbox process and its reachable URL.

## Configure a sandbox and preview

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  sandboxPolicy: sandboxCommandPolicy({
    allowCommands: ["npm", "pnpm", "npx"],
    maxTimeoutMs: 120_000,
  }),
  preview: {
    start: { command: "npm", args: ["run", "dev", "--", "--host", "0.0.0.0"] },
    port: 3000,
    environment: "preview",
    readiness: { path: "/", timeoutMs: 60_000 },
  },
});
```

The preview command is framework or product configuration. Viby does not infer package-manager or
framework commands.

## Capability discovery

Every adapter declares the same capability record:

- `files` — materialize and read project files;
- `commands` — run foreground commands;
- `commandStreaming` — emit stdout/stderr while a command runs;
- `portUrls` — resolve an externally reachable URL for a port;
- `backgroundProcesses` — start, wait for, and kill long-running work;
- `reconnect` — restore an adapter instance from a durable provider ID;
- `snapshots` — provider snapshot support where implemented.

Use `session.supports(name)` instead of branching on the provider string.

## `SandboxCollection`

| Method | Behavior |
| --- | --- |
| `get(leaseId)` | Loads one scoped durable lease record. |
| `reconnect(leaseId, options?)` | Validates lease status and provider compatibility, reconnects the instance, and returns `SandboxSession`. |

## `SandboxSession`

| Member | Behavior |
| --- | --- |
| `id` / `provider` / `leaseId` | Provider instance identity, adapter identity, and nullable durable Viby lease. |
| `capabilities` / `supports(name)` | Normalized capability discovery. |
| `stopped` | Whether this session has been stopped locally. |
| `writeFiles(files, options?)` | Writes normalized text or binary paths when file capability exists. |
| `readFile(path, options?)` | Reads one file as `Uint8Array`. |
| `authorizeCommand(command, action?)` | Evaluates policy and returns a grant or throws a typed denial/approval error. |
| `run(command, grant?)` | Executes one bounded foreground command and returns exit code, output, and duration. |
| `start(command, grant?)` | Starts a background process when supported. |
| `url(port)` | Resolves a provider URL when supported. |
| `waitForPort(port, options?)` | Polls readiness with an optional host-supplied check and returns the resolved URL. |
| `stop(options?)` | Idempotently stops the provider instance and closes its durable lease. |

Commands use separate `command` and `args` values. Policy receives the executable, arguments,
working directory, environment variable names, timeout, action, and immutable version context;
secret values are omitted.

## Command policy

Policy returns `allow`, `deny`, or `approval-required`. `sandboxCommandPolicy(options)` is a
convenient allow/deny implementation; applications may supply an async policy backed by their own
authorization system.

`approval-required` throws `SandboxCommandApprovalRequiredError` with a serializable
`proposedAction`. The default agent converts that proposal into a durable permission task. An
approved action key can then be resumed safely without bypassing policy for unrelated commands.

## `PreviewCollection`

| Method | Behavior |
| --- | --- |
| `get(id)` | Loads a scoped preview session. |
| `list({ chatId?, versionId?, status? })` | Filters durable preview records. |
| `cleanupExpired(limit?)` | Stops and marks a bounded set of expired sessions; intended for a host-owned schedule. |

## `Preview`

| Member | Behavior |
| --- | --- |
| `id`, `chatId`, `versionId`, `framework` | Durable ownership and source identity. |
| `status` | `starting`, `ready`, `failed`, `stopped`, or `expired`. |
| `url` | Provider URL when ready, otherwise `null`. |
| `data()` | Returns the complete durable preview record. |
| `reconnect(signal?)` | Reconnects the underlying sandbox, re-runs readiness, and refreshes this handle. A non-aborted readiness failure stops the stale sandbox and persists `failed`. |
| `stop(signal?)` | Idempotently stops the process/sandbox and persists `stopped`. |

Starting a preview materializes source, starts the configured process, obtains a port URL, and waits
for readiness. Any failure is persisted with a safe message before `PreviewError` is thrown.

## Included sandbox adapters

| Entry point | Provider/runtime note |
| --- | --- |
| `@viby/sdk/sandbox/e2b` | E2B sandbox client; optional peer required. |
| `@viby/sdk/sandbox/vercel` | Vercel Sandbox; optional peer required. |
| `@viby/sdk/sandbox/docker` | Local Docker CLI/daemon; intended for trusted local or single-tenant use. |
| `@viby/sdk/sandbox/daytona` | Daytona sandbox client; optional peer required. |
| `@viby/sdk/sandbox/modal` | Modal sandbox client; optional peer required. |
| `@viby/sdk/sandbox/cloudflare` | Cloudflare Worker binding and container runtime; optional peer required. |

Use `@viby/sdk/sandbox/conformance` to verify a custom adapter against the provider-neutral
lifecycle before using it with generated code.
