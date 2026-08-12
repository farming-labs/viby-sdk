# v0 API v2 capability audit

This document maps the official v0 Platform API v2 beta surface to Viby as reviewed on 2026-08-12. It is a capability audit, not a wire-compatibility promise and not an instruction to copy v0's hosted architecture.

Viby remains framework-, model-, runtime-, storage-, and provider-agnostic. A capability belongs in core only when it is portable across those boundaries. Hosted URLs, credentials, deployment vendors, OAuth connections, and account policy remain application-owned or adapter-owned.

Status meanings:

- **Shipped**: implemented and covered by the current Viby contract.
- **Partial**: the durable primitive exists, but the complete product-facing capability does not.
- **Planned**: portable and appropriate for Viby core, but not implemented yet.
- **Adapter**: belongs behind an explicit provider-neutral adapter.
- **App-owned**: belongs to the product embedding Viby.
- **Excluded**: tied to v0's hosted account or a specific third party.

## Architectural comparison

| Concern | v0 API v2 | Viby decision |
| --- | --- | --- |
| Primary state | A VM-backed chat is the current mutable workspace | A chat owns immutable, parent-linked source versions; keep this stronger history model |
| Conversation history | Messages contain ordered agent-trace parts | Portable typed message parts plus durable generation events |
| Generation modes | Separate sync, async, and SSE endpoints | Keep `generate`, `start`/`wait`, and resumable `stream` methods over one durable generation |
| Source state | Read, replace, download, and restore current chat files | Read, change, download, fork, and restore immutable versions |
| Preview | Hosted VM preview with a short-lived access token | Optional sandbox-backed preview session; never guaranteed by core |
| Deployment | Creates and deploys a Vercel project | Future deployment adapter; no vendor identifiers in core records |
| Tools | Hosted MCP server connections and agent actions | Shipped provider-neutral durable tool sources, per-chat selection, permission policy, source workspace tools, and host-owned credentials |
| Identity | v0 account/team, privacy, and write permissions | Host passes `tenantId` and `userId`; authorization stays app-owned |

v0 v2 removed public version resources. Viby intentionally keeps immutable versions because deterministic downloads, branching, restoration, auditability, and provider-independent source history are core SDK properties. Applications may still present the simpler v0-style model by treating `chat.latestVersion()` as current workspace state.

## Audited v2 resource inventory

The official v2 documentation organizes the API around these resources and endpoint families:

| Resource | Audited surface | Viby disposition |
| --- | --- | --- |
| Chats | create sync/async/streaming; create from files, ZIP, or repository; list, get, update, duplicate, and delete; resume stream | portable chat and generation behavior belongs in core; privacy and hosted URLs are app-owned |
| Chat files | get, update, download, and restore from a message | immutable version files, changes, downloads, and restore are core |
| Preview and deployment | get preview, create Vercel project, deploy chat | preview belongs behind sandbox capability checks; provider-neutral project and deployment workflows ship with Vercel and Cloudflare adapters |
| Messages | list, get, send sync/async/streaming, resolve task sync/async/streaming, restore message | portable message history, parts, generation modes, tasks, and restore belong in core |
| MCP servers | list, create, get, update, delete, and OAuth authorization | shipped inbound MCP client adapter with host-owned catalog and OAuth lifecycle; outbound Viby MCP server adapter |
| Webhooks | list, create, get, update, and delete | signed provider-neutral event sinks over the durable cursor; endpoint registry remains app-owned |

## Chats and generation

| Capability | v0 v2 | Viby-native surface | Status |
| --- | --- | --- | --- |
| Create and generate | Create Chat | `chats.create` then `chat.generate` | Shipped |
| Create in background | Create Chat Async | `chat.start` and `generation.wait` | Shipped |
| Create with live updates | Create Chat Streaming | `generation.stream({ after })` | Shipped |
| Create from files | Create Chat From Files | `chats.import({ source: { type: "files" } })` | Shipped |
| Create from ZIP | Create Chat From ZIP | `chats.import({ source: { type: "zip" } })` | Shipped |
| Create from repository | Create Chat From Repository | typed provider-neutral source import adapter | Shipped |
| List and filter chats | List Chats, including metadata filters | `chats.list({ limit, after, metadata })` | Shipped |
| Get one chat | Get Chat | `chats.get(id)` | Shipped |
| Update title and metadata | Update Chat | `chat.update` | Shipped |
| Privacy and write permission | Chat privacy fields | host authorization and metadata | App-owned |
| Duplicate current workspace | Duplicate Chat | `version.fork` | Shipped |
| Delete a chat | Delete Chat | `chat.delete`, time-bounded restore, and explicit batched purge | Shipped |
| Stop work | stop/cancel active agent work | `generation.cancel` | Shipped |
| Resume interrupted work | Resume Chat Stream and async task continuation | event cursor plus `generation.resume` | Shipped |
| Per-request system prompt | `systemPrompt` | durable generation-scoped instructions | Shipped |
| Per-request model options | `modelConfiguration` | stable configured model aliases with persisted provider/model identity | Shipped |
| Per-request skills | remote, memory, and project skills | durable categorized overrides plus stored resolved snapshots | Shipped |
| Attachments and image generation | attachment URLs and image option | immutable input snapshots, AI SDK multimodal file parts, and durable generated images or other binary outputs in a provider-neutral artifact store | Shipped |

Viby does not copy v0's privacy enum, author identity, account URLs, or hosted write-permission field. The embedding application already owns those decisions.

The top-level `model` remains the convenient AI SDK path. Products with their own agent, model runtime, or orchestration system can instead provide a public `GenerationEngine`; durable attempts and worker routing use its stable provider/model identity, and the reusable conformance suite verifies portable outputs and cancellation.

## Messages and agent trace

v0 v2 messages contain ordered parts such as text, thinking, file reads, file edits, searches, shell commands, tool calls, and agent actions. Viby persists a provider-neutral discriminated union for the durable result narrative plus resumable part lifecycle events for rendering live trace progress.

| Capability | v0 v2 | Viby-native surface | Status |
| --- | --- | --- | --- |
| List messages | Get Messages | `chat.listMessages` | Shipped |
| Get one message | Get Message | `chat.getMessage(id)` | Shipped |
| Send sync | Send Message | `chat.generate` or `version.iterate` | Shipped |
| Send async | Send Message Async | `chat.start` or `version.startIteration` | Shipped |
| Send streaming | Send Message Streaming | `generation.stream` | Shipped |
| Ordered message parts | `Message.parts` | typed durable agent parts linked to messages, generations, and attempts | Shipped |
| Live part lifecycle | streaming message part events | started, delta, completed, and failed events on the durable generation cursor | Shipped |
| Final text and finish reason | message content and `finishReason` | message content plus an immutable assistant-message finish reason | Shipped |
| Token and credit usage | per-message usage | durable token usage plus host-defined immutable attempt and cumulative generation cost | Shipped |
| Resolve blocking work | Resolve Task sync/async/streaming | typed `generation.resolve` followed by wait or stream | Shipped |
| Restore historical state | Restore Message | `version.restore` | Shipped |

Thinking content must be represented as provider-safe summaries or opaque status metadata. Viby must not promise hidden model reasoning that a provider does not expose.

## Files, versions, and artifacts

| Capability | v0 v2 | Viby-native surface | Status |
| --- | --- | --- | --- |
| Read current files | Get Chat Files | `version.entries` (complete) and compatible text-only `version.files` | Shipped |
| Add, replace, move, or delete files | Update Chat Files | immutable `version.apply` change set | Shipped |
| Download source ZIP | Download Chat Files | `version.download` | Shipped |
| Restore prior source | Restore Message | `version.restore` | Shipped |
| Branch source history | Duplicate Chat | `version.fork` | Shipped |
| Binary files | base64-encoded chat files | artifact-backed version entries with external bytes, durable metadata, scoped retrieval, history, ZIP, and sandbox materialization | Shipped |
| Locked files | retained v1 capability and import option | `filePolicy.locked`, per-file import locks, and enforcement across all edit paths | Shipped |
| Incremental agent patches | file-edit message parts | `version.workspace` tools and generated source changes persisted with the materialized snapshot | Shipped |

Downloads remain framework-native source derived from a persisted Viby version. Sandbox images, provider bootstrap files, and deployment output must not silently replace the raw source artifact.

## Sandboxes and previews

v0 v2 makes its VM an implicit property of every chat. Viby keeps execution optional so products can use generation and downloads without buying a sandbox service.

| Capability | v0 v2 | Viby decision | Status |
| --- | --- | --- | --- |
| Isolated execution | VM-backed chat | `SandboxAdapter` selected by the host | Shipped |
| Read/write/run | internal VM tools | common file and command contract | Shipped |
| Live preview | Get Preview URL | sandbox background process and port readiness primitives plus a complete reference host | Shipped |
| Preview readiness | nullable preview response and polling | portable port readiness API | Shipped |
| Preview access token | short-lived hosted token | provider or app proxy policy, never a Viby API key | Adapter |
| Long-running process | persistent VM services | provider-neutral background process handle | Shipped |
| Reconnect after host restart | chat VM identity | durable sandbox lease and adapter reconnect | Shipped |
| Screenshot/browser inspection | hosted agent tools | provider-neutral navigation, readiness, screenshots, DOM inspection, console errors, and accessibility checks | Shipped |
| Agent sandbox tools | implicit hosted VM tools | common tools selected strictly from discovered adapter capabilities | Shipped |

## Tools, MCP, webhooks, and integrations

Viby separates a portable tool call from the credentialed connection used to fulfill it.

- Core may define typed tools, calls, results, approval tasks, and durable events.
- Typed calls and results, attempt/message ownership, redaction, and external-effect idempotency are shipped in core.
- The host supplies tool sources, per-chat selection, and policy; Viby durably gates, records, and idempotently resumes external effects.
- The MCP client adapter supports Streamable HTTP and custom transports while resolving credentials inside transport factories. Discovery registries, OAuth grants, refresh tokens, and connection storage remain host-owned.
- Viby operations can also be registered as scoped MCP server tools.
- Signed event sinks ship durable generation events through an app-owned transport with stable IDs, HMAC verification, leases, retries, dead letters, and redrive; endpoint CRUD and scheduling remain app-owned.
- Deployment and Git provider credentials stay behind the explicit connection and secret-store boundary and never enter model context by default.
- Project environment variables use a provider-neutral metadata store plus the same isolated secret-store boundary. Secret values resolve only for an explicitly selected sandbox/build/deployment environment.
- The Web-standard API host maps authenticated `Request` objects to chats, messages, generations, resumable streams, tasks, versions, downloads, callbacks, and host-owned previews without framework-specific route types.

## Prioritized parity backlog

Capability discovery, the adapter conformance suite, background processes, readiness checks, durable sandbox leases, reconnect-by-ID, generation worker leases with heartbeats, sandbox command policy enforcement, immutable agent workspace change sets, typed durable message parts, permission-gated agent actions, inbound MCP sources, source import adapters, file locks, retention-aware deletion, standard SSE/Web responses, the Web API host, scoped MCP server tools, durable signed outbound delivery, OpenTelemetry hooks, and cost attribution are shipped.

Generation-scoped model/skill configuration, durable multimodal input snapshots and outputs, and immutable design evaluation results are shipped.

Visual evaluation workflows are shipped on the provider-neutral browser contract. They capture one or more preview routes, persist screenshot bytes outside PostgreSQL, and link the durable artifact references to immutable design evaluations. Quality gates are callbacks, so products can use rules, visual regression, any model runtime, or their own agent without a hard-coded design model.

Persistence is also provider-neutral: `DATABASE_URL` selects the built-in PostgreSQL implementation, while `persistence` accepts a host-owned durable adapter verified by the reusable conformance suite. Custom adapters retain responsibility for their own transactions, migrations, credentials, and binary-store integration.

GitHub, Bitbucket, Vercel, and Cloudflare adapters are shipped behind their provider-neutral capability contracts. Deployment preparation is also provider-neutral: adapters declare source or prebuilt input, any configured sandbox executes the host's framework build contract, and immutable output lives in the configured artifact store while raw downloads remain unchanged. Durable project environments are shipped with public metadata, isolated secret bytes, explicit sandbox selection, and automatic deployment/build selection. The remaining backlog is additional opt-in providers; no vendor identifier is required by the core SDK.

## Persistence rules

Every portable parity feature follows these rules:

1. Every record is constrained by both `tenantId` and `userId`.
2. A logical generation and immutable attempt exist before model or tool work begins.
3. Work claims, external actions, state transitions, failures, and cancellations are durably auditable.
4. Successful source changes are stored in order and create immutable full snapshots with parent lineage.
5. Exact resolved skills are content-addressed and linked to the generation that used them.
6. Model, sandbox, and tool credentials never enter ordinary Viby records. Integration credentials and project secret values exist only through the explicit secret-store boundary; the PostgreSQL reference encrypts them with a caller-owned key and ordinary records retain only opaque references.
7. Provider-specific capabilities are discovered explicitly and never inferred from a provider name.
8. Framework behavior comes from source and skills, not a hard-coded framework registry.

## Audited official sources

- [Platform API v2 migration guide](https://v0.app/docs/api/v2/guides/migrating-from-v1-to-v2)
- [Create Chat From Files](https://v0.app/docs/api/v2/reference/chats/create-chat-from-files)
- [Get Chat Files](https://v0.app/docs/api/v2/reference/chats/get-chat-files)
- [Duplicate Chat](https://v0.app/docs/api/v2/reference/chats/duplicate-chat)
- [Get Message](https://v0.app/docs/api/v2/reference/messages/get-message)
- [Send Message](https://v0.app/docs/api/v2/reference/messages/send-message)
- [Resolve Task Streaming](https://v0.app/docs/api/v2/reference/messages/resolve-task-streaming)
- [Accessing Previews](https://v0.app/docs/api/v2/guides/accessing-previews)
- [Handling Integrations](https://v0.app/docs/api/v2/guides/handling-integrations)
- [v0 MCP Server](https://v0.app/docs/api/v2/guides/mcp-server)
- [List Webhooks](https://v0.app/docs/api/v2/reference/webhooks/list-webhooks)

API v2 is explicitly beta. Future audits should record the review date and treat breaking v0 changes as reference updates, not automatic Viby contract changes.
