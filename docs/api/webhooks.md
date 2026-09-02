---
title: "Durable webhooks"
description: "Tenant-managed signed event endpoints with durable discovery, cursors, retries, and dead letters."
---

# Durable webhooks

Durable webhooks let an embedding product register an endpoint for one authenticated Viby user and
reliably forward generation lifecycle events to it. Webhook configuration, high-watermark cursors,
delivery attempts, retries, and dead letters survive process restarts. Signing secrets live in
`storage.secrets`; ordinary records never expose the secret reference or bytes.

Enable the resource explicitly:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  events: {
    webhooks: {},
  },
});
```

When `storage.secrets` is omitted, the built-in PostgreSQL-backed encrypted store is used and
requires `VIBY_SECRET_KEY`. A custom `SecretStore` remains supported.

## Create and manage an endpoint

```ts
const user = viby.forUser({ tenantId, userId });

const { webhook, signingSecret } = await user.webhooks.create({
  name: "Product events",
  url: "https://app.example.com/api/viby/events",
  events: [
    "attempt.waiting",
    "task.created",
    "preview.ready",
    "preview.failed",
    "generation.succeeded",
    "generation.failed",
    "generation.cancelled",
  ],
});

// Persist this in the receiving service. Viby returns it only from create/rotate.
saveWebhookSecret(signingSecret);
```

Omit `events` for the high-signal lifecycle defaults above. Use `events: "all"` only when the
receiver needs the complete trace, including deltas and workspace events. Management methods are
`list`, `get`, `update`, `pause`, `resume`, `rotateSecret`, and `delete`. Rotation returns the new
secret exactly once and deletes the replaced secret after the durable record is updated.

## Run the durable delivery worker

Create one worker from the root client. It discovers due work across every tenant scope, so callers
never pass webhook, user, or generation IDs. `run()` is suitable for a long-lived worker process;
`runOnce()` processes at most one webhook/generation page for cron and workflow runtimes.

```ts
const worker = viby.webhookWorker({
  id: process.env.WORKER_ID!,
  concurrency: 8,
  delivery: {
    limit: 100,
    retry: {
      maxAttempts: 8,
      initialDelayMs: 1_000,
      maxDelayMs: 60_000,
      multiplier: 2,
    },
  },
});

await worker.run({ signal: shutdownSignal });

// Or from a scheduled function:
await worker.runOnce();
```

The durable event log and delivery cursors are the work queue. A newly created endpoint starts after
the latest event in its tenant scope, so starting a worker never replays unrelated history. The
cursor advances for both delivered and intentionally filtered events. Concurrent workers use leased
per-event claims, and each delivery is keyed by webhook, generation, and event cursor. Endpoint
errors never change generation state. Delivery is at least once because a receiver can accept an
HTTP request before the worker observes a network failure; receivers must deduplicate the stable
`viby-event-id` header.

Custom persistence adapters may retain explicit delivery without implementing global discovery.
To support `viby.webhookWorker(...)`, implement `findWebhookDeliveryWork(now)` on the adapter's
`WebhookStore` contract.

## Deliver one endpoint explicitly

Products can still drain a known endpoint/generation pair directly:

```ts
const page = await user.webhooks.deliver(webhook.id, generationId, { limit: 100 });
if (page.hasMore || page.retryAt) scheduleAnotherDelivery(page.retryAt);
```

Inspect and redrive failures explicitly:

```ts
const deadLetters = await user.webhooks.deliveries(webhook.id, generationId, {
  status: "dead_lettered",
});

await user.webhooks.redrive(webhook.id, generationId, deadLetters[0].eventCursor);
await user.webhooks.deliver(webhook.id, generationId);
```

## Verify requests

Webhook requests use the same CloudEvents-style envelope and HMAC-SHA256 protocol as static signed
outbound sinks. Verify the raw body before parsing or acting on it:

```ts
const envelope = verifySignedOutboundEvent(
  { body: await request.text(), headers: Object.fromEntries(request.headers) },
  { secret: signingSecret, keyId: webhook.keyId },
);
```

The SDK requires HTTPS endpoints, rejects embedded credentials, fragments, localhost, and obvious
private literal IP addresses, and disables redirects. Production hosts should also apply egress
network policy and DNS-aware SSRF protection in their supplied `fetch` transport.

## Web API

`createVibyApi` exposes management under `/webhooks` and delivery under
`/webhooks/{webhookId}/generations/{generationId}`. The portable client mirrors the direct API as
`client.webhooks`. Creation and secret rotation are the only responses containing a signing secret.

The API host's authentication and authorization callbacks run for every webhook operation. Never
accept tenant or user identity from the webhook request body.
