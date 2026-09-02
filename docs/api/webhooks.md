---
title: "Durable webhooks"
description: "Tenant-managed signed event endpoints with durable cursors, retries, dead letters, and explicit delivery workers."
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

## Deliver from a host-owned worker

Viby does not create a hidden scheduler. Call `deliver` from the product's queue consumer, cron,
workflow, or background worker:

```ts
const page = await user.webhooks.deliver(webhook.id, generationId, {
  limit: 100,
  retry: {
    maxAttempts: 8,
    initialDelayMs: 1_000,
    maxDelayMs: 60_000,
    multiplier: 2,
  },
});

if (page.hasMore || page.retryAt) scheduleAnotherDelivery(page.retryAt);
```

The cursor advances for both delivered and intentionally filtered events. Concurrent workers use
leased claims, and each delivery is keyed by webhook, generation, and event cursor. Endpoint errors
never change generation state. Delivery is at least once because a receiver can accept an HTTP
request before the worker observes a network failure; receivers must deduplicate the stable
`viby-event-id` header.

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
