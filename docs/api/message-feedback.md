---
title: "Message feedback"
description: "Collect durable, provider-neutral product feedback against exact generated assistant messages."
---

# Message feedback

Viby stores feedback as immutable records attached to one generated assistant message. A record also
captures its logical generation, immutable attempt, model identity, and generated version when one
exists. This makes product feedback useful for evaluation and quality analysis without coupling the
SDK to a particular analytics service or model provider.

```ts
const feedback = await chat.submitFeedback(assistantMessage.id, {
  rating: "positive",
  reasons: ["helpful", "well-designed"],
  comment: "The hierarchy matches the brief.",
  metadata: { surface: "preview", experiment: "toolbar-v2" },
  idempotencyKey: `thumb:${assistantMessage.id}`,
});

const history = await chat.listFeedback(assistantMessage.id);
```

`rating` is `positive` or `negative`. Reasons are typed common suggestions—such as `helpful`,
`accurate`, `incorrect`, `incomplete`, and `poor-design`—while custom strings remain supported.
Comments are optional and application-visible; do not place credentials or other secrets in them.

Feedback is accepted only for assistant messages backed by a durable generation attempt. User
messages, deleted chats, missing records, and cross-tenant IDs are not exposed. Reusing a non-empty
`idempotencyKey` for the same message and identical input returns the original record. Reusing it
with different input is rejected, which prevents double votes without silently changing history.

## Web API and browser client

The framework-neutral API host exposes the same ownership and idempotency behavior:

```text
POST /api/viby/chats/:chatId/messages/:messageId/feedback
GET  /api/viby/chats/:chatId/messages/:messageId/feedback
```

```ts
await client.chats.messages.submitFeedback(chatId, messageId, {
  rating: "negative",
  reasons: ["incomplete"],
  idempotencyKey: `thumb:${messageId}`,
});

const { feedback } = await client.chats.messages.listFeedback(chatId, messageId);
```

The host application decides whether its UI permits one vote, multiple evaluation records, or a
separate feedback record per surface. Viby supplies durable attribution and isolation; it does not
send feedback to the model provider or use it to retrain a model automatically.
