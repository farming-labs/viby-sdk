import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { createViby, type ScopedViby, type Viby } from "../src/client.js";
import { verifyDeploymentIntegration } from "../src/deployment-integration-conformance.js";
import type {
  DeploymentData,
  DeploymentIntegration,
  DeploymentProjectData,
  IntegrationSourceFile,
} from "../src/integrations.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import {
  MemoryIntegrationConnectionStore,
  MemorySecretStore,
} from "./helpers/memory-integration-store.js";

function deploymentFixture() {
  const projects = new Map<string, DeploymentProjectData>();
  const deployments = new Map<string, DeploymentData>();
  const effects = new Map<string, string>();
  const sources = new Map<string, readonly IntegrationSourceFile[]>();
  let projectNumber = 0;
  let deploymentNumber = 0;
  const adapter: DeploymentIntegration = {
    provider: "fixture-deployment",
    displayName: "Fixture Deployment",
    connection: {
      async startAuthorization(input) {
        const url = new URL("https://deploy.example/authorize");
        url.searchParams.set("state", input.state);
        return { url: url.href, expiresAt: null };
      },
      async completeAuthorization() {
        return {
          account: { id: "team-1", name: "Acme Team" },
          credential: {
            secret: new TextEncoder().encode("deployment-token"),
            expiresAt: null,
            scopes: ["deployments:write"],
          },
        };
      },
    },
    async listProjects(input, context) {
      assertCredential(context.credential);
      const search = input.search?.toLowerCase();
      return {
        items: [...projects.values()].filter((project) => (
          !search || project.name.toLowerCase().includes(search)
        )),
        nextCursor: null,
      };
    },
    async getProject(input, context) {
      assertCredential(context.credential);
      return [...projects.values()].find((project) => (
        (input.id !== undefined && project.id === input.id)
        || (input.name !== undefined && project.name === input.name)
      )) ?? null;
    },
    async createProject(input, context) {
      assertCredential(context.credential);
      const project = {
        id: `project-${++projectNumber}`,
        name: input.name,
        url: `https://${input.name}.deploy.example`,
      };
      projects.set(project.id, project);
      return project;
    },
    async deployVersion(input, context) {
      assertCredential(context.credential);
      const previous = effects.get(input.idempotencyKey);
      if (previous) return deployments.get(previous)!;
      if (!projects.has(input.project)) throw new Error("Project does not exist");
      const id = `deployment-${++deploymentNumber}`;
      const deployment: DeploymentData = {
        id,
        projectId: input.project,
        environment: input.environment,
        status: "ready",
        url: `https://${id}.deploy.example`,
        createdAt: new Date(),
      };
      deployments.set(id, deployment);
      effects.set(input.idempotencyKey, id);
      sources.set(id, input.files.map((file) => ({
        ...file,
        content: new Uint8Array(file.content),
      })));
      return deployment;
    },
    async getDeployment(input, context) {
      assertCredential(context.credential);
      return deployments.get(input.id) ?? null;
    },
    async cancelDeployment(input, context) {
      assertCredential(context.credential);
      const current = deployments.get(input.id);
      if (!current) throw new Error("Deployment does not exist");
      const cancelled = { ...current, status: "cancelled" as const };
      deployments.set(input.id, cancelled);
      return cancelled;
    },
  };
  return { adapter, projects, deployments, effects, sources };
}

async function authorize(
  viby: Viby<"farm">,
  user: ScopedViby<"farm">,
) {
  const started = await user.integrations.deployment.connect("preview", {
    callbackUrl: "https://app.example/api/integrations/callback",
    returnTo: "/projects/new",
  });
  assert.equal(started.status, "authorization-required");
  const state = new URL(started.url).searchParams.get("state");
  assert.ok(state);
  return viby.integrations.callback(
    `https://app.example/api/integrations/callback?state=${state}&code=accepted`,
  );
}

test("creates projects and deploys immutable text and binary versions idempotently", async () => {
  const fixture = deploymentFixture();
  const persistence = new MemoryRepository();
  const viby = createViby({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    persistence,
    connectionStore: new MemoryIntegrationConnectionStore(),
    secretStore: new MemorySecretStore(),
    integrations: { deployment: { preview: fixture.adapter } },
  });
  const user = viby.forUser({ tenantId: "tenant", userId: "user" });
  await authorize(viby, user);
  const provider = user.integrations.deployment.use("preview");
  assert.equal((await user.integrations.deployment.list())[0]?.connected, true);

  const chat = await user.chats.import({
    title: "Deployable app",
    source: {
      type: "files",
      files: [
        { path: "index.html", content: "<!doctype html><title>Viby</title>" },
        {
          type: "artifact",
          path: "logo.bin",
          bytes: new Uint8Array([0, 1, 2, 255]),
          mediaType: "application/octet-stream",
        },
      ],
    },
  });
  const version = await chat.latestVersion();
  assert.ok(version);
  const first = await version.deploy({
    using: provider,
    project: { name: "viby-app", createIfMissing: true },
    environment: "preview",
  });
  assert.equal(first.status, "ready");
  assert.equal((await provider.projects.get({ name: "viby-app" }))?.id, first.projectId);
  assert.deepEqual(fixture.sources.get(first.id)?.map((file) => [file.path, file.content]), [
    ["index.html", new TextEncoder().encode("<!doctype html><title>Viby</title>")],
    ["logo.bin", new Uint8Array([0, 1, 2, 255])],
  ]);
  const [firstHistory] = await version.deployments();
  assert.equal(firstHistory?.providerDeploymentId, first.id);
  assert.equal(firstHistory?.status, "ready");
  assert.deepEqual(firstHistory?.transitions.map((transition) => transition.status), [
    "pending",
    "ready",
  ]);
  assert.equal((await chat.deploymentProjects())[0]?.providerProjectId, first.projectId);
  const automaticRetry = await version.deploy({
    using: provider,
    project: { name: "viby-app", createIfMissing: true },
    environment: "preview",
  });
  assert.equal(automaticRetry.id, first.id);
  assert.equal((await version.deployments()).length, 1);

  const repeated = await version.deploy({
    using: provider,
    project: { id: first.projectId },
    environment: "preview",
    idempotencyKey: "stable-version-deploy",
  });
  const same = await version.deploy({
    using: provider,
    project: { id: first.projectId },
    environment: "preview",
    idempotencyKey: "stable-version-deploy",
  });
  assert.equal(same.id, repeated.id);
  assert.equal((await provider.deployments.get({ id: repeated.id }))?.url, repeated.url);
  assert.equal((await provider.deployments.cancel({
    id: repeated.id,
    idempotencyKey: "cancel-stable-version-deploy",
  })).status, "cancelled");
  const durableDeployments = await (await user.chats.get(chat.id)).deployments();
  assert.equal(durableDeployments.length, 2);
  const cancelled = durableDeployments.find((deployment) => (
    deployment.providerDeploymentId === repeated.id
  ));
  assert.equal(cancelled?.status, "cancelled");
  assert.deepEqual(cancelled?.transitions.map((transition) => transition.status), [
    "pending",
    "ready",
    "cancelled",
  ]);

  await assert.rejects(
    () => version.deploy({
      using: provider,
      project: { id: "missing-project" },
      environment: "preview",
      idempotencyKey: "missing-deployment-project",
    }),
    /Deployment project was not found/,
  );
  const failed = (await version.deployments())
    .find((deployment) => deployment.idempotencyKey === "missing-deployment-project");
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /Deployment project was not found/);
  assert.deepEqual(failed?.transitions.map((transition) => transition.status), [
    "pending",
    "failed",
  ]);
  await assert.rejects(
    () => persistence.listDeployments(
      { tenantId: "other", userId: "other" },
      { chatId: chat.id },
    ),
    /Chat was not found/,
  );
  await viby.close();
});

test("passes the reusable deployment adapter conformance suite", async () => {
  const fixture = deploymentFixture();
  const report = await verifyDeploymentIntegration({
    adapter: fixture.adapter,
    context: {
      tenantId: "tenant",
      userId: "user",
      connectionId: "connection",
      externalAccount: { id: "team-1", name: "Acme Team" },
      credential: new TextEncoder().encode("deployment-token"),
    },
    projectName: "deployment-conformance",
  });
  assert.equal(report.provider, "fixture-deployment");
  assert.deepEqual(report.checks, [
    "list-projects",
    "create-project",
    "get-project",
    "deploy-version",
    "deployment-idempotency",
    "get-deployment",
    "cancel-deployment",
  ]);
});

function assertCredential(value: Uint8Array): void {
  assert.equal(new TextDecoder().decode(value), "deployment-token");
}
