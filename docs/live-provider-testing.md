---
title: "Live provider verification"
description: "Run the opt-in adapter suite against disposable GitHub, Bitbucket, Vercel, and Cloudflare resources."
---

# Live provider verification

The live provider suite verifies the shipped adapters against disposable resources in real GitHub, Bitbucket, Vercel, and Cloudflare accounts. It is intentionally excluded from ordinary pull-request CI because it creates external resources and requires user-owned credentials.

The suite is fail-closed. It runs only when `VIBY_LIVE_PROVIDER_TESTS=1` is present, and `VIBY_LIVE_PROVIDERS` selects `github`, `bitbucket`, `vercel`, `cloudflare`, or `all`. Selecting a provider without its required environment variables fails instead of silently skipping it.

## Safety and cleanup

Every resource receives a generated `viby-live-<provider>-...` identity. Cleanup is registered before the external effect and runs in `finally`-equivalent control flow, including when a later assertion or provider operation fails. The suite also records only these non-secret resource identities in the ignored `.viby-live-cleanup.json` recovery file. The manual workflow runs `npm run test:providers:cleanup` in an `always()` step, so a failed or interrupted test can recover and remove pending resources. A cleanup failure fails the workflow and retains the generated identity for an operator to remove manually.

The tests create only:

- a private GitHub repository, two branches, commits, and a draft pull request;
- a private Bitbucket repository, two branches, commits, and a draft pull request;
- a preview deployment in a dedicated Vercel test project;
- a Cloudflare Pages project and preview deployment.

Deleting each disposable repository, Pages project, or Vercel deployment removes the generated resource and its children. The suite never modifies source in an existing repository or creates a production deployment. Vercel is the one exception to project creation: the test uses a caller-owned, dedicated test project because Vercel may classify the first no-Git deployment in a fresh project as production.

## Run locally

Copy `test/live/.env.example` to an ignored file, export the variables in your shell, and run:

```bash
npm run test:providers:live
```

For one provider:

```bash
VIBY_LIVE_PROVIDER_TESTS=1 \
VIBY_LIVE_PROVIDERS=github \
npm run test:providers:live
```

The command exits successfully with skipped tests when the explicit live-test flag is absent. It never reads the normal application `.env` automatically.

If a local run is externally interrupted, rerun cleanup with the same exported credentials:

```bash
VIBY_LIVE_PROVIDER_TESTS=1 npm run test:providers:cleanup
```

## GitHub

Set:

- `VIBY_LIVE_GITHUB_APP_ID`
- `VIBY_LIVE_GITHUB_APP_PRIVATE_KEY`
- `VIBY_LIVE_GITHUB_INSTALLATION_ID`
- `VIBY_LIVE_GITHUB_OWNER`
- optional `VIBY_LIVE_GITHUB_ACCOUNT_KIND=user`; the default is `organization`
- `VIBY_LIVE_GITHUB_USER_TOKEN` only for a user-owned installation

The test uses the App private key and installation ID to request a fresh installation token. The App must be installed for all repositories in the disposable owner and have Metadata read, Contents read/write, Pull requests read/write, and Administration read/write. Administration access is required for repository creation and deletion.

## Vercel

Set `VIBY_LIVE_VERCEL_ACCESS_TOKEN` to a connected external-integration credential, set `VIBY_LIVE_VERCEL_PROJECT_ID` to a dedicated test project with an existing baseline deployment, and optionally set `VIBY_LIVE_VERCEL_TEAM_ID`. The integration needs Project and Deployment read/write access. The test lists and reads the project to verify the connection, deploys a static preview, waits for Vercel to confirm the preview environment, and deletes only that deployment. If deployment creation loses its response, cleanup recovers the deployment through its unique Viby idempotency metadata before deleting it.

## Cloudflare

Set `VIBY_LIVE_CLOUDFLARE_ACCOUNT_ID` plus either:

- `VIBY_LIVE_CLOUDFLARE_ACCESS_TOKEN`; or
- `VIBY_LIVE_CLOUDFLARE_REFRESH_TOKEN`, `VIBY_LIVE_CLOUDFLARE_CLIENT_ID`, and `VIBY_LIVE_CLOUDFLARE_CLIENT_SECRET`.

The OAuth grant needs account read and Pages write access. When a refresh token is supplied, the test refreshes it before any provider operation. It lists Pages projects, deploys immutable `dist` content, waits for readiness, and deletes the Pages project.

## Bitbucket

Set `VIBY_LIVE_BITBUCKET_WORKSPACE` plus either:

- `VIBY_LIVE_BITBUCKET_ACCESS_TOKEN`; or
- `VIBY_LIVE_BITBUCKET_REFRESH_TOKEN`, `VIBY_LIVE_BITBUCKET_CLIENT_ID`, and `VIBY_LIVE_BITBUCKET_CLIENT_SECRET`.

The OAuth consumer needs account, repository read/write/admin, and pull-request read/write permissions. When a refresh token is supplied, the test refreshes it first. It verifies repository discovery, creates a private repository, pushes `main`, creates and updates a feature branch, opens a draft pull request, and deletes the repository.

## GitHub Actions

The **Live provider verification** workflow is available only through `workflow_dispatch`. Choose one provider or `all` and confirm disposable cleanup. Store the matching variables from `test/live/.env.example` as secrets in the `live-provider-tests` GitHub environment. Environment protection rules can require a maintainer to approve each run before credentials are released.
