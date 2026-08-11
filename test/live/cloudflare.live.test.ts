import assert from "node:assert/strict";
import { cloudflare } from "../../src/integration-cloudflare.js";
import type { IntegrationCredential, IntegrationOperationContext } from "../../src/integrations.js";
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
  waitForDeployment,
  withCleanup,
} from "./helpers.js";

liveProviderTest("cloudflare", "verifies a connection and Pages deployment", async () => {
  const accountId = requiredEnvironment("VIBY_LIVE_CLOUDFLARE_ACCOUNT_ID");
  const accessToken = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_ACCESS_TOKEN")
    ?? "refresh-required";
  const refreshToken = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_REFRESH_TOKEN");
  const clientId = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_CLIENT_ID")
    ?? "unused-by-live-credential-test";
  const clientSecret = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_CLIENT_SECRET")
    ?? "unused-by-live-credential-test";
  if (accessToken === "refresh-required" && !refreshToken) {
    requiredEnvironment("VIBY_LIVE_CLOUDFLARE_ACCESS_TOKEN");
  }
  const apiUrl = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_API_URL")
    ?? "https://api.cloudflare.com/client/v4";
  const adapter = cloudflare({
    clientId,
    clientSecret,
    apiUrl,
    scopes: ["account:read", "pages:write"],
  });
  let credential: IntegrationCredential = {
    secret: encodedCredential({ version: 1, accessToken, refreshToken }),
    expiresAt: null,
    scopes: [],
  };
  if (refreshToken) {
    credential = await adapter.connection.refreshCredential!(credential, {
      tenantId: "live-provider-tests",
      userId: "cloudflare",
    });
  }
  const activeAccessToken = String(decodedCredential(credential).accessToken);
  const context: IntegrationOperationContext = {
    tenantId: "live-provider-tests",
    userId: "cloudflare",
    connectionId: "live-cloudflare-connection",
    externalAccount: {
      id: accountId,
      name: `Cloudflare account ${accountId}`,
      metadata: { accounts: [{ id: accountId, name: `Cloudflare account ${accountId}` }] },
    },
    credential: credential.secret,
  };

  await adapter.listProjects({ limit: 1 }, context);
  await withCleanup(async (cleanup) => {
    const name = disposableName("cloudflare");
    cleanup(trackedCleanup({
      provider: "cloudflare",
      kind: "pages-project",
      accountId,
      name,
    }, async () => {
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/accounts/${encodeURIComponent(accountId)}`
          + `/pages/projects/${encodeURIComponent(name)}`,
        {
          method: "DELETE",
          headers: { authorization: `Bearer ${activeAccessToken}` },
        },
        [200, 404],
      );
    }));
    const project = await adapter.createProject({
      name,
      providerOptions: { accountId, productionBranch: "main" },
    }, context);

    const deployment = await adapter.deployVersion({
      project: project.id,
      environment: "preview",
      idempotencyKey: `live:${name}`,
      files: [sourceFile(
        "dist/index.html",
        "<!doctype html><html><body><main>Viby Cloudflare live verification</main></body></html>",
      )],
      providerOptions: {
        assetsDirectory: "dist",
        branch: "feat/live-verification",
      },
    }, context);
    const ready = await waitForDeployment(
      () => adapter.getDeployment({ id: deployment.id }, context),
    );
    assert.equal(ready.projectId, project.id);
    assert.ok(ready.url?.startsWith("https://"));
  });
});
