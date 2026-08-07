# Releasing Viby SDK

Viby uses the same local release shape as Farm.js: Bumpp creates and pushes the version commit and tag, then the authenticated workstation publishes the package to npm. Start from a clean, up-to-date `main` branch and sign in to npm before releasing.

## Stable release

```bash
npm whoami
pnpm release
```

The command verifies npm authentication before Bumpp can change anything. Choose and approve the next version in the Bumpp prompt. Bumpp verifies the release is running from `main`, updates `package.json` and `package-lock.json`, confirms the version is available on npm, runs the complete release check, creates `chore: release v<version>`, tags it as `v<version>`, and pushes the commit and tag. The command then runs `npm publish --access public --tag latest` locally and only succeeds after npm accepts the package.

## Prereleases

```bash
pnpm release:beta
pnpm release:canary
```

Beta versions publish with npm's `beta` dist-tag and canary versions with `canary`.

## Verify without releasing

```bash
pnpm release:check
pnpm release:guard
pnpm publish:dry-run
```

## Recover an interrupted release

If Bumpp pushed the version but npm publishing failed, do not bump again. Check out the exact release tag in a clean worktree, authenticate with npm, and publish the existing version with the matching command:

```bash
pnpm publish:latest
# or: pnpm publish:beta
# or: pnpm publish:canary
```

See [docs/publishing.md](./docs/publishing.md) for npm access, two-factor authentication, and recovery details.
