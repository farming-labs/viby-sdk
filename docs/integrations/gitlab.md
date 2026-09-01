---
title: "GitLab repository integration"
description: "Connect GitLab.com or self-managed GitLab, import source, push immutable versions, and open merge requests."
---

# GitLab repository integration

`@viby/sdk/integrations/gitlab` connects each product user through a GitLab OAuth application and
implements Viby's provider-neutral repository contract. It works with GitLab.com, GitLab Dedicated,
and self-managed instances that expose the v4 REST API. The host owns the OAuth application,
callback route, persistence, and secret-encryption key; GitLab tokens remain behind Viby's secret
store and are never returned to the browser, model, or ordinary records.

## Create the OAuth application

Create a user-, group-, or instance-owned GitLab OAuth application. Configure the exact callback
URL handled by `viby.integrations.callback(request)` and grant the `api` scope. `api` is required
because the adapter creates projects, commits complete snapshots, creates branches, and manages
merge requests in addition to reading repositories.

```bash title=".env.local"
GITLAB_CLIENT_ID=
GITLAB_CLIENT_SECRET=
```

GitLab's official references describe [OAuth authorization-code and refresh flows](https://docs.gitlab.com/api/oauth2/)
and [REST API authentication](https://docs.gitlab.com/api/rest/authentication/). Keep the client
secret server-only. Configure `DATABASE_URL` and an independent 32-byte `VIBY_SECRET_KEY` when
using the default durable connection stores.

## Configure Viby

```ts
import { createViby } from "@viby/sdk";
import { gitlab } from "@viby/sdk/integrations/gitlab";

const viby = createViby({
  framework: "farmjs",
  model,
  integrations: {
    repository: {
      gitlab: gitlab({
        clientId: env.GITLAB_CLIENT_ID,
        clientSecret: env.GITLAB_CLIENT_SECRET,
      }),
    },
  },
});
```

For a self-managed instance, set only `baseUrl`; the adapter derives `/api/v4`,
`/oauth/authorize`, `/oauth/token`, and `/oauth/revoke` from that origin:

```ts
gitlab({
  clientId: env.GITLAB_CLIENT_ID,
  clientSecret: env.GITLAB_CLIENT_SECRET,
  baseUrl: "https://gitlab.example.com",
});
```

`apiUrl`, the OAuth endpoint URLs, `scopes`, `fetch`, and source safety limits remain explicit test
or gateway escape hatches. Every endpoint must stay on the configured GitLab origin, and opaque
pagination cursors are rejected if they escape the configured v4 API resource.

## Connect a user

```ts
const user = viby.forUser({ tenantId, userId });
const connection = await user.integrations.repository.connect("gitlab", {
  callbackUrl: "https://app.example.com/api/viby/integrations/callback",
  returnTo: "/settings/integrations",
});

if (connection.status === "authorization-required") {
  redirect(connection.url);
}
```

The callback verifies Viby's expiring single-use state, then the adapter exchanges the code with
the original redirect URI, loads `/user`, and stores access/refresh tokens as encrypted opaque
bytes. Refresh rotates the provider credential; disconnect calls GitLab's OAuth revoke endpoint
before Viby deletes its local connection.

## Import, push, and merge

The product workflow is identical to every other repository provider:

```ts
const repository = user.integrations.repository.use("gitlab");
const chat = await user.chats.import({
  source: repository.source({
    repository: { owner: "platform/frontend", name: "starter" },
    ref: { branch: "main" },
  }),
});

const version = await chat.latestVersion();
const result = await version!.push({
  using: repository,
  repository: {
    owner: "platform/frontend",
    name: "generated-app",
    createIfMissing: true,
  },
  branch: { name: "feat/dashboard", from: "main", createIfMissing: true },
  commit: { message: "feat: add generated dashboard" },
  pullRequest: { base: "main", title: "feat: add generated dashboard", draft: true },
});
```

Namespace discovery includes personal and group namespaces, including nested group paths. Source
reads resolve a branch, tag, or commit and recursively download binary-safe blobs. Symbolic links
and submodules are rejected rather than materialized outside the generated workspace.

Pushes compare the immutable version with the observed remote tree and send one GitLab Commits API
transaction containing create, update, delete, and executable-mode actions. A stale `expectedHead`
returns the provider-neutral conflict result before any write. Provider failures that race the
observed head are re-read and normalized to the same conflict shape.

Merge-request creation uses GitLab's draft-title convention. Portable `merge` and `squash` map to
the merge endpoint and bind the observed head SHA. GitLab rebases are asynchronous, so the adapter
rejects portable `method: "rebase"`; a host that needs that workflow can call GitLab's rebase API
through its own reviewed provider operation before requesting the merge.

Direct adapter failures are `GitLabRepositoryError` values with provider status and code when
available. Connected Viby handles wrap them in the standard `IntegrationOperationError` while
preserving tenant/user ownership and durable push history.
