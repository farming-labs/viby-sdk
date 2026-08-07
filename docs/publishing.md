# Publishing `@viby/sdk`

The repository validates the same artifact that npm receives. `npm run release:check` runs typechecking, unit tests, compilation, tarball-content assertions, installation into a clean consumer project, a public-import check, and a CLI smoke test.

## One-time first publish

`@viby/sdk` must exist on npm before npm lets the package configure a trusted publisher. Confirm that your npm account can publish public packages in the `@viby` organization and has two-factor authentication enabled, then publish `0.2.0` once from a trusted workstation:

```bash
npm login
npm ci
npm run release:guard
npm publish --access public
```

The package's `prepublishOnly` hook runs the complete release check before uploading anything.

Alternatively, add a short-lived granular npm token as the `NPM_TOKEN` secret in the GitHub `npm` environment, dispatch `publish.yml` from `main`, and delete the secret immediately after the first release. Later releases should use OIDC instead of a long-lived token.

## Configure trusted publishing

After the first version exists, open the package settings on npm, choose **Trusted Publisher → GitHub Actions**, and enter:

- Organization: `farming-labs`
- Repository: `viby-sdk`
- Workflow filename: `publish.yml`
- Environment: `npm`
- Allowed action: `npm publish`

The workflow uses a GitHub-hosted runner, `id-token: write`, Node 24, and npm 11.18.0. npm trusted publishing generates provenance automatically. Configure required reviewers on the GitHub `npm` environment if a human approval should gate every release, then remove any bootstrap `NPM_TOKEN` secret.

## Publish a release

1. Update the version in `package.json` and `package-lock.json`.
2. Merge a PR whose CI checks pass.
3. Publish a GitHub release with a tag matching `v<package version>`, such as `v0.2.0`.

The release guard rejects mismatched tags and versions that already exist on npm. `publish.yml` can also be dispatched manually from `main` for recovery.

The trusted-publisher requirements are maintained in the [official npm documentation](https://docs.npmjs.com/trusted-publishers/).
