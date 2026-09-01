---
title: "Shipped capabilities"
description: "The implemented SDK, adapter, integration, verification, and ownership inventory."
---

# Shipped capabilities

This inventory describes the current `@viby/sdk` source on `main`. “Shipped” means an implemented, typed contract with automated coverage. It does not mean Viby hosts the resource or owns its credentials.

## Foundation and ownership

| Capability | Surface | Ownership |
| --- | --- | --- |
| Framework-neutral project target | one `framework` string; typed built-ins, custom values, and automatic immutable framework skills | host selects; package skills cover common frameworks and host skills extend or define custom targets |
| Runtime-neutral core | `@viby/sdk/core` with Web-standard contracts and helpers; Node and provider adapters use explicit subpaths | portable consumers do not load filesystem, process, crypto, migrations, Docker, or database clients |
| Model selection | any AI SDK `LanguageModel` | host configures and owns provider credentials |
| Generation engine | capability-discovered provider-neutral replacement boundary, stable durable run identity, lifecycle cleanup, and conformance suite | Viby owns the default model harness; advanced hosts may replace execution with another agent, model runtime, or orchestrator while Viby retains durable lifecycle and source history |
| Categorized skills | skills.sh slugs, `skillRead(...)` directories, inline snapshots, and provider-neutral resolvers | host selects; Viby resolves and snapshots exact content |
| Categorized storage | `storage.database`, `storage.artifacts`, `storage.connections`, and `storage.secrets`; `DATABASE_URL` remains the PostgreSQL shortcut | host selects each provider-neutral implementation independently |
| Project environments | chat-scoped development, preview, production, and custom variables; public values plus redacted secret metadata | PostgreSQL is the default metadata store; secret bytes stay in `storage.secrets` and resolve only for runtime operations |
| Structured database | provider-neutral database factory or raw `PersistenceAdapter`, PostgreSQL default, embedded SQLite adapter, and conformance suite | host selects its durable implementation; SQLite targets local/single-host use while PostgreSQL remains recommended for multi-service production |
| Binary artifact storage | provider-neutral `ArtifactStore`, conformance suite, filesystem reference adapter, and S3-compatible adapter for AWS S3, R2, MinIO, and compatible stores | host selects storage and owns its credentials; the database keeps metadata and opaque references |
| Tenant isolation | `viby.forUser({ tenantId, userId })` | host authenticates; every Viby query enforces both IDs |
| Viby API key | none | no managed Viby control plane is required |
| Health and diagnostics | typed `viby.health.check()` readiness plus credential-safe, read-only `viby doctor` human and JSON reports | host may add provider-neutral probes; diagnostics never create provider resources or apply migrations |

## Conversations, generation, and source

| Capability | Shipped surface |
| --- | --- |
| Chats | create, import, list, nested metadata filters, get, update, soft delete, restore, and retention-aware purge |
| Messages | cursor pagination, lookup by ID, plain content, assistant finish reasons, ordered typed parts, immutable attributed feedback, reload-safe rating selection, and multidimensional feedback analytics |
| Durable generation | synchronous convenience methods plus addressable async `Generation` handles |
| Read-only inspection | exact-version and latest-version inspect/startInspection methods; durable response messages, events, usage, retry/resume/cancel, read-only tool filtering, and no source-version writes |
| Live updates | persisted event cursors, resumable async iterators, standard SSE, and Web `Response` helpers |
| Recovery | cancel, retry, resume, immutable attempts, failures, and usage |
| Steering | durable queued/applied user instructions, idempotency, attachments, safe-boundary agent consumption, resumable events, Web API, and MCP tool |
| Durable workers | Postgres work claims, leases, heartbeats, fencing, and host-controlled concurrency |
| Blocking work | typed plan, question, and permission tasks with durable resolution |
| Agent trace | started, delta, completed, and failed events on the normal generation cursor |
| Tool records | typed arguments/results, redaction, ownership, status, and external-effect idempotency |
| Durable tool-source registry | tenant/user-scoped provider-neutral registrations, public configuration, adapter materialization, enable/disable/archive lifecycle, explicit per-chat selection, durable authorization connections, immutable generation-time registration snapshots, and an MCP registration adapter |
| Tool-source connections | adapter-owned OAuth/authorization, hashed single-use state, callback substitution protection, refresh/revoke, durable connection metadata, isolated secret-store credentials, and a reusable provider-neutral adapter conformance suite |
| Source import | validated UTF-8 file lists, ZIP archives, and provider-neutral source adapters |
| Source policy | immutable locked files enforced across import, direct edits, model changes, and workspace tools |
| Source history | immutable parent-linked versions, ordered changes, fork, restore, and message lookup |
| Agent workspace | read, search, stage edits, inspect changes, and atomically commit an immutable child version |
| Artifacts | framework-native source ZIP bytes and standard download `Response` |

## Sandboxes and previews

The core contract branches on declared capabilities, never provider names.

| Capability | Shipped surface |
| --- | --- |
| Common adapter | files, commands, output streaming, port URLs, background processes, reconnect, and snapshots |
| Discovery | normalized `SandboxCapabilities` plus `supports(...)` checks |
| Lifecycle | materialize an immutable version, idempotent cleanup, durable leases, and reconnect by lease ID |
| Command safety | provider-neutral allow/deny/approval-required policy with bounded command metadata |
| Agent execution | capability-gated sandbox tools with step, time, token, command, and output budgets |
| Durable version previews | immutable-version materialization, preview-only file overlays, coalesced concurrent starts, live provider-neutral phases and stdout/stderr, tracked server startup, HTTP readiness, persisted URL/status/failure/expiry, reconnect, stop, and expired-session cleanup |
| Conformance | reusable adapter test suite with caller-supplied harmless commands |
| Included adapters | E2B, Vercel Sandbox, local Docker, Daytona, Modal, and Cloudflare Sandbox |

Preview URLs exist only when the configured adapter exposes port URLs and background processes. `version.preview()` starts the configured framework server and persists its lifecycle, but Viby does not promise a globally hosted preview URL. The [reference application](../examples/reference) demonstrates the complete host composition.

## Browser inspection

| Capability | Shipped surface |
| --- | --- |
| Common adapter | provider-neutral browser open/session contract with no driver-specific types |
| Navigation | same-origin-by-default URL resolution with portable load states and timeouts |
| Visual evidence | PNG/JPEG screenshot bytes with validated dimensions and defensive copies |
| Inspection | bounded DOM HTML/text snapshots and normalized console errors |
| Quality | provider-neutral accessibility issue/report vocabulary and readiness checks |
| Conformance | reusable lifecycle suite against a caller-owned reachable page |
| Included adapter | Playwright Chromium/Firefox/WebKit with axe-core accessibility scans and sandbox preview composition |
| Visual workflows | multi-page capture, durable artifact references, configurable rule/model/agent gates, and immutable design-evaluation evidence |

## Integration, delivery, and observability

| Capability | Shipped surface |
| --- | --- |
| Inbound tools | provider-neutral sources, per-chat selection, read/write/external effects, stable idempotency, durable permission tasks, and redacted call records |
| MCP client | Streamable HTTP and custom-transport adapter with per-chat connection isolation; static headers or adapter-resolved credentials remain inside the transport factory |
| MCP server | `registerVibyMcpTools` exposes scoped chats, generations, events, steering, task resolution, versions, iteration, and downloads through the official MCP server SDK |
| Outbound events | signed CloudEvents-style envelopes with stable IDs and constant-time verification |
| Durable delivery | database claims, retry backoff, lease fencing, inspection, dead letters, and explicit redrive |
| HTTP streaming | `Last-Event-ID` parsing, standard SSE frames, request abort propagation, and Web `Response` headers |
| Web API host | authenticated Web Request/Response routing with typed per-operation authorization and admission hooks for product-owned roles, quotas, billing, concurrency, and rate limits; public provider callbacks remain isolated from host sessions |
| API schemas | portable OpenAPI 3.1 builder, complete typed operation inventory, and JSON Schema Draft 2020-12 bundle through `@viby/sdk/schema` |
| Telemetry | provider-neutral hooks plus an OpenTelemetry-compatible tracer/meter adapter |
| Cost attribution | host-defined currency/credit calculator, immutable attempt cost, cumulative generation cost, and usage parts |
| Provider request attribution | durable per-call provider request IDs, routed model identity, outcome, latency, token/cache usage, engine-reported cost estimates, and credential-free metadata |
| Generation configuration | durable per-request model aliases, host instructions, categorized skill overlays, and JSON metadata |
| Multimodal input | immutable attachment bytes in an external artifact store, lightweight PostgreSQL metadata, scoped retrieval, and standard AI SDK file parts |
| Generated artifacts | durable images, audio, video, documents, and binary outputs with ownership, checksums, artifact-store references, and resumable creation events |
| Binary project entries | immutable artifact-backed source paths with scoped external bytes across import, edits, history, sandbox materialization, and ZIP downloads |
| Design evaluation | immutable version-bound rubric results, criterion scores, validated source/attachment/visual-artifact evidence, metadata, and cursor pagination |
| Integration contracts | categorized `integrations.repository` and `integrations.deployment` configuration with provider-neutral authorization, repository, branch, commit, pull-request, project, and deployment adapter types |
| Provider connections | tenant/user-scoped PostgreSQL metadata, hashed single-use authorization state, callback substitution protection, refresh, reconnect, local revocation, and provider selection discovery |
| Integration secrets | standalone secret-store contract plus an AES-256-GCM PostgreSQL default keyed by `VIBY_SECRET_KEY`; credentials never enter normal SDK records |
| Repository workflows | connected provider handles for owners, repositories, branches, source import, complete immutable snapshot pushes, optimistic conflicts, pull requests, and optional merges |
| Repository history | durable chat-to-repository links plus version-bound pending, pushed, conflict, and failed records with commits, pull requests, errors, timestamps, and idempotent replay |
| Repository conformance | reusable disposable-repository suite covering discovery, source round-trips, pushes, stale-head conflicts, and pull requests |
| Included repository adapters | GitHub App installation/user verification and exact Git Data pushes; GitLab OAuth for GitLab.com or self-managed instances with namespace discovery and commit/merge-request APIs; Bitbucket Cloud OAuth with workspace discovery and source commits |
| Deployment workflows | connected provider handles for projects, immutable-version deployment, stable retry idempotency, status lookup, URLs, and optional cancellation |
| Deployment history | durable chat-to-project links, version-bound deployment records, restart-safe idempotency, provider IDs and URLs, failures, and ordered status transitions |
| Deployment preparation | adapter-declared source/prebuilt input; capability-gated sandbox install/build, immutable external build artifact, artifact reuse on retries, and unchanged raw-source downloads |
| Environment injection | explicit sandbox environment selection plus automatic deployment/build selection; values never enter prompts, events, telemetry, histories, or command records |
| Deployment conformance | reusable disposable-project suite covering creation, idempotent deployment, lookup, and cancellation |
| Included deployment adapters | Vercel external-integration authorization with source deployment and cancellation; Cloudflare OAuth with multi-account Pages discovery, Wrangler-compatible prebuilt asset uploads, durable retry recovery, status, and URLs |

Product authentication, provider-app registration, public callback routes, event scheduling, and transport infrastructure remain host-owned. Viby stores tenant-scoped repository, deployment, and tool-source connections plus delivery state, but does not run a hidden queue or scheduler.

## Verification and examples

| Gate | Coverage |
| --- | --- |
| Unit suite | durable generation, source, generation engines, policy, adapters, MCP, SSE, telemetry, cost, delivery, errors, and a published `@viby/sdk/testing` entry point |
| PostgreSQL integration | real migrations plus the complete persisted generation/iteration/download lifecycle |
| Schema upgrade fixture | upgrades a disposable historical `0001`–`0004` database through the current schema and preserves data |
| Migration immutability | published migration SHA-256 checksums; changes require a new migration |
| API compatibility | frozen compile fixture and additive runtime export manifests for package entry points |
| Sandbox integration | shared conformance suite plus a real local Docker integration job |
| Reference E2E | standard API host request-level chat → SSE → preview → iterate → ZIP download through real Viby objects and deterministic adapters |
| Generated-project quality matrix | Farm, TanStack Start, and a custom framework ID across generation, runtime checks, preview HTTP, iteration, evaluation, and ZIP parity |
| Live provider verification | explicit, environment-gated GitHub, GitLab, Bitbucket, Vercel, and Cloudflare tests with disposable resources and failure-safe cleanup |
| Package smoke test | packed artifact install, public import, CLI, and exported subpaths |
| Runtime compatibility | Node 20/22/24, Bun package import, portable dependency-graph guard, and Web Request/Response/streams/crypto behavior |

## Deliberately outside the current release

- managed preview hosting;
- managed authentication, billing, Postgres, workers, queues, secrets, or a Viby API key.

The categorized contracts, durable connection lifecycle, repository orchestration, and deployment orchestration are shipped without pretending that a specific deployment vendor is present. Provider features enter through explicit adapters without weakening the framework-, runtime-, model-, or vendor-neutral boundary.
