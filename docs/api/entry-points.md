---
title: "Package entry points"
description: "Choose the portable core, full client, provider adapters, and conformance suites without accidental runtime coupling."
---

# Package entry points

`@viby/sdk` publishes explicit entry points so portable application code does not accidentally load
filesystem, process, PostgreSQL, Docker, browser-driver, or provider SDK dependencies.

## Primary entry points

| Import | Use it for |
| --- | --- |
| `@viby/sdk` | Backward-compatible full Node client, public types, core helpers, and high-level resources. |
| `@viby/sdk/core` | Web-standard contracts and helpers shared with browsers, Workers, Bun, or Node. No Node built-ins are reachable from this graph. |
| `@viby/sdk/node` | Explicit full Node client and Node-owned defaults. Recommended for new server applications. |
| `@viby/sdk/node/migrations` | Programmatic PostgreSQL migration helpers. The `viby db migrate` CLI is the usual deploy-time path. |
| `@viby/sdk/node/skills` | Local filesystem and skills.sh/GitHub skill resolution. |
| `@viby/sdk/package.json` | Package metadata for tooling. |
| `@viby/sdk/testing` | Aggregated provider-neutral conformance suites and deterministic scripted generation fixtures for host tests. |
| `@viby/sdk/schema` | Portable OpenAPI 3.1 builder, complete Web API operation inventory, and JSON Schema Draft 2020-12 bundle. |

The portable core uses Web `Request`, `Response`, `Headers`, `ReadableStream`, `AbortSignal`,
`Uint8Array`, text encoding, structured cloning, and Web Crypto-compatible shapes.
It also includes pure product helpers such as `titleFromPrompt()` that do not require a model or
runtime-specific APIs.

## Storage and persistence

| Import | Exports and behavior |
| --- | --- |
| `@viby/sdk/storage/postgres` | `postgres(...)`, the explicit structured-database adapter using PostgreSQL. |
| `@viby/sdk/persistence` | Provider-neutral durable `PersistenceAdapter` contract. |
| `@viby/sdk/persistence/postgres` | Low-level PostgreSQL persistence implementation. |
| `@viby/sdk/persistence/sqlite` | Embedded SQLite persistence implementation for Node.js 22.5+. |
| `@viby/sdk/persistence/conformance` | Reusable durable adapter lifecycle and isolation tests. |
| `@viby/sdk/artifact/filesystem` | Local filesystem artifact store for development and single-host deployments. |
| `@viby/sdk/storage/s3` | S3-compatible artifact store for AWS S3, Cloudflare R2, MinIO, and compatible services. |
| `@viby/sdk/artifact/s3` | Alias of the same S3-compatible artifact adapter. |
| `@viby/sdk/artifact/conformance` | Reusable artifact-store immutability, checksum, scope, and deletion tests. |
| `@viby/sdk/environment/postgres` | PostgreSQL project-environment metadata store. Secret bytes still use `SecretStore`. |
| `@viby/sdk/storage/sqlite` | Categorized embedded SQLite database factory for local, desktop, example, and test hosts. |

The S3 adapter requires optional peer `@aws-sdk/client-s3`.

## Sandboxes

| Import | Optional peer / environment |
| --- | --- |
| `@viby/sdk/sandbox/e2b` | `e2b` |
| `@viby/sdk/sandbox/vercel` | `@vercel/sandbox` |
| `@viby/sdk/sandbox/docker` | Docker CLI and daemon |
| `@viby/sdk/sandbox/daytona` | `@daytona/sdk` |
| `@viby/sdk/sandbox/modal` | `modal` |
| `@viby/sdk/sandbox/cloudflare` | `@cloudflare/sandbox` and configured Worker bindings |
| `@viby/sdk/sandbox/conformance` | No provider peer; pass a caller-owned disposable adapter fixture. |

Provider SDK types stay inside their adapter configuration and never enter `SandboxAdapter`.

## Browser and generation conformance

| Import | Use it for |
| --- | --- |
| `@viby/sdk/browser/playwright` | Playwright browser adapter with screenshot, DOM, console, readiness, and accessibility support. |
| `@viby/sdk/browser/conformance` | Reusable browser lifecycle and normalized-result tests. |
| `@viby/sdk/generation/conformance` | Reusable conformance checks for custom provider-neutral generation engines. |

The Playwright adapter requires `playwright`; accessibility scans additionally use optional
`@axe-core/playwright`.

## Testing hosts and adapters

`@viby/sdk/testing` collects every public conformance suite behind one stable import and includes a
queue-driven engine for deterministic API, worker, and UI tests:

```ts
import {
  createScriptedGenerationEngine,
  verifyPersistenceAdapter,
  verifySandboxAdapter,
} from "@viby/sdk/testing";

const scripted = createScriptedGenerationEngine({
  steps: [{ kind: "project", title, summary, files, usage, finishReason: "stop" }],
});

const viby = createViby({
  framework: "farmjs",
  generation: { engine: scripted.engine },
});
```

Each call consumes exactly one step. An unexpected extra attempt throws
`ScriptedGenerationEngineExhaustedError` instead of inventing fallback output. `calls`, `remaining`,
`enqueue()`, and `clear()` let tests assert retries and prepare later outcomes. Conformance suites may
create external disposable resources; use dedicated test accounts and provider cleanup hooks.

## Integration entry points

| Import | Use it for |
| --- | --- |
| `@viby/sdk/integrations/postgres` | PostgreSQL connection metadata and encrypted secret-store defaults. |
| `@viby/sdk/integrations/conformance` | Connection-store and authorization lifecycle conformance. |
| `@viby/sdk/integrations/repository/conformance` | Disposable repository discovery, source, push, conflict, and PR tests. |
| `@viby/sdk/integrations/deployment/conformance` | Disposable project create, deploy, lookup, idempotency, and cancellation tests. |
| `@viby/sdk/integrations/github` | GitHub repository adapter. |
| `@viby/sdk/integrations/bitbucket` | Bitbucket Cloud repository adapter. |
| `@viby/sdk/integrations/gitlab` | GitLab.com and self-managed GitLab repository adapter. |
| `@viby/sdk/integrations/vercel` | Vercel deployment adapter. |
| `@viby/sdk/integrations/cloudflare` | Cloudflare Pages deployment adapter. |

## MCP entry points

| Import | Direction |
| --- | --- |
| `@viby/sdk/tools/mcp` | Consumes host-configured MCP servers as generation tool sources. Requires optional `@modelcontextprotocol/client`. |
| `@viby/sdk/mcp` | Exposes a supplied `ScopedViby` as MCP server tools. Requires optional `@modelcontextprotocol/server`. |

## Runtime rules

- Import types and Web helpers from `@viby/sdk/core` in portable/shared modules.
- Import the full client from `@viby/sdk/node` in new Node-only server code.
- Import providers only from their explicit subpaths.
- Install optional peers only for adapters the application actually configures.
- Do not deep-import files under `dist`; they are not part of the compatibility contract.
- Run the relevant conformance suite for every custom adapter implementation.

See [Runtime boundaries](/docs/runtime) for compatibility gates and supported runtimes.
