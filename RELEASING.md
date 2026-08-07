# Releasing Viby SDK

Viby uses Bumpp for version commits and tags, then GitHub Actions publishes the package and GitHub Release. Start from a clean, up-to-date `main` branch.

## Stable release

```bash
npm run release
```

Choose the next version in the Bumpp prompt. Bumpp verifies the release is running from `main`, updates `package.json` and `package-lock.json`, runs the complete release check, creates `chore: release v<version>`, tags it as `v<version>`, and pushes the commit and tag.

The pushed tag starts `publish.yml`. The workflow prepares a draft GitHub Release, publishes `@viby/sdk` with npm provenance, and publishes the GitHub Release only after npm succeeds.

## Prereleases

```bash
npm run release:beta
npm run release:canary
```

Beta versions publish with npm's `beta` dist-tag and canary versions with `canary`. Other prerelease identifiers use `next`. Prerelease GitHub Releases are marked accordingly.

## Verify without releasing

```bash
npm run release:check
npm run release:guard
npm publish --dry-run --ignore-scripts
```

## Recover an interrupted release

Do not bump the version again. Dispatch the `Publish` workflow from `main`. It reuses the existing version tag, skips npm if that exact version is already present, and completes an existing draft GitHub Release.

The first npm publication needs either an authenticated local publish or a temporary `NPM_TOKEN` in the GitHub `npm` environment. Remove that token and configure npm trusted publishing after the package exists. See [docs/publishing.md](./docs/publishing.md) for the one-time setup.
