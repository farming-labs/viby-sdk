---
title: "Publishing"
description: "Authenticate a release workstation, validate the package, publish to npm, and recover interrupted releases."
---

# Publishing `@viby/sdk`

Publishing is intentionally local and manually approved. GitHub Actions validates changes, but it does not hold npm credentials or publish releases.

The repository validates the same artifact that npm receives. `pnpm release:check` runs typechecking, unit tests, compilation, tarball-content assertions, installation into a clean consumer project, a public-import check, and a CLI smoke test. The package's `prepublishOnly` hook repeats those checks before npm accepts an upload.

## Authenticate the release workstation

The npm account must be allowed to publish public packages in the `@viby` organization and must satisfy the organization's two-factor authentication policy.

```bash
npm login
npm whoami
npm org ls viby
```

Authentication stays on the release workstation; it is not copied into GitHub.

## Publish a release

Start from a clean, up-to-date `main` branch:

```bash
git switch main
git pull --ff-only
pnpm release
```

The command checks npm authentication before opening the version prompt. After you approve the version, Bumpp updates both manifests, confirms the selected version is available on npm, validates the package, creates and pushes the version commit and tag, and then publishes it locally with npm's `latest` dist-tag. The command exits unsuccessfully if npm rejects the publication.

For prereleases, use `pnpm release:beta` or `pnpm release:canary`. They publish with the matching npm dist-tag.

## Recover a pushed but unpublished version

Do not create another version. Publish the exact tagged source from a clean worktree so the registry artifact matches the Git tag:

```bash
git worktree add ../viby-sdk-release v0.2.2
cd ../viby-sdk-release
npm ci
npm publish --access public --tag latest --provenance=false
```

Replace `v0.2.2` with the interrupted tag. The explicit provenance override is needed for tags created before Viby switched from CI publishing to local publishing. Remove the temporary worktree after confirming the version on npm. npm versions are immutable, so always verify the tag and package version before publishing.
