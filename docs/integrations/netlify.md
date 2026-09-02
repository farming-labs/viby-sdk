---
title: "Netlify deployment integration"
description: "Connect Netlify users and deploy immutable prebuilt sites and server functions."
---

# Netlify deployment integration

`@viby/sdk/integrations/netlify` connects each product user to their own Netlify account and implements the provider-neutral deployment contract with Netlify's atomic digest-deploy API. The host owns the Netlify OAuth application, callback route, database, secret-encryption key, sandbox, artifact store, and framework build command. Viby never exposes the access token or deploy-scoped environment values to the browser, a model, telemetry, or ordinary application records.

## Register the OAuth application

Create an OAuth application in Netlify's user settings and configure the host application's exact integration callback URL. Store the client ID and secret only in the server environment. Set `DATABASE_URL` for the default durable connection store and use a separate 32-byte `VIBY_SECRET_KEY` for provider credentials.

Public integrations must use Netlify's OAuth authorization-code flow. A personal access token is useful for the environment-gated live verification suite, but it should not replace per-user OAuth in a shipped multi-user product. See Netlify's [API authorization guide](https://docs.netlify.com/api-and-cli-guides/api-guides/get-started-with-api/#authentication) and [OpenAPI reference](https://open-api.netlify.com/) for the current provider fields.

## Configure Viby

```ts
import { createViby } from "@viby/sdk";
import { netlify } from "@viby/sdk/integrations/netlify";

const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  storage: {
    artifacts,
  },
  deployment: {
    preparation: {
      install: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
      build: { command: "pnpm", args: ["build:netlify"] },
      outputDirectory: ".output",
    },
  },
  integrations: {
    deployment: {
      netlify: netlify({
        clientId: env.NETLIFY_CLIENT_ID,
        clientSecret: env.NETLIFY_CLIENT_SECRET,
      }),
    },
  },
});
```

The configuration key (`netlify` above) is the application-owned integration ID. It may be renamed without changing the provider. The adapter declares prebuilt input without hard-coding a framework output directory; the host's declarative preparation contract remains the source of truth.

## Connect a user

```ts
const user = viby.forUser({ tenantId, userId });

const connection = await user.integrations.deployment.connect("netlify", {
  callbackUrl: "https://app.example/api/integrations/callback",
  returnTo: `/projects/${projectId}`,
});

if (connection.status === "authorization-required") {
  // Redirect or open a popup to connection.url.
}

// In GET /api/integrations/callback:
const completed = await viby.integrations.callback(request);
return Response.redirect(new URL(completed.returnTo, request.url));
```

Viby creates and verifies single-use callback state bound to the tenant, user, category, integration ID, and exact callback URL. The adapter exchanges the verified code server-side, reads the authorized Netlify user and accessible teams, and returns opaque credential bytes for the configured secret store.

Use the typed helper to populate a team picker. Project creation uses the only accessible team automatically or requires the selected slug when the connection can access several teams:

```ts
import { netlifyAccounts } from "@viby/sdk/integrations/netlify";

const hosting = user.integrations.deployment.use("netlify");
const connection = (await user.integrations.deployment.connections("netlify"))[0];
const accounts = connection ? netlifyAccounts(connection.account) : [];

await hosting.projects.create({
  name: "analytics-dashboard",
  providerOptions: {
    accountSlug: selectedAccountSlug,
  },
});
```

Netlify OAuth access tokens do not expose a refresh-token lifecycle through this API surface. Disconnecting always deletes Viby's encrypted local credential. Revoke the OAuth application's grant from Netlify when remote revocation is also required.

## Deploy a static build

For a static framework output, select the prepared public directory and omit `functions`:

```ts
const version = await chat.latestVersion();
const deployment = await version!.deploy({
  using: hosting,
  project: { id: netlifySiteId },
  environment: "preview",
  providerOptions: {
    publishDirectory: "dist",
    branch: "feat/analytics",
    framework: "vite",
  },
});
```

Set `deployment.preparation.outputDirectory` and `providerOptions.publishDirectory` to the paths produced by the host's build. Viby stores the raw framework version separately, materializes it in the configured sandbox, runs the declarative install/build commands, stores a checked immutable ZIP through `storage.artifacts`, and passes only the prepared files to Netlify.

## Deploy Farm.js server output

A Farm.js Netlify build contains public assets in `.output/public` and a prebuilt server bundle in `.output/server`. Keep those two roles explicit:

```ts
const deployment = await version!.deploy({
  using: hosting,
  project: {
    name: "analytics-dashboard",
    createIfMissing: true,
    providerOptions: { accountSlug: selectedAccountSlug },
  },
  environment: "preview",
  providerOptions: {
    publishDirectory: ".output/public",
    framework: "farmjs",
    functions: [
      {
        name: "server",
        directory: ".output/server",
        runtime: "js",
        invocationMode: "stream",
        config: {
          displayName: "Farm.js server",
          generator: "farmjs",
          routes: [{ pattern: "/*", preferStatic: true }],
          excludedRoutes: [{ pattern: "/.netlify/*" }],
        },
      },
    ],
  },
});
```

The adapter packages each declared function directory into a deterministic ZIP, hashes the finished bytes, supplies Netlify's route metadata, and uploads the bundle only when Netlify requests that digest. It does not execute generated configuration or inspect framework internals. Static frameworks, Farm.js, and future framework adapters all use the same provider-neutral prepared-file boundary.

`environment` controls Netlify's draft flag: `production` publishes the site, while `preview` and custom typed environments create draft deploys. Durable Viby environment values are sent as deploy-scoped secret variables with the Netlify Functions scope. They are resolved just in time and are never written into source, artifacts, logs, or deployment history.

## Atomic upload, retry, and limits

The adapter implements Netlify's content-addressed deploy protocol:

1. SHA-1 hashes are submitted for every public file and packaged function.
2. Netlify returns only the missing digests.
3. Viby uploads those missing bytes with bounded concurrency.
4. Normal deployment polling observes the provider state until it is ready or fails.

The default public-file limit is 25,000 files, matching Netlify's documented ZIP extraction ceiling. Per-file and compressed-function limits default to 100 MiB and can be lowered through `source`. Unsafe paths, duplicate paths, duplicate function names, empty output directories, oversized bytes, and malformed route selectors fail before an upload starts.

Retries are provider-safe as well as durable. The Viby idempotency key is hashed into a non-secret deploy title marker; the adapter searches site deploy history for that marker before creating a new effect. The title never contains the original key. PostgreSQL history remains the faster first line of replay protection, while provider lookup covers a process failure after Netlify accepted the request but before Viby recorded the result.

## Lookup and cancellation

```ts
const current = await hosting.deployments.get({ id: deployment.id });

if (current?.status === "queued" || current?.status === "building") {
  await hosting.deployments.cancel({
    id: current.id,
    idempotencyKey: `cancel:${current.id}`,
  });
}
```

Netlify lookup needs both a site ID and native deploy ID, so the adapter returns an opaque `nfd.` identifier carrying that routing context and the requested Viby environment. Store and pass it back unchanged; do not parse it. Provider states map to the common `queued`, `building`, `ready`, `failed`, and `cancelled` vocabulary.

Provider errors are wrapped by a connected handle as `IntegrationOperationError`; direct adapter consumers can inspect `NetlifyDeploymentError.status` and `.code`. Netlify rate-limits deployment creation more aggressively than ordinary API reads, so products should keep Viby's default stable idempotency and avoid retry loops outside the durable workflow.

## Live verification

The normal test suite uses a deterministic mock API and the provider-neutral deployment conformance workflow. Real-account verification is explicit and disposable:

```bash
VIBY_LIVE_PROVIDER_TESTS=1 \
VIBY_LIVE_PROVIDERS=netlify \
VIBY_LIVE_NETLIFY_ACCESS_TOKEN=... \
VIBY_LIVE_NETLIFY_ACCOUNT_SLUG=... \
npm run test:providers:live
```

The live test creates a uniquely prefixed site, deploys a preview, waits for readiness, verifies its HTTPS URL, and deletes the site. If a process is interrupted, `npm run test:providers:cleanup` reads the tracked cleanup file and deletes only the guarded disposable resource.
