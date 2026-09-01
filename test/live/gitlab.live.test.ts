import assert from "node:assert/strict";
import { gitlab } from "../../src/integration-gitlab.js";
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

liveProviderTest("gitlab", "verifies a connection, push, branch, and merge request", async () => {
  const owner = requiredEnvironment("VIBY_LIVE_GITLAB_OWNER");
  const accessToken = optionalEnvironment("VIBY_LIVE_GITLAB_ACCESS_TOKEN")
    ?? "refresh-required";
  const refreshToken = optionalEnvironment("VIBY_LIVE_GITLAB_REFRESH_TOKEN");
  if (accessToken === "refresh-required" && !refreshToken) {
    requiredEnvironment("VIBY_LIVE_GITLAB_ACCESS_TOKEN");
  }
  const baseUrl = optionalEnvironment("VIBY_LIVE_GITLAB_BASE_URL") ?? "https://gitlab.com";
  const clientId = optionalEnvironment("VIBY_LIVE_GITLAB_CLIENT_ID")
    ?? "unused-by-live-credential-test";
  const clientSecret = optionalEnvironment("VIBY_LIVE_GITLAB_CLIENT_SECRET")
    ?? "unused-by-live-credential-test";
  const adapter = gitlab({ clientId, clientSecret, baseUrl });
  let credential: IntegrationCredential = {
    secret: encodedCredential({
      version: 1,
      accessToken,
      refreshToken,
      redirectUri: "https://localhost.invalid/viby-live-gitlab",
    }),
    expiresAt: null,
    scopes: ["api"],
  };
  if (refreshToken) {
    credential = await adapter.connection.refreshCredential!(credential, {
      tenantId: "live-provider-tests",
      userId: "gitlab",
    });
  }
  const activeAccessToken = String(decodedCredential(credential).accessToken);
  const context: IntegrationOperationContext = {
    tenantId: "live-provider-tests",
    userId: "gitlab",
    connectionId: "live-gitlab-connection",
    externalAccount: { id: owner, name: owner },
    credential: credential.secret,
  };

  await adapter.listRepositories({ owner, limit: 1 }, context);
  await withCleanup(async (cleanup) => {
    const name = disposableName("gitlab");
    cleanup(trackedCleanup({ provider: "gitlab", kind: "repository", owner, name }, async () => {
      await providerRequest(
        `${baseUrl.replace(/\/$/, "")}/api/v4/projects/${encodeURIComponent(`${owner}/${name}`)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${activeAccessToken}` } },
        [202, 204, 404],
      );
    }));
    const repository = await adapter.createRepository({
      owner,
      name,
      visibility: "private",
      description: "Disposable Viby SDK GitLab verification repository.",
    }, context);
    assert.equal(repository.name, name);
    const target: RepositoryReference = { owner, name };
    const initial = await adapter.pushVersion({
      repository: target,
      branch: repository.defaultBranch,
      createBranch: true,
      message: "test: initialize live GitLab verification repository",
      files: [sourceFile("README.md", "# Viby GitLab live verification\n")],
    }, context);
    assert.equal(initial.status, "pushed");
    if (initial.status !== "pushed") return;
    const branch = await adapter.createBranch({
      repository: target,
      name: "feat/live-verification",
      from: initial.commit.id,
    }, context);
    const pushed = await adapter.pushVersion({
      repository: target,
      branch: branch.name,
      expectedHead: branch.head,
      message: "feat: verify Viby GitLab integration",
      files: [
        sourceFile("README.md", "# Viby GitLab live verification\n"),
        sourceFile("src/index.ts", "export const provider = 'gitlab';\n"),
      ],
    }, context);
    assert.equal(pushed.status, "pushed");
    const mergeRequest = await adapter.createPullRequest({
      repository: target,
      head: branch.name,
      base: repository.defaultBranch,
      title: "test: verify Viby GitLab integration",
      body: "Created automatically and removed with its disposable project.",
      draft: true,
    }, context);
    assert.equal(mergeRequest.head, branch.name);
    assert.equal(mergeRequest.base, repository.defaultBranch);
    assert.ok(mergeRequest.url);
  });
});
