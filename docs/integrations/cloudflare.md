---
title: "Cloudflare deployment integration"
description: "Connect Cloudflare accounts and deploy immutable prebuilt assets to Pages."
---

# Cloudflare deployment integration

`@viby/sdk/integrations/cloudflare` connects each product user to their own Cloudflare account and implements the provider-neutral deployment contract with Pages Direct Upload. The host owns the Cloudflare OAuth client, callback route, database, secret-encryption key, sandbox, artifact store, and declarative framework build command. Viby never exposes the resulting access or refresh token to the browser, a model, or a normal application record.

## Register the OAuth client

Create a server-side OAuth client in Cloudflare and configure:

- the Authorization Code grant;
- `client_secret_basic` or `client_secret_post` token authentication;
- the host application's exact integration callback URL;
- the **Pages Write** permission and the account-read access needed to enumerate the accounts selected during consent.

Cloudflare's client configuration uses scope identifiers. Pass those same identifiers to `scopes`; do not substitute display labels. Store the client secret only in the server environment. Set `DATABASE_URL` for the default durable connection store and `VIBY_SECRET_KEY` to a separate 32-byte encryption key for provider credentials.

See Cloudflare's [OAuth client guide](https://developers.cloudflare.com/fundamentals/oauth/create-an-oauth-client/) and [Pages deployment API](https://developers.cloudflare.com/api/resources/pages/subresources/projects/subresources/deployments/methods/create/) for the current provider configuration.

## Configure Viby

```ts
import { createViby } from "@viby/sdk";
import { cloudflare } from "@viby/sdk/integrations/cloudflare";

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
      build: { command: "pnpm", args: ["build"] },
      outputDirectory: "dist",
    },
  },
  integrations: {
    deployment: {
      cloudflare: cloudflare({
        clientId: env.CLOUDFLARE_CLIENT_ID,
        clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
        scopes: env.CLOUDFLARE_OAUTH_SCOPES.split(" "),
      }),
    },
  },
});
```

The configuration key (`cloudflare` above) is the application-owned integration ID. It may be renamed without changing the provider. The factory name and returned `provider` identify the concrete adapter.

## Connect a user

```ts
const user = viby.forUser({ tenantId, userId });

const connection = await user.integrations.deployment.connect("cloudflare", {
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

Viby creates and validates single-use state and binds it to the tenant, user, category, integration ID, and exact callback URL. The adapter exchanges the verified short-lived code server-side, reads the authorized Cloudflare identity, encrypts both tokens, refreshes expiring credentials, and revokes the remote authorization on disconnect.

One OAuth authorization may include multiple Cloudflare accounts. Viby snapshots their safe IDs and names into connection metadata while keeping credentials encrypted, and project listing spans them. Use the typed helper to populate an account picker. Project creation uses the only accessible account automatically or requires an explicit provider option when the user selected more than one:

```ts
import { cloudflareAccounts } from "@viby/sdk/integrations/cloudflare";

const hosting = user.integrations.deployment.use("cloudflare");
const connection = (await user.integrations.deployment.connections("cloudflare"))[0];
const accounts = connection ? cloudflareAccounts(connection.account) : [];

await hosting.projects.create({
  name: "analytics-dashboard",
  providerOptions: {
    accountId: selectedAccountId,
    productionBranch: "main",
  },
});
```

## Deploy prebuilt immutable assets

Cloudflare Pages Direct Upload accepts prebuilt assets, so the adapter declares `{ mode: "prebuilt", outputDirectory: "dist" }`. Viby automatically materializes the raw immutable version in the configured sandbox, runs the framework build contract, stores a checked immutable ZIP through `storage.artifacts`, and then sends the built files to Cloudflare:

```ts
const version = await chat.latestVersion();
const deployment = await version!.deploy({
  using: hosting,
  project: { id: cloudflareProjectId },
  environment: "preview",
  providerOptions: {
    assetsDirectory: "dist",
    branch: "feat/analytics",
    commitMessage: "Ship analytics dashboard",
  },
});

deployment.status;
deployment.url;

const [record] = await version!.deployments();
const build = record ? await version!.deploymentArtifact(record.id) : null;
```

Set `deployment.preparation.outputDirectory` and `providerOptions.assetsDirectory` to the same non-default directory when the framework does not emit `dist`. If the output contains no files, preparation fails before making provider calls. The raw version remains available through `version.download()` and is never changed or exposed as public assets. `_headers`, `_redirects`, `_routes.json`, `_worker.js`, `_worker.bundle`, and the functions routing configuration are sent through Cloudflare's dedicated multipart fields.

The adapter uses Cloudflare's content-addressed upload protocol: Wrangler-compatible BLAKE3 hashes, missing-asset discovery, bounded batches, MIME metadata, and hash-cache upserts. Cloudflare's published Direct Upload limits are enforced by default: 20,000 files and 25 MiB per file. Hosts may lower those limits but cannot configure the adapter above the provider maximum.

Retries are durable. A stable Viby idempotency key becomes a deterministic commit hash; the adapter looks for an existing Pages deployment with that hash before uploading or creating another effect. Production omits the branch so Cloudflare uses the project's production branch. Preview and custom environments use a provider branch. Cloudflare only reports `preview` or `production` in returned deployment records.

## Deployment lookup and cancellation

```ts
const current = await hosting.deployments.get({ id: deployment.id });
```

Cloudflare's lookup endpoint needs an account ID, project name, and deployment ID, so the adapter returns an opaque `cfp.` deployment identifier containing that routing information. Store and pass it back unchanged; do not parse it.

Pages exposes deployment deletion, retry, and rollback, but not cancellation with the same semantics as the provider-neutral optional cancellation operation. The adapter therefore does not advertise `cancelDeployment` and does not mislabel deletion as cancellation.

All operations are tenant/user scoped and require an active connection. Provider errors are wrapped by the connected handle as `IntegrationOperationError`; direct adapter consumers can inspect `CloudflareDeploymentError.status` and `.code`.

The Direct Upload behavior follows Cloudflare's [prebuilt-assets requirement and limits](https://developers.cloudflare.com/pages/get-started/direct-upload/). Preparation stays provider-neutral: the Cloudflare adapter declares only the input shape it requires, while the host chooses the framework command, sandbox implementation, and artifact store.
