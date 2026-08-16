---
title: "Vercel deployment integration"
description: "Connect Vercel accounts and deploy immutable framework source through the provider-neutral deployment contract."
---

# Vercel deployment integration

`@viby/sdk/integrations/vercel` connects each product user to their own Vercel account and implements the provider-neutral deployment contract. The host owns the Vercel Integration registration, OAuth credentials, callback route, database, and secret-encryption key. Viby never sends the resulting Vercel access token to the browser, a model, or a normal application record.

## Register the integration

Create an external integration in Vercel's Integration Console and configure:

- a stable URL slug;
- the host application's integration callback URL as the Redirect URL;
- read/write access for the Project and Deployment scopes.

Store the assigned client ID and client secret only in the server environment. Set `DATABASE_URL` for the default durable connection store and `VIBY_SECRET_KEY` to a separate 32-byte encryption key for provider credentials.

## Configure Viby

```ts
import { createViby } from "@viby/sdk";
import { vercel } from "@viby/sdk/integrations/vercel";

const viby = createViby({
  framework: "farmjs",
  model,
  integrations: {
    deployment: {
      vercel: vercel({
        clientId: env.VERCEL_CLIENT_ID,
        clientSecret: env.VERCEL_CLIENT_SECRET,
        slug: "viby",
      }),
    },
  },
});
```

The configuration key (`vercel` above) is the application-owned integration ID. It may be renamed without changing the provider. The factory name and returned `provider` identify the concrete adapter.

## Connect a user

```ts
const user = viby.forUser({ tenantId, userId });

const connection = await user.integrations.deployment.connect("vercel", {
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

Viby creates and validates the single-use state, binds it to the tenant, user, category, integration ID, and exact callback URL, and then gives the verified callback to the adapter. The adapter exchanges Vercel's short-lived code with a form-encoded server request. When an installation belongs to a team, its authoritative `team_id` is encrypted with the token and automatically included in every project, file, and deployment request.

Disconnecting calls Vercel's token revocation endpoint before removing the local encrypted credential. If remote revocation fails, Viby still revokes and deletes the local connection and reports `providerRevoked: false`.

## Deploy an immutable version

```ts
const hosting = user.integrations.deployment.use("vercel");
const version = await chat.latestVersion();

const deployment = await version!.deploy({
  using: hosting,
  project: {
    name: "analytics-dashboard",
    createIfMissing: true,
    providerOptions: {
      framework: null,
      buildCommand: "pnpm build",
      outputDirectory: "dist",
    },
  },
  environment: "preview",
  providerOptions: {
    skipAutoDetectionConfirmation: true,
    meta: { product: "viby" },
  },
});

deployment.status;
deployment.url;
```

The adapter validates the complete snapshot, looks for a previous deployment carrying the same Viby idempotency key, uploads every text or binary file by SHA-1, and creates a deployment from those immutable references. A retry after a worker or process restart therefore recovers the existing provider deployment instead of repeating the effect. Vercel's own content deduplication also makes repeated file uploads inexpensive.

`preview` omits a Vercel target, `production` uses the production target, `staging` uses the staging target, and any other typed environment value is sent as a custom environment slug or ID. Project creation remains explicit through `createIfMissing`; a missing project is never silently created.

Provider-specific build settings stay inside `providerOptions`, so the core deployment contract has no Vercel framework, command, environment-variable, or project types. Farm projects can use their existing package scripts and output contract without changing the SDK's top-level `framework` value.

## Direct provider operations

```ts
const projects = await hosting.projects.list({ search: "dashboard" });
const project = await hosting.projects.get({ name: "analytics-dashboard" });
const current = await hosting.deployments.get({ id: deployment.id });

if (current?.status === "queued" || current?.status === "building") {
  await hosting.deployments.cancel({
    id: current.id,
    idempotencyKey: `cancel:${current.id}`,
  });
}
```

All operations are tenant/user scoped and require an active connection. Provider errors are wrapped by the connected handle as `IntegrationOperationError`; direct adapter consumers can inspect `VercelDeploymentError.status` and `.code`.
