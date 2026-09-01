---
title: "Integrations"
description: "Connect repository and deployment providers through scoped authorization and durable histories."
---

# Integrations

Integrations are grouped by product capability: `repository` and `deployment`. Provider credentials,
options, SDK clients, and account semantics remain inside adapters; application workflows use the
same Viby handles across providers.

## Configure providers

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  integrations: {
    repository: {
      github: github({ /* provider app configuration */ }),
      bitbucket: bitbucket({ /* OAuth consumer configuration */ }),
    },
    deployment: {
      vercel: vercel({ /* integration configuration */ }),
      cloudflare: cloudflare({ /* OAuth configuration */ }),
    },
  },
});
```

Omit a category or provider when the product does not offer it. Use the provider-specific guides for
registration fields and callback URLs.

## Connection lifecycle

User-scoped categories expose the same methods:

| Method | Behavior |
| --- | --- |
| `list()` | Lists configured adapters with redacted connections and a computed `connected` flag. |
| `connections(integrationId?)` | Lists scoped durable connection metadata, optionally for one provider. |
| `connect(integrationId, input)` | Returns a usable existing connection or starts authorization and returns its URL/expiry. |
| `disconnect(integrationId, options?)` | Revokes remotely when supported, deletes secret material, and records local revocation. |
| `use(integrationId, { connectionId? })` | Creates a repository or deployment handle; provider work resolves/refreshes credentials just in time. |

`connect` requires an absolute callback URL and a bounded return path. It also accepts optional
scopes, `force`, and a provider-neutral `authorization` preference. Set
`authorization.account` to `"existing"` when reconnecting an account or `"new"` when provisioning
one; `externalAccountId` can carry a provider identifier selected by the product. Adapters that do
not distinguish those paths may treat the preference as a hint. Callback state is hashed,
expiring, and single use. Complete repository and deployment
callbacks through `viby.integrations.callback(request)`, then redirect only to an application-
allowlisted `returnTo` value.

## Repository handles

```ts
const repository = user.integrations.repository.use("github");
```

| Surface | Methods and behavior |
| --- | --- |
| `owners` | `list()` cursor-pages organizations, workspaces, or personal owners. |
| `repositories` | `list()`, `get()`, and `create()` provider-neutral repositories. |
| `branches` | `list()`, `get()`, and `create()` branch records. |
| `pullRequests` | `create()` and `merge()` provider-neutral pull requests. |
| handle | `connect()`, `disconnect()`, `source()`, `readSource()`, `pushSource()`, and advanced `run()`. |

`source(input)` creates a safe descriptor for `user.chats.import({ source })`; credentials remain in
the handle. `version.push()` is the preferred high-level publish operation because it writes durable
pending/history records and uses the immutable version as its complete source snapshot.

## Deployment handles

```ts
const deployment = user.integrations.deployment.use("vercel");
```

| Surface | Methods and behavior |
| --- | --- |
| handle metadata | `id`, `provider`, `displayName`, `sourceMode`, and optional `outputDirectory`. |
| `projects` | `list()`, `get()`, and `create()` provider-neutral projects. |
| `deployments` | `get()` refreshes one provider deployment; `cancel()` requests cancellation. |
| handle | `connect()`, `disconnect()`, `deploySource()`, and advanced `run()`. |

`version.deploy()` is the preferred high-level method because it prepares the correct source form,
persists project links and deployment records, applies stable idempotency, and observes status
transitions.

## Source and prebuilt deployment modes

An adapter declares `sourceMode`:

- `source` receives the complete immutable framework source tree;
- `prebuilt` receives files collected from the configured sandbox build output.

For prebuilt deployments Viby materializes the version, resolves the selected project environment,
runs the declarative install/build commands, stores an immutable ZIP through `storage.artifacts`, and
passes the collected files to the provider. Command records contain environment names, not values.
Raw `version.download()` output remains unchanged.

## Durable history and idempotency

Repository pushes and deployments write a pending record before contacting the provider. The record
captures scope, chat, immutable version, provider, selected connection, target, idempotency key,
status, result identity, safe error, and timestamps.

Repeated completed keys replay durable results. Provider refresh and cancellation append deployment
status transitions rather than erasing observations. History methods are database reads and remain
available after restarts.

## Direct provider operations

Low-level discovery and administrative calls are available for selection UIs. Prefer high-level
`version.push()` and `version.deploy()` for product effects. The `run()` escape hatch is intentionally
advanced: it resolves a short-lived credential and passes the adapter plus operation context to a
callback without adding a Viby history record for arbitrary provider work.

## Included adapters

| Capability | Entry point | Guide |
| --- | --- | --- |
| GitHub repositories | `@viby/sdk/integrations/github` | [GitHub](/docs/integrations/github) |
| Bitbucket repositories | `@viby/sdk/integrations/bitbucket` | [Bitbucket](/docs/integrations/bitbucket) |
| GitLab repositories | `@viby/sdk/integrations/gitlab` | [GitLab](/docs/integrations/gitlab) |
| Vercel deployments | `@viby/sdk/integrations/vercel` | [Vercel](/docs/integrations/vercel) |
| Cloudflare Pages deployments | `@viby/sdk/integrations/cloudflare` | [Cloudflare](/docs/integrations/cloudflare) |

Custom stores and adapters should run the integration, repository, or deployment conformance suite
from the corresponding package entry point before production use.
