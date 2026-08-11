# Bitbucket repository integration

`@viby/sdk/integrations/bitbucket` connects each product user to Bitbucket Cloud through an OAuth consumer and implements Viby's provider-neutral repository contract. The host owns the OAuth consumer, callback route, database, and secret-encryption key. Access and refresh tokens stay behind the Viby secret-store boundary.

## Bitbucket OAuth consumer

Create an OAuth consumer in the Bitbucket workspace settings. Set its callback URL to the application route that calls `viby.integrations.callback(request)` and grant these permissions:

- Account: read
- Repositories: read, write, and admin if the product creates repositories
- Pull requests: read and write

Bitbucket configures permissions on the consumer. The authorization URL may include `scope`, but requesting fewer scopes does not reduce the consumer's configured grant. Keep the consumer secret only in the server environment. Set `DATABASE_URL` for the default durable connection store and `VIBY_SECRET_KEY` to an independent 32-byte encryption key.

See Bitbucket's official [OAuth guide](https://support.atlassian.com/bitbucket-cloud/docs/use-oauth-on-bitbucket-cloud/) and [repository API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-repositories/) for provider setup.

## SDK configuration

```ts
import { createViby } from "@viby/sdk";
import { bitbucket } from "@viby/sdk/integrations/bitbucket";

const viby = createViby({
  framework: "farm",
  model,
  integrations: {
    repository: {
      bitbucket: bitbucket({
        clientId: env.BITBUCKET_CLIENT_ID,
        clientSecret: env.BITBUCKET_CLIENT_SECRET,
      }),
    },
  },
});
```

`apiUrl`, `authorizationUrl`, `tokenUrl`, `scopes`, `fetch`, and source safety limits can be overridden for compatible gateways or tests. The adapter is for Bitbucket Cloud; provider-specific types do not enter Viby's core repository interfaces.

GitHub and Bitbucket can coexist without changing the calling workflow:

```ts
integrations: {
  repository: {
    github: github({ /* GitHub App settings */ }),
    bitbucket: bitbucket({ /* OAuth consumer settings */ }),
  },
  deployment: {
    vercel: vercel({ /* integration settings */ }),
    cloudflare: cloudflare({ /* OAuth settings */ }),
  },
}
```

## Connect and handle the callback

```ts
const user = viby.forUser({ tenantId, userId });
const connection = await user.integrations.repository.connect("bitbucket", {
  callbackUrl: "https://app.example/api/integrations/callback",
  returnTo: "/projects/new",
});

if (connection.status === "authorization-required") {
  return Response.redirect(connection.url);
}

// In GET /api/integrations/callback:
const completed = await viby.integrations.callback(request);
return Response.redirect(new URL(completed.returnTo, request.url));
```

Viby creates and verifies expiring, hashed, single-use state bound to the tenant, user, category, integration ID, and callback URL. The adapter exchanges the code server-side, loads the authorized Bitbucket identity, encrypts the rotating refresh token, and refreshes the short-lived access token before operations.

Bitbucket Cloud does not document a programmatic OAuth token-revocation endpoint. Disconnect always revokes and deletes Viby's local encrypted connection, which prevents further SDK use, but the provider grant remains visible until the user removes it under Bitbucket **Personal settings → App authorizations**. Reconnecting creates a fresh local credential.

## Discover, import, push, and open a pull request

```ts
const provider = user.integrations.repository.use("bitbucket");

const workspaces = await provider.owners.list();
const repositories = await provider.repositories.list({ owner: "acme" });

const chat = await user.chats.import({
  source: provider.source({
    repository: { owner: "acme", name: "starter" },
    ref: { branch: "main" },
  }),
});

const version = await chat.latestVersion();
const result = await version!.push({
  using: provider,
  repository: { owner: "acme", name: "generated-app", createIfMissing: true },
  branch: { name: "feat/generated", from: "main", createIfMissing: true },
  commit: { message: "feat: add generated app" },
  providerOptions: { author: "Ada Lovelace <ada@example.com>" },
  pullRequest: {
    base: "main",
    title: "feat: add generated app",
    providerOptions: {
      reviewers: ["{bitbucket-reviewer-uuid}"],
      closeSourceBranch: true,
    },
  },
});

if (result.status === "conflict") {
  console.log(result.expectedHead, result.actualHead);
}
```

Workspace, repository, branch, and directory pagination uses opaque cursors. Provider `next` URLs are accepted only when their origin and resource path match the configured Bitbucket API, preventing credential-bearing requests from following an untrusted cursor.

Source import walks the complete commit tree with configured file, byte, and concurrency limits. It downloads bytes without text conversion, preserves executable attributes, validates every project path, and rejects symbolic links and subrepositories.

Pushes use Bitbucket's [source commit endpoint](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-source/). Viby compares the immutable version with the observed remote tree and sends binary-safe multipart additions, edits, executable attributes, and explicit deletions. The `parents` field prevents an observed commit from being silently replaced; an expected-head mismatch produces the portable typed conflict result. A retry with unchanged content returns the current commit without creating another effect.

Pull-request creation and merge use Bitbucket's [pull request API](https://developer.atlassian.com/cloud/bitbucket/rest/api-group-pullrequests/). The portable `merge`, `squash`, and `rebase` choices map to Bitbucket's `merge_commit`, `squash`, and `fast_forward` strategies. A repeated merge first reads the pull request and returns an already-merged result without repeating the effect.

All calls remain tenant/user scoped and require an active connection. Provider errors are wrapped by the connected handle as `IntegrationOperationError`; direct adapter consumers can inspect `BitbucketRepositoryError.status` and `.code`.
