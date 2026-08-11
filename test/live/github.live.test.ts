import assert from "node:assert/strict";
import { github } from "../../src/integration-github.js";
import type { IntegrationOperationContext, RepositoryReference } from "../../src/integrations.js";
import {
  decodedCredential,
  disposableName,
  encodedCredential,
  liveProviderTest,
  optionalEnvironment,
  providerRequest,
  requiredEnvironment,
  sourceFile,
  trackedCleanup,
  withCleanup,
} from "./helpers.js";

liveProviderTest("github", "verifies an installation, push, branch, and pull request", async () => {
  const appId = requiredEnvironment("VIBY_LIVE_GITHUB_APP_ID");
  const privateKey = requiredEnvironment("VIBY_LIVE_GITHUB_APP_PRIVATE_KEY");
  const installationId = Number(requiredEnvironment("VIBY_LIVE_GITHUB_INSTALLATION_ID"));
  const owner = requiredEnvironment("VIBY_LIVE_GITHUB_OWNER");
  const accountKind = optionalEnvironment("VIBY_LIVE_GITHUB_ACCOUNT_KIND") ?? "organization";
  assert.match(accountKind, /^(organization|user)$/,
    "VIBY_LIVE_GITHUB_ACCOUNT_KIND must be organization or user.");
  const targetType = accountKind === "user" ? "User" : "Organization";
  const userToken = optionalEnvironment("VIBY_LIVE_GITHUB_USER_TOKEN")
    ?? (targetType === "User"
      ? requiredEnvironment("VIBY_LIVE_GITHUB_USER_TOKEN")
      : "unused-for-organization-installation");
  const apiUrl = optionalEnvironment("VIBY_LIVE_GITHUB_API_URL") ?? "https://api.github.com";
  assert.ok(Number.isSafeInteger(installationId) && installationId > 0,
    "VIBY_LIVE_GITHUB_INSTALLATION_ID must be a positive integer.");

  const adapter = github({
    appId,
    clientId: "unused-by-live-installation-test",
    clientSecret: "unused-by-live-installation-test",
    privateKey,
    slug: "viby-live-test",
    apiUrl,
  });
  const refreshed = await adapter.connection.refreshCredential!({
    secret: encodedCredential({
      version: 1,
      installationId,
      installationToken: "refresh-required",
      userToken,
      userExpiresAt: null,
      userRefreshToken: null,
      userRefreshExpiresAt: null,
    }),
    expiresAt: new Date(0),
    scopes: [],
  }, { tenantId: "live-provider-tests", userId: "github" });
  const credential = decodedCredential(refreshed);
  const installationToken = String(credential.installationToken);
  const context: IntegrationOperationContext = {
    tenantId: "live-provider-tests",
    userId: "github",
    connectionId: `installation-${installationId}`,
    externalAccount: {
      id: String(installationId),
      name: owner,
      metadata: { installationId: String(installationId), targetType },
    },
    credential: refreshed.secret,
  };

  await adapter.listRepositories({ limit: 1 }, context);
  await withCleanup(async (cleanup) => {
    const name = disposableName("github");
    cleanup(trackedCleanup({ provider: "github", kind: "repository", owner, name }, async () => {
      await providerRequest(
        `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${installationToken}`,
            "x-github-api-version": "2022-11-28",
          },
        },
        [204, 404],
      );
    }));
    const repository = await adapter.createRepository({
      owner,
      name,
      visibility: "private",
      description: "Disposable Viby SDK live-provider verification repository.",
    }, context);
    assert.equal(repository.name, name);
    const target: RepositoryReference = { owner, name };
    const initial = await adapter.pushVersion({
      repository: target,
      branch: "main",
      createBranch: true,
      message: "test: initialize live verification repository",
      files: [sourceFile("README.md", "# Viby live provider verification\n")],
    }, context);
    assert.equal(initial.status, "pushed");

    const branch = await adapter.createBranch({
      repository: target,
      name: "feat/live-verification",
      from: "main",
    }, context);
    assert.equal(branch.name, "feat/live-verification");
    const pushed = await adapter.pushVersion({
      repository: target,
      branch: branch.name,
      expectedHead: branch.head,
      message: "feat: verify Viby GitHub integration",
      files: [
        sourceFile("README.md", "# Viby live provider verification\n"),
        sourceFile("src/index.ts", "export const provider = 'github';\n"),
      ],
    }, context);
    assert.equal(pushed.status, "pushed");
    const pullRequest = await adapter.createPullRequest({
      repository: target,
      head: branch.name,
      base: "main",
      title: "test: verify Viby GitHub integration",
      body: "Created automatically and removed with its disposable repository.",
      draft: true,
    }, context);
    assert.equal(pullRequest.head, branch.name);
    assert.equal(pullRequest.base, "main");
    assert.ok(pullRequest.url);
  });
});
