---
title: "Viby SDK"
description: "Durable, provider-neutral infrastructure for building AI software creation products."
order: 0
---

# Viby SDK

Viby is a TypeScript SDK for products that generate, iterate on, preview, and export software.
It provides the durable product layer around an AI model: scoped chats, resumable generations,
immutable source versions, tool approvals, artifacts, previews, repository workflows, and
deployments.

Your application keeps control of authentication, billing, the product UI, model credentials,
infrastructure accounts, and provider policy. Viby supplies typed orchestration and persistence
without requiring a Viby-hosted control plane or a Viby API key.

## Install

```bash
npm install @viby/sdk ai @ai-sdk/openai
```

Continue with the [Quickstart](/docs/getting-started) to configure PostgreSQL, create the client,
stream a generation, iterate from an immutable version, and download the resulting source.

## Choose a starting point

- [Quickstart](/docs/getting-started) — install Viby, migrate PostgreSQL, generate a project,
  stream progress, iterate, and download the result.
- [Core concepts](/docs/concepts) — understand identity, ownership, immutable versions,
  durability, adapters, and secrets.
- [SDK reference](/docs/api) — browse the public client surface and its runtime behavior.
- [Credentials and provider setup](/docs/credentials) — configure server credentials and
  securely connect user-owned providers.
- [Web API host](/docs/api-host) — expose the same operations through a Web-standard
  `fetch(Request): Promise<Response>` handler.

## The product workflow

1. Bind the SDK to an authenticated tenant and user.
2. Create a chat or import an existing project.
3. Start a durable generation and stream its persisted events.
4. Resolve questions or permissions, then resume without losing history.
5. Inspect, preview, evaluate, or iterate on an immutable version.
6. Download raw framework source, push it to a repository, or deploy it through an adapter.

Every external capability is optional. A product can begin with PostgreSQL and one model, then
add artifact storage, sandboxes, browsers, tool sources, repositories, or deployment providers
without changing the core chat and version contracts.

## What Viby does not own

Viby does not authenticate end users, store model-provider API keys, host a managed database,
run a hidden queue, or promise a global preview URL. Those boundaries remain explicit so a Viby
application can run in its preferred framework, runtime, cloud, and security model.

See the [shipped capability inventory](/docs/capabilities) for the exact implemented surface and
the [complete v1 contract](/docs/api/v1) for normative lifecycle details.
