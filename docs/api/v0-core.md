# v0 API v2 capability audit

This document maps the official v0 Platform API v2 beta surface to Viby as reviewed on 2026-08-08. It is a capability audit, not a wire-compatibility promise and not an instruction to copy v0's hosted architecture.

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
| Tools | Hosted MCP server connections and agent actions | Shipped provider-neutral durable tool calls and source workspace tools plus host-owned connections and credentials |
| Identity | v0 account/team, privacy, and write permissions | Host passes `tenantId` and `userId`; authorization stays app-owned |

v0 v2 removed public version resources. Viby intentionally keeps immutable versions because deterministic downloads, branching, restoration, auditability, and provider-independent source history are core SDK properties. Applications may still present the simpler v0-style model by treating `chat.latestVersion()` as current workspace state.

## Audited v2 resource inventory

The official v2 documentation organizes the API around these resources and endpoint families:

| Resource | Audited surface | Viby disposition |
| --- | --- | --- |
| Chats | create sync/async/streaming; create from files, ZIP, or repository; list, get, update, duplicate, and delete; resume stream | portable chat and generation behavior belongs in core; privacy and hosted URLs are app-owned |
| Chat files | get, update, download, and restore from a message | immutable version files, changes, downloads, and restore are core |
| Preview and deployment | get preview, create Vercel project, deploy chat | preview belongs behind sandbox capability checks; project creation and deployment require future adapters |
| Messages | list, get, send sync/async/streaming, resolve task sync/async/streaming, restore message | portable message history, parts, generation modes, tasks, and restore belong in core |
| MCP servers | list, create, get, update, delete, and OAuth authorization | host-owned connection registry; portable tools may be passed into Viby without Viby owning OAuth |
| Webhooks | list, create, get, update, and delete | optional outbound-event adapter; not required for in-process SDK use |

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
| Per-request system prompt | `systemPrompt` | generation-scoped instruction/skill override | Planned |
| Per-request model options | `modelConfiguration` | generation-scoped AI SDK settings | Planned |
| Per-request skills | remote, memory, and project skills | configured categorized skills and stored snapshots | Partial |
| Attachments and image generation | attachment URLs and image option | portable attachment snapshots and multimodal input | Planned |

Viby does not copy v0's privacy enum, author identity, account URLs, or hosted write-permission field. The embedding application already owns those decisions.

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
| Final text and finish reason | message content and `finishReason` | message content plus attempt finish reason | Partial |
| Token and credit usage | per-message usage | token usage is durable; currency/cost policy is host-owned | Partial |
| Resolve blocking work | Resolve Task sync/async/streaming | typed `generation.resolve` followed by wait or stream | Shipped |
| Restore historical state | Restore Message | `version.restore` | Shipped |

Thinking content must be represented as provider-safe summaries or opaque status metadata. Viby must not promise hidden model reasoning that a provider does not expose.

## Files, versions, and artifacts

| Capability | v0 v2 | Viby-native surface | Status |
| --- | --- | --- | --- |
| Read current files | Get Chat Files | `version.files` | Shipped |
| Add, replace, move, or delete files | Update Chat Files | immutable `version.apply` change set | Shipped |
| Download source ZIP | Download Chat Files | `version.download` | Shipped |
| Restore prior source | Restore Message | `version.restore` | Shipped |
| Branch source history | Duplicate Chat | `version.fork` | Shipped |
| Binary files | base64-encoded chat files | source import supports validated UTF-8 projects; binary artifact policy is planned | Partial |
| Locked files | retained v1 capability and import option | `filePolicy.locked`, per-file import locks, and enforcement across all edit paths | Shipped |
| Incremental agent patches | file-edit message parts | `version.workspace` tools and generated source changes persisted with the materialized snapshot | Shipped |

Downloads remain framework-native source derived from a persisted Viby version. Sandbox images, provider bootstrap files, and deployment output must not silently replace the raw source artifact.

## Sandboxes and previews

v0 v2 makes its VM an implicit property of every chat. Viby keeps execution optional so products can use generation and downloads without buying a sandbox service.

| Capability | v0 v2 | Viby decision | Status |
| --- | --- | --- | --- |
| Isolated execution | VM-backed chat | `SandboxAdapter` selected by the host | Shipped |
| Read/write/run | internal VM tools | common file and command contract | Shipped |
| Live preview | Get Preview URL | sandbox capability plus managed preview session | Partial |
| Preview readiness | nullable preview response and polling | portable port readiness API | Shipped |
| Preview access token | short-lived hosted token | provider or app proxy policy, never a Viby API key | Adapter |
| Long-running process | persistent VM services | provider-neutral background process handle | Shipped |
| Reconnect after host restart | chat VM identity | durable sandbox lease and adapter reconnect | Shipped |
| Screenshot/browser inspection | hosted agent tools | portable host-supplied browser tool | Planned |
| Agent sandbox tools | implicit hosted VM tools | common tools selected strictly from discovered adapter capabilities | Shipped |

## Tools, MCP, webhooks, and integrations

Viby separates a portable tool call from the credentialed connection used to fulfill it.

- Core may define typed tools, calls, results, approval tasks, and durable events.
- Typed calls and results, attempt/message ownership, redaction, and external-effect idempotency are shipped in core.
- The host supplies tool implementations and authorizes each external effect.
- MCP discovery, OAuth grants, refresh tokens, and connection storage remain host-owned.
- Webhook delivery may be implemented by an optional event sink; in-process consumers can read durable generation events directly.
- Deployment and Git provider credentials stay in their future adapters and never enter model context by default.

## Prioritized parity backlog

Capability discovery, the adapter conformance suite, background processes, readiness checks, durable sandbox leases, reconnect-by-ID, generation worker leases with heartbeats, sandbox command policy enforcement, immutable agent workspace change sets, typed durable message parts, and permission-gated agent sandbox actions are shipped.

1. Optional sandbox-backed preview sessions and a host-proxy contract.
2. Attachments, generation-scoped model/skill configuration, file locks, deletion, and outbound event sinks.
3. Explicit Git and deployment adapters after the portable generation workflow is complete.

## Persistence rules

Every portable parity feature follows these rules:

1. Every record is constrained by both `tenantId` and `userId`.
2. A logical generation and immutable attempt exist before model or tool work begins.
3. Work claims, external actions, state transitions, failures, and cancellations are durably auditable.
4. Successful source changes are stored in order and create immutable full snapshots with parent lineage.
5. Exact resolved skills are content-addressed and linked to the generation that used them.
6. Model, sandbox, Git, deployment, and tool credentials are never persisted in the Viby schema.
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
