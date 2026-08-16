---
title: "Errors"
description: "Typed SDK and Web-client failures, stable codes, safe metadata, and recovery guidance."
---

# Errors

Direct SDK failures extend `VibyError`. Each error has a stable `code` and a safe message suitable for
application logs. Provider credentials, prompts, source, secret values, and raw provider responses
are not copied into ordinary error records.

## Base error

```ts
try {
  await generation.retry();
} catch (error) {
  if (error instanceof VibyError) {
    logger.warn({ code: error.code }, error.message);
  }
}
```

Use classes for local TypeScript narrowing and `code` when crossing a process or HTTP boundary.

## Configuration and data

| Error | When it occurs | Recommended handling |
| --- | --- | --- |
| `ConfigurationError` | Invalid or mutually exclusive config, identifiers, prompts, source shapes, or bounds. | Treat as a developer or validation error; do not retry unchanged input. |
| `DatabaseNotReadyError` | The configured database does not contain current Viby migrations. | Run `viby db migrate` in the release environment before serving traffic. |
| `NotFoundError` | A resource is missing, deleted, or outside the current tenant/user scope. | Return a generic not-found response without revealing cross-scope existence. |
| `SkillResolutionError` | A skill locator cannot be resolved or validated safely. | Fix the catalog/path/reference or remove it; inspect the safe locator and cause. |
| `SourceImportError` | A provider-neutral import adapter failed. | Surface a retry option; log the adapter ID and protected cause server-side. |

## Generation lifecycle

| Error | When it occurs | Recommended handling |
| --- | --- | --- |
| `GenerationError` | The synchronous convenience path observed a failed durable generation. | Use `generationId` to load attempts/events and offer retry. |
| `GenerationCancelledError` | The synchronous convenience path observed cancellation. | Show the recorded cancellation state; retry only on explicit user intent. |
| `GenerationStateError` | Cancel, retry, resume, or resolution is invalid for the current state. | Refresh `generation.data()` and render valid actions for that state. |
| `GenerationTaskRequiredError` | `chat.generate()` reached typed blocking tasks. | Load the generation by `generationId`, present `taskIds`, resolve, and continue. |

Prefer `chat.start()` plus `Generation.wait()` in interactive products because the outcome union makes
waiting, failure, and cancellation explicit without exceptions.

## Integrations and tool sources

| Error | When it occurs | Recommended handling |
| --- | --- | --- |
| `IntegrationAuthorizationError` | Authorization state, callback, exchange, refresh, or revocation is invalid. | Restart the connection flow; do not reuse callback state. |
| `IntegrationConnectionRequiredError` | A repository/deployment operation has no healthy selected connection. | Call the scoped category's `connect()` and resume after authorization. |
| `IntegrationOperationError` | A connected provider operation failed. | Use category/provider/operation for safe logs; apply idempotent retry policy. |
| `ToolSourceAuthorizationError` | A durable tool-source connection flow failed. | Restart authorization for the registration. |
| `ToolSourceConnectionRequiredError` | A selected source needs a usable connection. | Connect or disable the source before generating again. |

## Sandbox and browser

| Error | When it occurs | Recommended handling |
| --- | --- | --- |
| `SandboxUnavailableError` | No sandbox is configured or a required capability is missing. | Disable the product action or configure a compatible adapter. |
| `SandboxCommandDeniedError` | Policy denied a normalized command. | Show the safe reason; changing provider does not bypass policy. |
| `SandboxCommandApprovalRequiredError` | Policy requires explicit approval. | Persist/present `proposedAction`, then resume only with an approved grant. |
| `SandboxError` | A provider operation failed. | Log provider and operation, clean up the lease, and retry only when safe. |
| `BrowserError` | Navigation, screenshot, DOM, console, accessibility, or readiness failed. | Log provider/operation and keep the source version unchanged. |
| `PreviewError` | Preview startup, readiness, reconnect, or stop failed. | Load `previewId` when present; the failure is already durable. |

## Outbound delivery

| Error | When it occurs | Recommended handling |
| --- | --- | --- |
| `OutboundEventSinkError` | The sink transport rejected or failed one event. | Inspect the durable delivery record; do not change generation state. |
| `OutboundEventDeliveryError` | Delivery stopped at a specific cursor. | Resume after `lastDeliveredCursor`; redrive only explicit dead letters. |
| `OutboundEventSignatureError` | Signature, timestamp, key, or body verification failed. | Reject the request and do not parse it as a trusted event. |

## Web client errors

`createVibyWebClient()` uses three transport-specific errors:

| Error | Meaning |
| --- | --- |
| `VibyApiClientError` | A non-success HTTP response with `status`, API `code`, message, and parsed safe body. |
| `VibyStreamDisconnectedError` | SSE disconnected more than the configured reconnect budget; includes the last cursor and reconnect count. |
| `VibyStreamProtocolError` | The server returned malformed SSE or event JSON. |

Network exceptions from the supplied `fetch` implementation are not wrapped. Products may therefore
distinguish transport failure from a typed Viby API response.

## HTTP mapping

`createVibyApi()` converts known errors to JSON with an appropriate status and stable `code`. It
preserves product `Response` objects returned by authentication or preview callbacks. Unexpected
errors become a generic server response; raw exception details remain server-side.
