---
title: "Viby SDK"
description: "Framework-neutral infrastructure for persistent, skill-guided vibe coding products."
order: 0
---

# Viby SDK

Viby is a framework-neutral TypeScript SDK for building vibe coding products. Your application
owns authentication, model credentials, UI, and product policy. Viby owns the durable generation
workflow, immutable source history, typed tasks, portable adapters, and source downloads.

## Install

```bash
npm install @viby/sdk ai
```

Set a Postgres connection, run the Viby migrations, and provide the AI SDK model you want to use:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/viby
npx viby db migrate
```

```ts
import { createViby } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";

export const viby = createViby({
  framework: "farmjs",
  model: openai("your-model-id"),
  skills: {
    frontend: ["farming-labs/design-engineer"],
  },
});
```

## Start with these guides

- [Shipped capabilities](/docs/capabilities) — the current core, adapter, integration, and
  verification inventory.
- [Credentials and provider setup](/docs/credentials) — create server credentials, connect
  user-owned providers, and verify the secure callback flow.
- [Viby API v1](/docs/api/v1) — the public contract for chats, generations, versions, and tasks.
- [Web API host](/docs/api-host) — mount the framework-neutral `Request` and `Response` surface.
- [Runtime boundaries](/docs/runtime) — choose the portable core or explicit Node adapters.
- [Quality matrix](/docs/quality-matrix) — understand design evaluation and configurable gates.

## The core workflow

1. Create or import a project.
2. Send a message and stream durable generation events.
3. Preview the immutable version in a configured sandbox.
4. Iterate, restore, or fork without losing history.
5. Download raw source or provider-prepared output.

Repository and deployment integrations are optional adapters. They do not change the core source
or generation contracts.
