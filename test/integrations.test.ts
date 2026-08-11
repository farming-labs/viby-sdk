import assert from "node:assert/strict";
import { test } from "node:test";
import {
  configuredIntegrations,
  type DeploymentIntegration,
  type IntegrationConnectionAdapter,
  type RepositoryIntegration,
} from "../src/integrations.js";
import { ConfigurationError } from "../src/errors.js";

const connection: IntegrationConnectionAdapter = {
  async startAuthorization() {
    return { url: "https://provider.example/authorize", expiresAt: null };
  },
  async completeAuthorization() {
    return {
      account: { id: "account", name: "Account" },
      credential: { secret: new Uint8Array([1]), expiresAt: null, scopes: [] },
    };
  },
};

function repositoryIntegration(provider = "github"): RepositoryIntegration {
  return {
    provider,
    displayName: provider === "github" ? "GitHub" : "Bitbucket",
    connection,
    async listOwners() { return { items: [], nextCursor: null }; },
    async listRepositories() { return { items: [], nextCursor: null }; },
    async getRepository() { return null; },
    async createRepository(input) {
      return {
        id: "repository",
        owner: input.owner,
        name: input.name,
        defaultBranch: "main",
        visibility: input.visibility ?? "private",
        url: `https://${provider}.example/${input.owner}/${input.name}`,
      };
    },
    async listBranches() { return { items: [], nextCursor: null }; },
    async getBranch() { return null; },
    async createBranch(input) {
      return { name: input.name, head: input.from, protected: false };
    },
    async readSource(input) {
      const repository = await this.createRepository({
        ...input.repository,
        visibility: "private",
      }, {} as never);
      return { repository, ref: input.ref, commit: "commit", files: [] };
    },
    async pushVersion(input) {
      return {
        status: "pushed",
        commit: {
          id: "commit",
          message: input.message,
          branch: input.branch,
          url: null,
        },
        changedFiles: input.files.length,
      };
    },
    async createPullRequest(input) {
      return {
        id: "pull-request",
        number: 1,
        title: input.title,
        head: input.head,
        base: input.base,
        status: input.draft ? "draft" : "open",
        url: "https://provider.example/pull/1",
      };
    },
  };
}

function deploymentIntegration(provider = "vercel"): DeploymentIntegration {
  return {
    provider,
    displayName: provider === "vercel" ? "Vercel" : "Cloudflare",
    connection,
    async listProjects() { return { items: [], nextCursor: null }; },
    async getProject() { return null; },
    async createProject(input) { return { id: "project", name: input.name, url: null }; },
    async deployVersion(input) {
      return {
        id: "deployment",
        projectId: input.project,
        environment: input.environment,
        status: "queued",
        url: null,
        createdAt: new Date(),
      };
    },
    async getDeployment() { return null; },
  };
}

test("lists integrations by their provider-neutral capability category", () => {
  assert.deepEqual(configuredIntegrations({
    repository: {
      companySource: repositoryIntegration("github"),
      bitbucket: repositoryIntegration("bitbucket"),
    },
    deployment: {
      preview: deploymentIntegration("vercel"),
      cloudflare: deploymentIntegration("cloudflare"),
    },
  }), [
    { id: "companySource", category: "repository", provider: "github", displayName: "GitHub" },
    { id: "bitbucket", category: "repository", provider: "bitbucket", displayName: "Bitbucket" },
    { id: "preview", category: "deployment", provider: "vercel", displayName: "Vercel" },
    { id: "cloudflare", category: "deployment", provider: "cloudflare", displayName: "Cloudflare" },
  ]);
});

test("accepts an omitted or empty integration configuration", () => {
  assert.deepEqual(configuredIntegrations(undefined), []);
  assert.deepEqual(configuredIntegrations({}), []);
  assert.deepEqual(configuredIntegrations({ repository: {}, deployment: {} }), []);
});

test("rejects unknown integration categories", () => {
  assert.throws(
    () => configuredIntegrations({ storage: {} } as never),
    (error: unknown) => error instanceof ConfigurationError
      && error.message === "Unknown integration category: storage",
  );
});

test("rejects invalid aliases and incomplete adapters", () => {
  assert.throws(
    () => configuredIntegrations({
      repository: { "bad alias": repositoryIntegration() },
    }),
    /repository integration id/,
  );
  assert.throws(
    () => configuredIntegrations({
      deployment: {
        broken: {
          ...deploymentIntegration(),
          deployVersion: undefined,
        } as never,
      },
    }),
    /deployment\.broken must provide deployVersion\(\)/,
  );
});
