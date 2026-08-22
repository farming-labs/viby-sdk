---
title: "Client and configuration"
description: "Configure Viby, bind application identity, choose execution, and close resources safely."
---

# Client and configuration

`createViby()` creates the long-lived server-side SDK client. Configure infrastructure once, then
derive a tenant/user-scoped client for each authenticated operation.

## `createViby(config)`

```ts
import { createViby } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";

const viby = createViby({
  framework: "farmjs",
  model: openai("your-model-id"),
  storage: {
    // Omit database to use DATABASE_URL.
    artifacts,
    connections,
    secrets,
  },
  skills: {
    design: ["farming-labs/design-engineer"],
  },
});
```

The function validates mutually exclusive configuration, opens the selected storage and adapter
boundaries, and returns `Viby<Framework>`. It does not run database migrations or contact the model.
Configuration failures throw `ConfigurationError` before work begins.

## `VibyConfig`

| Field                      | Type                                    | Behavior                                                                                                                                                          |
| -------------------------- | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `framework`                | `FrameworkId`                           | Required single target string. It is persisted with chats and versions and preserved in the generic return type.                                                  |
| `model`                    | AI SDK `LanguageModel`                  | Convenient default generation path. Mutually exclusive with `engine`.                                                                                             |
| `models`                   | record of `LanguageModel`               | Optional request-selectable aliases. `default` is reserved for the top-level model.                                                                               |
| `engine`                   | `GenerationEngine`                      | Provider-neutral replacement for the default agent/model runtime. Mutually exclusive with `model`.                                                                |
| `engines`                  | record of `GenerationEngine`            | Optional request-selectable engine aliases. `default` is reserved.                                                                                                |
| `storage.database`         | `DatabaseAdapter \| PersistenceAdapter` | Structured durable records. Omit it to open PostgreSQL from `DATABASE_URL`.                                                                                       |
| `storage.artifacts`        | `ArtifactStore`                         | Binary attachments, project entries, generated outputs, screenshots, and prepared deployment archives.                                                            |
| `storage.connections`      | `IntegrationConnectionStore`            | Public provider connection metadata and authorization state. PostgreSQL is the default.                                                                           |
| `storage.secrets`          | `SecretStore`                           | Provider credentials and secret project variables. The default requires `VIBY_SECRET_KEY`.                                                                        |
| `skills`                   | `SkillGroups`                           | Default categorized skill references included in generation configuration.                                                                                        |
| `skillResolver`            | `SkillResolverAdapter`                  | Resolves application-owned catalogs or opaque locators into immutable skill files.                                                                                |
| `tools`                    | `ToolSourcesConfig`                     | Static sources, durable source adapters, selection, and effect policy.                                                                                            |
| `sandbox`                  | `SandboxAdapter`                        | Optional source execution and preview infrastructure.                                                                                                             |
| `sandboxPolicy`            | `SandboxCommandPolicy`                  | Authorizes or rejects normalized commands before any provider sees them.                                                                                          |
| `preview`                  | `PreviewConfig`                         | Framework server command, port, environment, timeout, and readiness behavior.                                                                                     |
| `browser`                  | `BrowserAdapter`                        | Optional browser inspection and visual evaluation boundary.                                                                                                       |
| `environment`              | `EnvironmentConfig`                     | Enables durable per-chat project variables and secret injection.                                                                                                  |
| `integrations`             | `VibyIntegrations`                      | Repository and deployment adapters grouped by capability.                                                                                                         |
| `deployment.preparation`   | `DeploymentPreparationConfig`           | Install/build/output contract for providers that require prebuilt files.                                                                                          |
| `generation.execution`     | `"embedded" \| "worker"`                | Defaults to `embedded`; `worker` leaves new attempts queued.                                                                                                      |
| `generation.quality`       | `GenerationQualityConfig`               | Optional provider-neutral preparation and quality commands that must pass before generated source becomes an immutable version.                                   |
| `generation.workspace`     | `{ preview: "eager" }`                  | Opens the base version in one reusable sandbox while generation runs, emits the preview as soon as it is ready, and hands that workspace to final quality checks. |
| `retention.deletedChatsMs` | `number \| null`                        | Default soft-delete retention. `null` keeps tombstones indefinitely; `0` allows immediate purge.                                                                  |
| `events.sinks`             | `OutboundEventSink[]`                   | Named outbound delivery targets. Delivery is explicit and durable.                                                                                                |
| `telemetry`                | `VibyTelemetry`                         | Provider-neutral spans and metrics. Telemetry failures are fail-open.                                                                                             |
| `cost`                     | `GenerationCostConfig`                  | Host-owned cost calculator stored in integer micro-units.                                                                                                         |

The deprecated top-level `persistence`, `artifactStore`, `connectionStore`, and `secretStore` aliases
remain for compatibility. Do not configure an alias and its corresponding `storage.*` field at the
same time.

## Model or generation engine

Use `model` for the built-in bounded AI SDK agent. Use `engine` when the application supplies its own
agent, orchestration runtime, or model protocol:

```ts
import { defineGenerationEngine } from "@viby/sdk/core";

const engine = defineGenerationEngine({
  id: "company-agent",
  provider: "internal",
  model: "frontend-v3",
  async generate(input, options) {
    return companyAgent.generate(input, options);
  },
});

const viby = createViby({ framework: "farmjs", engine });
```

Concrete provider and model identity are stored on each attempt. Model or engine objects and their
credentials are never persisted.

### Multiple models from one provider

Use `modelsFrom()` when one AI SDK provider instance should expose several models. `default` becomes
the top-level model and the remaining keys become stable aliases accepted by generation requests:

```ts
import { createViby, modelsFrom } from "@viby/sdk";
import { createOpenAI } from "@ai-sdk/openai";

const openai = createOpenAI({ apiKey: process.env.OPENAI_API_KEY });

const viby = createViby({
  framework: "farmjs",
  ...modelsFrom(openai, {
    default: "gpt-5.6-sol",
    terra: "gpt-5.6-terra",
    luna: "gpt-5.6-luna",
    fast: "gpt-5.6-sol-fast",
  }),
});
```

The provider instance still owns authentication, requests, streaming, tools, and usage reporting.
Viby receives ordinary AI SDK `LanguageModel` objects and stores only their provider/model identity
on durable attempts. Pass `model: "terra"` when creating or retrying a generation to select an alias.

The same helper accepts another provider instance without changing Viby configuration:

```ts
import { anthropic } from "@ai-sdk/anthropic";

const claudeModels = modelsFrom(anthropic, {
  default: "claude-sonnet-4-6",
  opus: "claude-opus-4-6",
});
```

Spreading `claudeModels` into `createViby()` makes Sonnet the default and exposes `opus` as a
request alias. Viby invokes the returned AI SDK model objects internally; it does not call the
provider instance through a separate private integration.

## `Viby`

| Member            | Returns                            | Behavior                                                                                                |
| ----------------- | ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `framework`       | `Framework`                        | The configured framework identifier.                                                                    |
| `integrations`    | `IntegrationClient`                | Unscoped callback and adapter-management surface. User operations should use `ScopedViby.integrations`. |
| `toolSources`     | `ToolSourceAuthorizationCallbacks` | Public provider callback completion surface for durable tool registrations.                             |
| `forUser(scope)`  | `ScopedViby`                       | Validates non-empty identity and returns a tenant/user-bound client.                                    |
| `worker(options)` | `GenerationWorker`                 | Creates a durable worker restricted to this client's framework and model/engine identities.             |
| `close(options?)` | `Promise<void>`                    | Aborts local runs and closes owned resources. `preserveSandboxes` keeps durable preview leases running. |

## `ScopedViby`

```ts
const user = viby.forUser({ tenantId, userId });
```

| Property       | Purpose                                                    |
| -------------- | ---------------------------------------------------------- |
| `scope`        | The validated identity pair used by every child operation. |
| `chats`        | Create, import, search, restore, and purge projects.       |
| `generations`  | Rehydrate a durable generation by ID.                      |
| `sandboxes`    | Read and reconnect durable sandbox leases.                 |
| `previews`     | Read, reconnect, stop, list, and clean preview sessions.   |
| `toolSources`  | Manage durable tool-source registrations and connections.  |
| `integrations` | User-scoped repository and deployment providers.           |

Scoped clients are lightweight and do not own independent database connections. A resource outside
the scope resolves to `NotFoundError`.

## `GenerationWorker`

```ts
const worker = viby.worker({
  id: "generation-worker-eu-1",
  concurrency: 4,
  leaseMs: 30_000,
  heartbeatMs: 10_000,
  pollIntervalMs: 500,
});
```

| Member                 | Behavior                                                                             |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `id`                   | Stable host-provided worker identity recorded on claimed attempts.                   |
| `running`              | Reports whether `run()` currently owns its processing loop.                          |
| `runOnce({ signal? })` | Claims and processes at most one eligible attempt; returns whether work was claimed. |
| `run({ signal? })`     | Runs the polling loop until aborted or stopped, respecting configured concurrency.   |
| `stop()`               | Stops accepting work and waits for the active worker loop to settle.                 |

Workers claim with leases and heartbeat while running. Lease tokens fence writes; a stale worker
cannot append output after another worker safely reclaims an expired attempt.

## Shutdown behavior

Call `viby.close()` once per root client. It stops embedded runs, previews, sandboxes, tool sources,
integrations, environment stores, and persistence resources that Viby owns. The host remains
responsible for shutting down its HTTP server, scheduler, telemetry exporter, and application-owned
adapter clients.

Request-scoped durable generation workers can preserve sandbox-backed previews while still closing
their local stores and provider clients:

```ts
await viby.close({ preserveSandboxes: true });
```

Use this only after the worker has handed its sandbox to a durable preview. The default remains
`false`, so normal application shutdown still stops every locally tracked preview and sandbox.
