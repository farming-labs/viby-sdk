# Shipped capability inventory

This inventory describes the current `@viby/sdk` source on `main`. “Shipped” means an implemented, typed contract with automated coverage. It does not mean Viby hosts the resource or owns its credentials.

## Foundation and ownership

| Capability | Surface | Ownership |
| --- | --- | --- |
| Framework-neutral project target | one `framework` string, including custom values | host selects; skills and prompts teach framework behavior |
| Model selection | any AI SDK `LanguageModel` | host configures and owns provider credentials |
| Generation engine | public provider-neutral engine plus conformance suite | host may replace the AI SDK shortcut with any agent, model runtime, or orchestrator |
| Categorized skills | skills.sh slugs and `skillRead(...)` directories | host selects; Viby resolves and snapshots exact content |
| Durable persistence | provider-neutral `PersistenceAdapter` and conformance suite; `DATABASE_URL` remains the PostgreSQL default | host may provide another durable implementation and owns its credentials and migrations |
| Binary artifact storage | provider-neutral `ArtifactStore`, conformance suite, and filesystem reference adapter | host selects storage and owns its credentials; PostgreSQL keeps metadata and opaque references |
| Tenant isolation | `viby.forUser({ tenantId, userId })` | host authenticates; every Viby query enforces both IDs |
| Viby API key | none | no managed Viby control plane is required |

## Conversations, generation, and source

| Capability | Shipped surface |
| --- | --- |
| Chats | create, import, list, nested metadata filters, get, update, soft delete, restore, and retention-aware purge |
| Messages | cursor pagination, lookup by ID, plain content, and ordered typed parts |
| Durable generation | synchronous convenience methods plus addressable async `Generation` handles |
| Live updates | persisted event cursors, resumable async iterators, standard SSE, and Web `Response` helpers |
| Recovery | cancel, retry, resume, immutable attempts, failures, and usage |
| Durable workers | Postgres work claims, leases, heartbeats, fencing, and host-controlled concurrency |
| Blocking work | typed plan, question, and permission tasks with durable resolution |
| Agent trace | started, delta, completed, and failed events on the normal generation cursor |
| Tool records | typed arguments/results, redaction, ownership, status, and external-effect idempotency |
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
| Background preview | tracked process handles plus portable HTTP readiness checks |
| Conformance | reusable adapter test suite with caller-supplied harmless commands |
| Included adapters | E2B, Vercel Sandbox, local Docker, Daytona, Modal, and Cloudflare Sandbox |

Preview URLs exist only when the configured adapter exposes port URLs and the host starts a server. Viby does not promise a globally hosted preview URL. The [reference application](../examples/reference) demonstrates the complete host composition.

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

## Integration, delivery, and observability

| Capability | Shipped surface |
| --- | --- |
| MCP | `registerVibyMcpTools` exposes scoped chats, generations, events, task resolution, versions, iteration, and downloads through the official MCP server SDK |
| Outbound events | signed CloudEvents-style envelopes with stable IDs and constant-time verification |
| Durable delivery | database claims, retry backoff, lease fencing, inspection, dead letters, and explicit redrive |
| HTTP streaming | `Last-Event-ID` parsing, standard SSE frames, request abort propagation, and Web `Response` headers |
| Telemetry | provider-neutral hooks plus an OpenTelemetry-compatible tracer/meter adapter |
| Cost attribution | host-defined currency/credit calculator, immutable attempt cost, cumulative generation cost, and usage parts |
| Generation configuration | durable per-request model aliases, host instructions, categorized skill overlays, and JSON metadata |
| Multimodal input | immutable attachment bytes in an external artifact store, lightweight PostgreSQL metadata, scoped retrieval, and standard AI SDK file parts |
| Generated artifacts | durable images, audio, video, documents, and binary outputs with ownership, checksums, artifact-store references, and resumable creation events |
| Design evaluation | immutable version-bound rubric results, criterion scores, validated evidence references, metadata, and cursor pagination |

Authentication, OAuth connection registries, event scheduling, and transport infrastructure remain host-owned. Viby stores delivery state but does not run a hidden queue or scheduler.

## Verification and examples

| Gate | Coverage |
| --- | --- |
| Unit suite | durable generation, source, agents, policy, adapters, MCP, SSE, telemetry, cost, delivery, and errors |
| PostgreSQL integration | real migrations plus the complete persisted generation/iteration/download lifecycle |
| Schema upgrade fixture | upgrades a disposable historical `0001`–`0004` database through the current schema and preserves data |
| Migration immutability | published migration SHA-256 checksums; changes require a new migration |
| API compatibility | frozen compile fixture and additive runtime export manifests for package entry points |
| Sandbox integration | shared conformance suite plus a real local Docker integration job |
| Reference E2E | request-level chat → SSE → preview → iterate → ZIP download through real Viby objects and deterministic adapters |
| Generated-project quality matrix | Farm, TanStack Start, and a custom framework ID across generation, runtime checks, preview HTTP, iteration, evaluation, and ZIP parity |
| Package smoke test | packed artifact install, public import, CLI, and exported subpaths |

## Deliberately outside the current release

- Git repository push, branch, commit, and pull-request adapters;
- deployment adapters, provider connections, and managed preview hosting;
- managed authentication, billing, Postgres, workers, queues, secrets, or a Viby API key.

These are absent contracts, not runtime stubs. Future provider features should enter through portable core interfaces and explicit adapters without weakening the framework-, runtime-, model-, or vendor-neutral boundary.
