---
title: "Quickstart"
description: "Create, stream, iterate on, and download a durable generated project."
---

# Quickstart

This guide builds the smallest complete Viby workflow: configure the SDK, bind a user, create a
chat, stream a generation, iterate from its immutable version, and download the resulting source.

## Requirements

- Node.js 20 or newer for the full client and built-in PostgreSQL adapter;
- a PostgreSQL database reachable through `DATABASE_URL`;
- an AI SDK-compatible model and that provider's server-side credentials.

Install the SDK, AI SDK, and the provider package used by your application:

```bash
npm install @viby/sdk ai @ai-sdk/openai
```

## 1. Prepare the database

Set `DATABASE_URL` in the server environment, then run the Viby-owned migrations during deploy or
release setup. Application requests never run migrations implicitly.

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/viby
npx viby db migrate
```

Viby creates a dedicated `viby` schema. It does not read or modify the application's authentication,
organization, or billing tables.

## 2. Create one server-side client

```ts
import { createViby } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";

export const viby = createViby({
  framework: "farmjs",
  model: openai("your-model-id"),
  skills: {
    design: ["farming-labs/design-engineer"],
  },
});
```

`framework` is one type-safe string and may be a built-in suggestion or an application-defined
identifier. The model provider reads its own credential from the server environment; Viby never
persists that credential. Keep the root client long-lived and call `viby.close()` during graceful
process shutdown.

## 3. Bind application identity

```ts
const user = viby.forUser({
  tenantId: organization.id,
  userId: session.user.id,
});
```

Both values are required. Every durable query and mutation is constrained by the pair. Viby does
not infer identity from cookies, request globals, or application tables.

## 4. Create and generate

```ts
const chat = await user.chats.create({ title: "Analytics dashboard" });

const generation = await chat.start({
  prompt: "Build a polished SaaS analytics dashboard with complete loading and empty states.",
  metadata: { source: "new-project" },
});

for await (const event of generation.stream()) {
  renderGenerationEvent(event);
  saveCursor(event.cursor);
}

const outcome = await generation.wait();
```

`chat.start()` returns after the durable generation and its first attempt exist. `stream()` reads
persisted events in cursor order; disconnecting a subscriber does not cancel the generation. Pass
the last acknowledged cursor through `stream({ after })` when reconnecting.

The final outcome is a discriminated union:

- `succeeded` includes the immutable result `version`;
- `waiting` includes typed plan, question, or permission tasks;
- `failed` includes a durable safe error message;
- `cancelled` includes the recorded cancellation reason.

## 5. Resolve blocking work

```ts
if (outcome.status === "waiting") {
  const task = outcome.tasks[0];

  if (task?.kind === "permission") {
    await generation.resolve({
      taskId: task.id,
      resolution: { kind: "permission", decision: "allow" },
    });

    await generation.wait();
  }
}
```

Resolving a task appends a new immutable attempt. It does not overwrite the paused attempt or repeat
an already recorded external effect.

## 6. Iterate from an exact version

```ts
const version = await chat.latestVersion();
if (!version) throw new Error("The generation did not produce a version");

const refined = await version.iterate({
  prompt: "Tighten the visual hierarchy and add a useful empty state to every table.",
});
```

Versions are immutable and parent-linked. Iteration always names its base version, so concurrent
branches, restore, audit, and reproducible downloads remain possible.

## 7. Download raw source

```ts
const artifact = await refined.download();

return artifact.toResponse();
```

The response is a framework-native ZIP assembled from the selected immutable version. It excludes
secrets, dependency directories, lockfiles, build output, and provider-specific deployment state.

## Production checklist

- Authenticate every request before calling `forUser`.
- Run `viby db migrate` as a release step, not in request handling.
- Use worker execution for generations that must outlive a request process.
- Configure an external artifact store when attachments or generated binaries should not live on
  one local filesystem.
- Configure a secret store before enabling provider connections, private tool sources, or secret
  project environment variables.
- Enforce a sandbox command policy before executing untrusted generated commands.
- Persist the last acknowledged event cursor in the product client.
- Call `close()` during graceful shutdown and clean up expired previews on a host-owned schedule.

Continue with [Core concepts](/docs/concepts) or open the [client reference](/docs/api/client).
