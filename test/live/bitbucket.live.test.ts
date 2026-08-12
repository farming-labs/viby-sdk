import assert from "node:assert/strict";
import { bitbucket } from "../../src/integration-bitbucket.js";
import type {
  IntegrationCredential,
  IntegrationOperationContext,
  RepositoryReference,
} from "../../src/integrations.js";
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

liveProviderTest("bitbucket", "verifies a connection, push, branch, and pull request", async () => {
  const workspace = requiredEnvironment("VIBY_LIVE_BITBUCKET_WORKSPACE");
  const accessToken = optionalEnvironment("VIBY_LIVE_BITBUCKET_ACCESS_TOKEN")
    ?? "refresh-required";
  const refreshToken = optionalEnvironment("VIBY_LIVE_BITBUCKET_REFRESH_TOKEN");
  const clientId = optionalEnvironment("VIBY_LIVE_BITBUCKET_CLIENT_ID")
    ?? "unused-by-live-credential-test";
  const clientSecret = optionalEnvironment("VIBY_LIVE_BITBUCKET_CLIENT_SECRET")
    ?? "unused-by-live-credential-test";
  if (accessToken === "refresh-required" && !refreshToken) {
    requiredEnvironment("VIBY_LIVE_BITBUCKET_ACCESS_TOKEN");
  }
  const apiUrl = optionalEnvironment("VIBY_LIVE_BITBUCKET_API_URL")
    ?? "https://api.bitbucket.org/2.0";
  const adapter = bitbucket({ clientId, clientSecret, apiUrl });
  let credential: IntegrationCredential = {
    secret: encodedCredential({ version: 1, accessToken, refreshToken }),
    expiresAt: null,
    scopes: [],
  };
  if (refreshToken) {
    credential = await adapter.connection.refreshCredential!(credential, {
      tenantId: "live-provider-tests",
      userId: "bitbucket",
    });
  }
  const activeAccessToken = String(decodedCredential(credential).accessToken);
  const context: IntegrationOperationContext = {
    tenantId: "live-provider-tests",
    userId: "bitbucket",
    connectionId: "live-bitbucket-connection",
    externalAccount: { id: workspace, name: workspace },
    credential: credential.secret,
  };

  await adapter.listRepositories({ owner: workspace, limit: 1 }, context);
  await withCleanup(async (cleanup) => {
    const name = disposableName("bitbucket");
    cleanup(trackedCleanup({
      provider: "bitbucket",
      kind: "repository",
      workspace,
      name,
    }, async () => {
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/repositories/${encodeURIComponent(workspace)}`
          + `/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${activeAccessToken}` },
        },
        [204, 404],
      );
    }));
    const repository = await adapter.createRepository({
      owner: workspace,
      name,
      visibility: "private",
      description: "Disposable Viby SDK live-provider verification repository.",
    }, context);
    assert.equal(repository.name, name);
    const target: RepositoryReference = { owner: workspace, name };
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
    const pushed = await adapter.pushVersion({
      repository: target,
      branch: branch.name,
      expectedHead: branch.head,
      message: "feat: verify Viby Bitbucket integration",
      files: [
        sourceFile("README.md", "# Viby live provider verification\n"),
        sourceFile("src/index.ts", "export const provider = 'bitbucket';\n"),
      ],
    }, context);
    assert.equal(pushed.status, "pushed");
    const pullRequest = await adapter.createPullRequest({
      repository: target,
      head: branch.name,
      base: "main",
      title: "test: verify Viby Bitbucket integration",
      body: "Created automatically and removed with its disposable repository.",
      draft: true,
    }, context);
    assert.equal(pullRequest.head, branch.name);
    assert.equal(pullRequest.base, "main");
    assert.ok(pullRequest.url);
  });
});
