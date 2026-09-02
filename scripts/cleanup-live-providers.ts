import { bitbucket } from "../src/integration-bitbucket.js";
import { cloudflare } from "../src/integration-cloudflare.js";
import { github } from "../src/integration-github.js";
import { gitlab } from "../src/integration-gitlab.js";
import type { IntegrationCredential } from "../src/integrations.js";
import {
  decodedCredential,
  encodedCredential,
  optionalEnvironment,
  providerRequest,
  readTrackedResources,
  removeTrackedResource,
  requiredEnvironment,
  type LiveCleanupResource,
} from "../test/live/helpers.js";

if (process.env.VIBY_LIVE_PROVIDER_TESTS !== "1") {
  throw new Error("Refusing live cleanup without VIBY_LIVE_PROVIDER_TESTS=1.");
}

const resources = readTrackedResources();
if (resources.length === 0) {
  console.log("No pending live-provider resources require cleanup.");
} else {
  const errors: unknown[] = [];
  for (const resource of resources) {
    try {
      validateDisposableResource(resource);
      await cleanupResource(resource);
      removeTrackedResource(resource);
      console.log(`Cleaned ${resource.provider} ${resource.kind}: ${resourceIdentity(resource)}`);
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `Could not clean ${errors.length} live-provider resource(s).`);
  }
}

async function cleanupResource(resource: LiveCleanupResource): Promise<void> {
  switch (resource.provider) {
    case "github": {
      const token = await githubInstallationToken();
      const apiUrl = optionalEnvironment("VIBY_LIVE_GITHUB_API_URL") ?? "https://api.github.com";
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/repos/${encodeURIComponent(resource.owner)}`
          + `/${encodeURIComponent(resource.name)}`,
        {
          method: "DELETE",
          headers: {
            accept: "application/vnd.github+json",
            authorization: `Bearer ${token}`,
            "x-github-api-version": "2022-11-28",
          },
        },
        [204, 404],
      );
      return;
    }
    case "bitbucket": {
      const token = await bitbucketAccessToken();
      const apiUrl = optionalEnvironment("VIBY_LIVE_BITBUCKET_API_URL")
        ?? "https://api.bitbucket.org/2.0";
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/repositories/${encodeURIComponent(resource.workspace)}`
          + `/${encodeURIComponent(resource.name)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        [204, 404],
      );
      return;
    }
    case "gitlab": {
      const token = await gitlabAccessToken();
      const baseUrl = optionalEnvironment("VIBY_LIVE_GITLAB_BASE_URL") ?? "https://gitlab.com";
      const project = encodeURIComponent(`${resource.owner}/${resource.name}`);
      await providerRequest(
        `${baseUrl.replace(/\/$/, "")}/api/v4/projects/${project}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        [202, 204, 404],
      );
      return;
    }
    case "cloudflare": {
      const token = await cloudflareAccessToken();
      const apiUrl = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_API_URL")
        ?? "https://api.cloudflare.com/client/v4";
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/accounts/${encodeURIComponent(resource.accountId)}`
          + `/pages/projects/${encodeURIComponent(resource.name)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${token}` } },
        [200, 404],
      );
      return;
    }
    case "vercel": {
      await cleanupVercelDeployment(resource);
      return;
    }
    case "netlify": {
      const accessToken = requiredEnvironment("VIBY_LIVE_NETLIFY_ACCESS_TOKEN");
      const apiUrl = optionalEnvironment("VIBY_LIVE_NETLIFY_API_URL")
        ?? "https://api.netlify.com/api/v1";
      await providerRequest(
        `${apiUrl.replace(/\/$/, "")}/sites/${encodeURIComponent(resource.id)}`,
        { method: "DELETE", headers: { authorization: `Bearer ${accessToken}` } },
        [204, 404],
      );
      return;
    }
  }
}

async function githubInstallationToken(): Promise<string> {
  const installationId = Number(requiredEnvironment("VIBY_LIVE_GITHUB_INSTALLATION_ID"));
  const adapter = github({
    appId: requiredEnvironment("VIBY_LIVE_GITHUB_APP_ID"),
    clientId: "unused-by-live-cleanup",
    clientSecret: "unused-by-live-cleanup",
    privateKey: requiredEnvironment("VIBY_LIVE_GITHUB_APP_PRIVATE_KEY"),
    slug: "viby-live-cleanup",
    apiUrl: optionalEnvironment("VIBY_LIVE_GITHUB_API_URL") ?? "https://api.github.com",
  });
  const credential = await adapter.connection.refreshCredential!({
    secret: encodedCredential({
      version: 1,
      installationId,
      installationToken: "refresh-required",
      userToken: "unused-by-live-cleanup",
      userExpiresAt: null,
      userRefreshToken: null,
      userRefreshExpiresAt: null,
    }),
    expiresAt: new Date(0),
    scopes: [],
  }, { tenantId: "live-provider-tests", userId: "github-cleanup" });
  return String(decodedCredential(credential).installationToken);
}

async function cloudflareAccessToken(): Promise<string> {
  const accessToken = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_ACCESS_TOKEN")
    ?? "refresh-required";
  const refreshToken = optionalEnvironment("VIBY_LIVE_CLOUDFLARE_REFRESH_TOKEN");
  if (accessToken === "refresh-required" && !refreshToken) {
    requiredEnvironment("VIBY_LIVE_CLOUDFLARE_ACCESS_TOKEN");
  }
  let credential: IntegrationCredential = {
    secret: encodedCredential({ version: 1, accessToken, refreshToken }),
    expiresAt: null,
    scopes: [],
  };
  if (refreshToken) {
    const adapter = cloudflare({
      clientId: requiredEnvironment("VIBY_LIVE_CLOUDFLARE_CLIENT_ID"),
      clientSecret: requiredEnvironment("VIBY_LIVE_CLOUDFLARE_CLIENT_SECRET"),
      scopes: ["account:read", "pages:write"],
    });
    credential = await adapter.connection.refreshCredential!(credential, {
      tenantId: "live-provider-tests",
      userId: "cloudflare-cleanup",
    });
  }
  return String(decodedCredential(credential).accessToken);
}

async function bitbucketAccessToken(): Promise<string> {
  const accessToken = optionalEnvironment("VIBY_LIVE_BITBUCKET_ACCESS_TOKEN")
    ?? "refresh-required";
  const refreshToken = optionalEnvironment("VIBY_LIVE_BITBUCKET_REFRESH_TOKEN");
  if (accessToken === "refresh-required" && !refreshToken) {
    requiredEnvironment("VIBY_LIVE_BITBUCKET_ACCESS_TOKEN");
  }
  let credential: IntegrationCredential = {
    secret: encodedCredential({ version: 1, accessToken, refreshToken }),
    expiresAt: null,
    scopes: [],
  };
  if (refreshToken) {
    const adapter = bitbucket({
      clientId: requiredEnvironment("VIBY_LIVE_BITBUCKET_CLIENT_ID"),
      clientSecret: requiredEnvironment("VIBY_LIVE_BITBUCKET_CLIENT_SECRET"),
    });
    credential = await adapter.connection.refreshCredential!(credential, {
      tenantId: "live-provider-tests",
      userId: "bitbucket-cleanup",
    });
  }
  return String(decodedCredential(credential).accessToken);
}

async function gitlabAccessToken(): Promise<string> {
  const accessToken = optionalEnvironment("VIBY_LIVE_GITLAB_ACCESS_TOKEN")
    ?? "refresh-required";
  const refreshToken = optionalEnvironment("VIBY_LIVE_GITLAB_REFRESH_TOKEN");
  if (accessToken === "refresh-required" && !refreshToken) {
    requiredEnvironment("VIBY_LIVE_GITLAB_ACCESS_TOKEN");
  }
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
    const adapter = gitlab({
      clientId: requiredEnvironment("VIBY_LIVE_GITLAB_CLIENT_ID"),
      clientSecret: requiredEnvironment("VIBY_LIVE_GITLAB_CLIENT_SECRET"),
      baseUrl: optionalEnvironment("VIBY_LIVE_GITLAB_BASE_URL") ?? "https://gitlab.com",
    });
    credential = await adapter.connection.refreshCredential!(credential, {
      tenantId: "live-provider-tests",
      userId: "gitlab-cleanup",
    });
  }
  return String(decodedCredential(credential).accessToken);
}

async function cleanupVercelDeployment(
  resource: Extract<LiveCleanupResource, { readonly provider: "vercel" }>,
): Promise<void> {
  const accessToken = requiredEnvironment("VIBY_LIVE_VERCEL_ACCESS_TOKEN");
  const teamId = optionalEnvironment("VIBY_LIVE_VERCEL_TEAM_ID");
  const apiUrl = optionalEnvironment("VIBY_LIVE_VERCEL_API_URL") ?? "https://api.vercel.com";
  const lookup = new URL("/v6/deployments", apiUrl);
  lookup.searchParams.set("projectId", resource.projectId);
  lookup.searchParams.set("limit", "10");
  lookup.searchParams.set("meta-vibyIdempotencyKey", resource.idempotencyKey);
  if (teamId) lookup.searchParams.set("teamId", teamId);
  const response = await providerRequest(lookup, {
    headers: { authorization: `Bearer ${accessToken}` },
  }, [200]);
  const payload = await response.json() as {
    readonly deployments?: readonly { readonly id?: string; readonly uid?: string }[];
  };
  for (const deployment of payload.deployments ?? []) {
    const id = deployment.id ?? deployment.uid;
    if (!id) continue;
    const deletion = new URL(`/v13/deployments/${encodeURIComponent(id)}`, apiUrl);
    if (teamId) deletion.searchParams.set("teamId", teamId);
    await providerRequest(deletion, {
      method: "DELETE",
      headers: { authorization: `Bearer ${accessToken}` },
    }, [200, 204, 404]);
  }
}

function validateDisposableResource(resource: LiveCleanupResource): void {
  const identity = resourceIdentity(resource);
  const prefix = resource.provider === "vercel"
    ? "live:viby-live-vercel-"
    : `viby-live-${resource.provider}-`;
  if (!identity.startsWith(prefix)) {
    throw new Error(`Refusing to clean non-disposable ${resource.provider} resource: ${identity}`);
  }
}

function resourceIdentity(resource: LiveCleanupResource): string {
  return resource.provider === "vercel" ? resource.idempotencyKey : resource.name;
}
