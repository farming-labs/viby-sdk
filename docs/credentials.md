---
title: "Credentials and provider setup"
description: "Create the server credentials Viby needs, connect user-owned providers, and verify the setup without exposing secrets."
order: 2
---

# Credentials and provider setup

Viby is bring-your-own-infrastructure. Your product owns its database, model account, provider
applications, and server environment. Viby uses those server credentials to create durable,
tenant-scoped connections; it never returns provider tokens to the browser or places secrets in
prompts, messages, events, telemetry, or ordinary records.

There are two kinds of credentials:

| Kind | Example | Scope | Storage |
| --- | --- | --- | --- |
| Host credential | OpenAI key, GitHub App private key, Vercel client secret | Your Viby product | Server environment or host secret manager |
| User connection | A user's GitHub installation or Vercel account grant | One tenant and user | Encrypted by the configured Viby secret store |

Do not ask end users to paste provider access tokens into the product. Configure one provider
application for the host, then let each user complete the provider's authorization screen.

## 1. Create the foundation credentials

Install Viby and the model adapter used by this example:

```bash
npm install @viby/sdk ai @ai-sdk/openai
```

Add the database and model key to a server-only environment file:

```bash title=".env.local"
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/viby
OPENAI_API_KEY=
OPENAI_MODEL=
```

`OPENAI_API_KEY` is read by `@ai-sdk/openai`, not persisted by Viby. Use any other AI SDK model or
a custom generation engine when OpenAI is not the desired provider.

Run the Viby-owned migrations:

```bash
npx viby db migrate
```

Connections and project secrets need a separate 32-byte encryption key. Generate one once, store
it in the host's secret manager, and keep it stable across restarts:

```bash
openssl rand -hex 32
```

```bash title=".env.local"
VIBY_SECRET_KEY=
```

Rotating this key requires re-encrypting or reconnecting existing provider credentials. Never
reuse the database password, an OAuth client secret, or a model key as `VIBY_SECRET_KEY`.

## 2. Choose the Vercel credential you actually need

Vercel Sandbox and user-owned Vercel deployments solve different problems and use different
credentials.

### Run generated code in Vercel Sandbox

Use this when Viby needs an isolated build or preview runtime owned by your product. Enable
**Secure backend access with OIDC federation** in the linked Vercel project's Security settings.
Vercel then manages the workload credential in production. For local development, link the host
project and pull its development environment:

```bash
npx vercel login
npx vercel link
npx vercel env pull .env.local --environment=development
```

Do not commit the pulled file. The Vercel SDK can read the resulting short-lived workload
credential without placing a long-lived token in application code:

```ts
import { vercelSandbox } from "@viby/sdk/sandbox/vercel";

const sandbox = vercelSandbox({
  name: ({ chatId }) => `viby-${chatId.slice(0, 12)}`,
});
```

For a non-Vercel host, pass an explicit `token`, `teamId`, and `projectId` together. Keep all three
server-only. See Vercel's [OIDC guide](https://vercel.com/docs/oidc) for issuer settings and local
token refresh behavior.

### Deploy into each user's Vercel workspace

Use a Vercel Integration when the user should select and authorize their own personal or team
workspace.

1. Open the Vercel Integration Console and create an external integration.
2. Choose a stable URL slug. The `slug` passed to `vercel()` must exactly match this value.
3. Set the redirect URL to your public Viby callback, for example
   `https://app.example/api/viby/integrations/callback`.
4. Grant Project and Deployment read/write access.
5. Copy the client ID and client secret into the server environment.

```bash title=".env.local"
VERCEL_CLIENT_ID=
VERCEL_CLIENT_SECRET=
VERCEL_INTEGRATION_SLUG=
```

```ts
import { vercel } from "@viby/sdk/integrations/vercel";

const deployment = vercel({
  clientId: env.VERCEL_CLIENT_ID,
  clientSecret: env.VERCEL_CLIENT_SECRET,
  slug: env.VERCEL_INTEGRATION_SLUG,
});
```

If `https://vercel.com/integrations/<slug>/new` returns `404`, verify the slug from the
integration's public URL, confirm the integration is available to the signed-in account or team,
and ensure the integration is not still missing required listing fields. A client ID is not an
integration slug.

See the [Vercel deployment integration](/docs/integrations/vercel) for project creation,
idempotent deployments, provider options, and durable history. Vercel's current
[integration creation guide](https://vercel.com/docs/integrations/create-integration) documents
the console fields, visibility, and credential rotation behavior.

## 3. Create the GitHub App

Use a GitHub App rather than a personal access token. One host-owned app can let every Viby user
choose the account, organization, and repositories they want to connect.

Create the app under the GitHub account or organization that owns the product and configure:

- Homepage URL: the public product URL.
- Callback URL: `https://app.example/api/viby/integrations/callback`.
- Request user authorization during installation: enabled.
- Setup URL: the product page users should return to after installation, if one is used.
- Metadata: read.
- Contents: read and write.
- Pull requests: read and write.
- Administration: read and write only when the product creates repositories.

Generate and download a private key after creating the app. Then copy the app ID, OAuth client ID,
OAuth client secret, private key, and URL slug into the server environment:

```bash title=".env.local"
GITHUB_APP_ID=
GITHUB_APP_CLIENT_ID=
GITHUB_APP_CLIENT_SECRET=
GITHUB_APP_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"
GITHUB_APP_SLUG=
```

The private key may contain literal newlines or escaped `\n` sequences. Do not base64 it unless
your own secret manager performs the matching decode before calling Viby.

### Automate creation with a GitHub App manifest

A product setup command can create the app interactively without asking the developer to copy
every form field. Render a form that posts a JSON `manifest` value to the personal or organization
GitHub App creation URL:

```ts
const manifest = {
  name: "Viby Builder",
  url: "https://app.example",
  redirect_url: "https://app.example/setup/github/manifest",
  callback_urls: ["https://app.example/api/viby/integrations/callback"],
  setup_url: "https://app.example/settings/integrations",
  request_oauth_on_install: true,
  public: false,
  default_permissions: {
    contents: "write",
    pull_requests: "write",
  },
};
```

After the developer approves GitHub's creation screen, exchange the returned `code` server-side
at `POST https://api.github.com/app-manifests/{code}/conversions`. Move the returned app ID,
client credentials, PEM private key, slug, and webhook secret directly into the host secret
manager. Do not render or log the conversion response; the manifest code is short-lived and the
generated private key should be treated as a one-time credential delivery.

See GitHub's [App manifest reference](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
for the personal and organization form URLs and the full parameter list. Add a webhook URL and
events only when the host application actually consumes them; Viby repository operations do not
require a webhook.

```ts
import { github } from "@viby/sdk/integrations/github";

const repository = github({
  appId: env.GITHUB_APP_ID,
  clientId: env.GITHUB_APP_CLIENT_ID,
  clientSecret: env.GITHUB_APP_CLIENT_SECRET,
  privateKey: env.GITHUB_APP_PRIVATE_KEY,
  slug: env.GITHUB_APP_SLUG,
});
```

Install the app on a test account and choose **Only select repositories** for the first check. Viby
verifies that the authorizing GitHub user can access the returned installation before it stores an
encrypted connection.

See the [GitHub repository integration](/docs/integrations/github) for import, push, branch,
pull-request, conflict, and source-limit behavior.

## 4. Configure the optional providers

Cloudflare, GitLab, and Bitbucket use ordinary OAuth clients. Their client secrets are host credentials;
their returned user tokens stay encrypted behind the Viby secret-store boundary.

### Cloudflare Pages

Create a server-side OAuth client with the Authorization Code grant, the exact Viby callback URL,
Pages Write access, and account-read access. Copy the scope identifiers exactly as configured by
Cloudflare:

```bash title=".env.local"
CLOUDFLARE_CLIENT_ID=
CLOUDFLARE_CLIENT_SECRET=
CLOUDFLARE_OAUTH_SCOPES=
```

Cloudflare Pages accepts prebuilt assets, so the host must also configure a sandbox, an artifact
store, and the framework's build command. The [Cloudflare deployment integration](/docs/integrations/cloudflare)
documents that complete path.

### Bitbucket Cloud

Create an OAuth consumer in the Bitbucket workspace with the callback URL and these permissions:
Account read; Repositories read/write; Repository admin only for repository creation; Pull
requests read/write.

```bash title=".env.local"
BITBUCKET_CLIENT_ID=
BITBUCKET_CLIENT_SECRET=
```

See the [Bitbucket repository integration](/docs/integrations/bitbucket) for workspace discovery,
imports, pushes, pull requests, and Bitbucket's disconnect limitation.

### GitLab

Create a GitLab OAuth application with the exact callback URL and the `api` scope. Applications can
be user-, group-, or instance-owned. For self-managed GitLab, retain the instance root URL too.

```bash title=".env.local"
GITLAB_CLIENT_ID=
GITLAB_CLIENT_SECRET=
GITLAB_BASE_URL=https://gitlab.com
```

See the [GitLab repository integration](/docs/integrations/gitlab) for GitLab.com, self-managed
instances, namespace discovery, immutable pushes, and merge requests.

## 5. Configure Viby once

Provider IDs are application-owned keys. The product can rename them, show friendly labels, and
offer only the providers it supports without changing the repository or deployment workflow.

```ts
import { createViby } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";
import { github } from "@viby/sdk/integrations/github";
import { bitbucket } from "@viby/sdk/integrations/bitbucket";
import { gitlab } from "@viby/sdk/integrations/gitlab";
import { cloudflare } from "@viby/sdk/integrations/cloudflare";
import { vercel } from "@viby/sdk/integrations/vercel";

export const viby = createViby({
  framework: "farmjs",
  model: openai(env.OPENAI_MODEL),
  integrations: {
    repository: {
      github: github({
        appId: env.GITHUB_APP_ID,
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        slug: env.GITHUB_APP_SLUG,
      }),
      bitbucket: bitbucket({
        clientId: env.BITBUCKET_CLIENT_ID,
        clientSecret: env.BITBUCKET_CLIENT_SECRET,
      }),
      gitlab: gitlab({
        clientId: env.GITLAB_CLIENT_ID,
        clientSecret: env.GITLAB_CLIENT_SECRET,
        baseUrl: env.GITLAB_BASE_URL,
      }),
    },
    deployment: {
      vercel: vercel({
        clientId: env.VERCEL_CLIENT_ID,
        clientSecret: env.VERCEL_CLIENT_SECRET,
        slug: env.VERCEL_INTEGRATION_SLUG,
      }),
      cloudflare: cloudflare({
        clientId: env.CLOUDFLARE_CLIENT_ID,
        clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
        scopes: env.CLOUDFLARE_OAUTH_SCOPES.split(" ").filter(Boolean),
      }),
    },
  },
});
```

Omit providers that are not configured. Do not pass empty credentials to their factories.

## 6. Mount one callback and connect a user

The Web API host already exposes `GET` and `POST /integrations/callback`. If the product mounts
Viby operations manually, use the same Web-standard callback for every provider:

```ts
export async function integrationCallback(request: Request) {
  const completed = await viby.integrations.callback(request);
  return Response.redirect(new URL(completed.returnTo, request.url));
}
```

Start a connection from the authenticated product session:

```ts
const user = viby.forUser({ tenantId, userId });

const connection = await user.integrations.repository.connect("github", {
  callbackUrl: "https://app.example/api/viby/integrations/callback",
  returnTo: `/projects/${projectId}/settings`,
});

if (connection.status === "authorization-required") {
  return Response.redirect(connection.url);
}
```

Viby hashes and expires the authorization state, binds it to the tenant, user, category, provider,
and callback URL, and consumes it once. The provider access token never crosses this server
boundary.

## 7. Verify before production

Use a disposable provider account, repository, and project for the first end-to-end check:

1. Run `npx viby db migrate` against the intended database.
2. Start one provider connection and complete its authorization screen.
3. Reload the connection after restarting the host process.
4. Import or generate a small project.
5. Push it to a disposable branch and open a draft pull request.
6. Create a preview deployment, refresh its status, and reload deployment history.
7. Delete the disposable provider resources and disconnect the Viby connection.

Repository maintainers can also run the environment-gated live-provider suite against disposable
resources. It is intentionally separate from ordinary package CI and the public integration flow.

Before shipping, confirm that:

- every secret exists only in a server environment or secret manager;
- `.env*`, private keys, and pulled Vercel environment files are ignored by Git;
- development, preview, and production use separate callback URLs and provider registrations when
  their providers require exact redirects;
- logs redact authorization codes, access tokens, private keys, database URLs, and model keys;
- `VIBY_SECRET_KEY` is backed up and access is restricted;
- provider permissions are the minimum needed for the product features you expose.
