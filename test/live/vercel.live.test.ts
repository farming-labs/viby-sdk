import assert from "node:assert/strict";
import { vercel } from "../../src/integration-vercel.js";
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

liveProviderTest("vercel", "verifies a connection and preview deployment", async () => {
  const accessToken = requiredEnvironment("VIBY_LIVE_VERCEL_ACCESS_TOKEN");
  const teamId = optionalEnvironment("VIBY_LIVE_VERCEL_TEAM_ID");
  const projectId = requiredEnvironment("VIBY_LIVE_VERCEL_PROJECT_ID");
  const apiUrl = optionalEnvironment("VIBY_LIVE_VERCEL_API_URL") ?? "https://api.vercel.com";
  const adapter = vercel({
    clientId: "unused-by-live-credential-test",
    clientSecret: "unused-by-live-credential-test",
    slug: "viby-live-test",
    apiUrl,
  });
  const context: IntegrationOperationContext = {
    tenantId: "live-provider-tests",
    userId: "vercel",
    connectionId: "live-vercel-connection",
    externalAccount: {
      id: teamId ?? "personal",
      name: teamId ? `Vercel team ${teamId}` : "Vercel personal account",
      metadata: { teamId },
    },
    credential: encodedCredential({
      version: 1,
      accessToken,
      teamId,
      userId: null,
      configurationId: null,
    }),
  };

  await adapter.listProjects({ limit: 1 }, context);
  const project = await adapter.getProject({ id: projectId }, context);
  assert.ok(project, `Vercel live-test project ${projectId} was not found.`);
  await withCleanup(async (cleanup) => {
    const name = disposableName("vercel");
    const idempotencyKey = `live:${name}`;
    let deploymentId: string | null = null;
    cleanup(trackedCleanup({
      provider: "vercel",
      kind: "deployment",
      projectId,
      idempotencyKey,
    }, async () => {
      if (!deploymentId) {
        const lookup = new URL("/v6/deployments", apiUrl);
        lookup.searchParams.set("projectId", projectId);
        lookup.searchParams.set("limit", "1");
        lookup.searchParams.set("meta-vibyIdempotencyKey", idempotencyKey);
        if (teamId) lookup.searchParams.set("teamId", teamId);
        const response = await providerRequest(lookup, {
          headers: { authorization: `Bearer ${accessToken}` },
        }, [200]);
        const payload = await response.json() as {
          readonly deployments?: readonly { readonly id?: string; readonly uid?: string }[];
        };
        deploymentId = payload.deployments?.[0]?.id ?? payload.deployments?.[0]?.uid ?? null;
      }
      if (!deploymentId) return;
      const deletion = new URL(`/v13/deployments/${encodeURIComponent(deploymentId)}`, apiUrl);
      if (teamId) deletion.searchParams.set("teamId", teamId);
      await providerRequest(deletion, {
        method: "DELETE",
        headers: { authorization: `Bearer ${accessToken}` },
      }, [200, 204, 404]);
    }));

    const deployment = await adapter.deployVersion({
      project: project.id,
      environment: "preview",
      idempotencyKey,
      files: [sourceFile(
        "index.html",
        "<!doctype html><html><body><main>Viby Vercel live verification</main></body></html>",
      )],
      providerOptions: { skipAutoDetectionConfirmation: true },
    }, context);
    deploymentId = deployment.id;
    assert.equal(deployment.environment, "preview");
    const ready = await waitForDeployment(
      () => adapter.getDeployment({ id: deployment.id }, context),
    );
    assert.equal(ready.projectId, project.id);
    assert.equal(ready.environment, "preview",
      "The dedicated Vercel project classified the requested preview as another environment.");
    assert.ok(ready.url?.startsWith("https://"));
  });
});
