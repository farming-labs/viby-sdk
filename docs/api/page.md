---
title: "SDK reference"
description: "The public TypeScript client, lifecycle methods, adapters, errors, and package entry points."
order: 0
---

# SDK reference

The reference is organized around the objects an application uses at runtime. Signatures show the
stable public shape; behavior sections explain durability, scope, side effects, and failure modes.

## Core client

- [Client and configuration](/docs/api/client) — `createViby`, `VibyConfig`, user scope, workers,
  storage, models, skills, and shutdown.
- [Generation engines](/docs/api/generation-engines) — replace the built-in model harness with a
  capability-discovered agent, runtime, or orchestrator while preserving Viby durability.
- [Chats and projects](/docs/api/chats) — create, import, search, update, delete, restore, messages,
  project environments, and history.
- [Message feedback](/docs/api/message-feedback) — durable ratings and product feedback attributed
  to exact assistant messages, attempts, models, and versions.
- [Generations and events](/docs/api/generations) — start, stream, wait, cancel, retry, resume,
  tasks, artifacts, outbound delivery, and workers.
- [Durable webhooks](/docs/api/webhooks) — tenant-managed signed endpoints, persistent delivery
  cursors, retries, dead letters, redrive, and worker ownership.
- [Versions and artifacts](/docs/api/versions) — source inspection, immutable changes, iteration,
  restore, fork, preview, evaluation, push, deploy, and download.

## Optional capabilities

- [Previews and sandboxes](/docs/api/previews) — sessions, leases, command policy, process
  readiness, reconnect, and cleanup.
- [Tool sources](/docs/api/tool-sources) — static tools, durable registrations, per-chat selection,
  authorization, permission policy, and redaction.
- [Integrations](/docs/api/integrations) — provider-neutral repository and deployment connections
  plus durable effect history.

## Hosting and compatibility

- [Web API host](/docs/api-host) — all framework-neutral HTTP routes and the typed Web client.
- [Errors](/docs/api/errors) — stable error families and safe handling guidance.
- [Package entry points](/docs/api/entry-points) — portable core, Node client, providers, optional
  peers, and conformance suites.
- [Complete v1 contract](/docs/api/v1) — normative persistence and lifecycle details in one page.

## Reading the reference

All resource IDs are opaque strings. All timestamps returned by the direct TypeScript client are
`Date` objects. Cursor values are opaque strings and must be stored and returned without parsing.
Methods that contact a model, sandbox, browser, tool server, repository, or deployment provider are
server-side operations unless a product intentionally exposes them through its own authenticated
API.

Every scoped operation enforces both `tenantId` and `userId`; a resource owned by another scope is
reported as not found rather than revealed.
