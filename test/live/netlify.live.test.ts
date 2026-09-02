import assert from "node:assert/strict";
import { netlify } from "../../src/integration-netlify.js";
import type { IntegrationOperationContext } from "../../src/integrations.js";
import {
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

liveProviderTest("netlify", "creates a site and verifies an atomic deploy preview", async () => {
  const accessToken = requiredEnvironment("VIBY_LIVE_NETLIFY_ACCESS_TOKEN");
  const accountSlug = requiredEnvironment("VIBY_LIVE_NETLIFY_ACCOUNT_SLUG");
  const accountId = optionalEnvironment("VIBY_LIVE_NETLIFY_ACCOUNT_ID") ?? accountSlug;
  const apiUrl = optionalEnvironment("VIBY_LIVE_NETLIFY_API_URL")
    ?? "https://api.netlify.com/api/v1";
  const adapter = netlify({
    clientId: "unused-by-live-credential-test",
    clientSecret: "unused-by-live-credential-test",
    apiUrl,
  });
  const context: IntegrationOperationContext = {
    tenantId: "live-provider-tests",
    userId: "netlify",
    connectionId: "live-netlify-connection",
    externalAccount: {
      id: "netlify-live-user",
      name: "Netlify live-test user",
      metadata: {
        accounts: [{ id: accountId, name: accountSlug, slug: accountSlug }],
      },
    },
    credential: encodedCredential({ version: 1, accessToken }),
  };

  await adapter.listProjects({ limit: 1 }, context);
  await withCleanup(async (cleanup) => {
    const name = disposableName("netlify");
    const project = await adapter.createProject({
      name,
      providerOptions: { accountSlug },
    }, context);
    cleanup(trackedCleanup({ provider: "netlify", kind: "site", id: project.id, name }, async () => {
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/sites/${encodeURIComponent(project.id)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
        [204, 404],
      );
    }));

    assert.equal((await adapter.getProject({ id: project.id }, context))?.name, name);
    const deployment = await adapter.deployVersion({
      project: project.id,
      environment: "preview",
      idempotencyKey: `live:${name}`,
      files: [sourceFile(
        "index.html",
        "<!doctype html><html><body><main>Viby Netlify live verification</main></body></html>",
      )],
    }, context);
    const ready = await waitForDeployment(
      () => adapter.getDeployment({ id: deployment.id }, context),
    );
    assert.equal(ready.projectId, project.id);
    assert.equal(ready.environment, "preview");
    assert.ok(ready.url?.startsWith("https://"));
  });
});
