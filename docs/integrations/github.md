---
title: "GitHub repository integration"
description: "Connect a GitHub App installation, import source, push immutable versions, and open pull requests."
---

# GitHub repository integration

The GitHub adapter connects each Viby user to a GitHub App installation while keeping GitHub credentials inside Viby's secret-store boundary.

## GitHub App configuration

Create a GitHub App owned by your product or organization and configure:

- a callback URL pointing to the application route that calls `viby.integrations.callback(request)`;
- **Request user authorization (OAuth) during installation**, which lets Viby verify that the signed-in GitHub user can access the returned installation;
- repository **Metadata: read**;
- repository **Contents: read and write**;
- repository **Pull requests: read and write**;
- repository **Administration: read and write** if the product will create repositories.

GitHub warns that an `installation_id` received by a setup URL can be spoofed. The adapter therefore exchanges the installation OAuth code, lists installations accessible to that user, verifies the selected installation, and only then creates its one-hour installation token. The user token and installation token are encrypted by the configured Viby secret store and never appear in public connection objects.

See GitHub's documentation for [sharing an app with installation state](https://docs.github.com/en/apps/sharing-github-apps/sharing-your-github-app), [setup URL security](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url), and [installation access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app).

## SDK configuration

```ts
import { createViby } from "@viby/sdk";
import { github } from "@viby/sdk/integrations/github";

const viby = createViby({
  framework: "farmjs",
  model,
  integrations: {
    repository: {
      github: github({
        appId: env.GITHUB_APP_ID,
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        slug: "viby",
      }),
    },
  },
});
```

`privateKey` accepts a PEM string, including the common environment-variable form containing escaped `\\n` line breaks. `apiUrl`, `webUrl`, `installationUrl`, `apiVersion`, and `fetch` can be overridden for compatible enterprise or test environments.

## Connect and handle the callback

```ts
const user = viby.forUser({ tenantId, userId });
const connection = await user.integrations.repository.connect("github", {
  callbackUrl: "https://app.example/api/integrations/callback",
  returnTo: "/projects/new",
  authorization: { account: "existing" },
});

if (connection.status === "authorization-required") {
  return Response.redirect(connection.url);
}

// In GET /api/integrations/callback:
const completed = await viby.integrations.callback(request);
return Response.redirect(new URL(completed.returnTo, request.url));
```

Use `authorization.account` to make the account intent explicit:

- `"existing"` runs the GitHub App OAuth flow, lists installations accessible to the authorized
  user, and reconnects the only available installation without asking them to reinstall the app.
- `"new"` opens the GitHub App installation flow for a new account or organization.
- omit `authorization` to preserve the install-first behavior used by earlier SDK versions.

When the authorized user can access more than one installation, provide the selected provider
identifier after an account-selection step:

```ts
await user.integrations.repository.connect("github", {
  callbackUrl: "https://app.example/api/integrations/callback",
  returnTo: "/projects/new",
  authorization: {
    account: "existing",
    externalAccountId: "155948974",
  },
});
```

The preference is provider-neutral and is also accepted by the Web API and typed web client.
Products can present “Use installed app” and “Install on another account” without introducing a
GitHub-specific route at their SDK boundary.

The callback state is hashed, expiring, and single-use. GitHub user tokens are refreshed when GitHub enables expiration; installation tokens are renewed before their one-hour expiry. Disconnect attempts to revoke both tokens and always revokes the local connection.

## Import and push

```ts
const githubHandle = user.integrations.repository.use("github");
const chat = await user.chats.import({
  source: githubHandle.source({
    repository: { owner: "acme", name: "starter" },
    ref: { branch: "main" },
  }),
});

const version = await chat.latestVersion();
const result = await version!.push({
  using: githubHandle,
  repository: { owner: "acme", name: "generated-app", createIfMissing: true },
  branch: { name: "feat/generated", from: "main", createIfMissing: true },
  commit: { message: "feat: add generated app" },
  pullRequest: { base: "main", title: "feat: add generated app", draft: true },
});
```

Pushes use GitHub's blob, tree, commit, and reference APIs. Each tree is built without `base_tree`, so the remote commit exactly matches the immutable Viby version: additions, changes, executable bits, binary bytes, and deletions are all represented. References are never force-updated. If the observed head changed, Viby returns a typed conflict with the actual head.

Source reads reject truncated trees, symlinks, submodules, invalid paths, and configured file/byte limits. The defaults are 5,000 files and 25 MB.
