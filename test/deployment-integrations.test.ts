import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { unzipSync } from "fflate";
import { createViby, type ScopedViby, type Viby } from "../src/client.js";
import { verifyDeploymentIntegration } from "../src/deployment-integration-conformance.js";
import type {
  DeploymentData,
  DeploymentIntegration,
  DeploymentProjectData,
  IntegrationSourceFile,
} from "../src/integrations.js";
import {
  sandboxCapabilities,
  type SandboxAdapter,
  type SandboxCommand,
  type SandboxCreateInput,
  type SandboxFile,
  type SandboxInstance,
} from "../src/sandbox.js";
import { MemoryRepository } from "./helpers/memory-repository.js";
import {
  MemoryIntegrationConnectionStore,
  MemorySecretStore,
} from "./helpers/memory-integration-store.js";
import { MemoryEnvironmentVariableStore } from "./helpers/memory-environment-store.js";

function deploymentFixture(source?: DeploymentIntegration["source"]) {
  const projects = new Map<string, DeploymentProjectData>();
  const deployments = new Map<string, DeploymentData>();
  const effects = new Map<string, string>();
  const sources = new Map<string, readonly IntegrationSourceFile[]>();
  const environments = new Map<string, Readonly<Record<string, string>>>();
  let projectNumber = 0;
  let deploymentNumber = 0;
  const adapter: DeploymentIntegration = {
    provider: "fixture-deployment",
    displayName: "Fixture Deployment",
    ...(source ? { source } : {}),
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
      environments.set(id, { ...(input.environmentVariables ?? {}) });
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
  return { adapter, projects, deployments, effects, sources, environments };
}

class BuildSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly files = new Map<string, Uint8Array>();
  readonly commands: SandboxCommand[] = [];
  stopCalls = 0;

  constructor(id: string) {
    this.id = id;
  }

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(
        file.path,
        typeof file.content === "string" ? new TextEncoder().encode(file.content) : file.content,
      );
    }
  }

  async run(command: SandboxCommand) {
    this.commands.push(command);
    if (command.command === "pnpm" && command.args?.[0] === "build") {
      this.files.set("dist/index.html", new TextEncoder().encode("<h1>Prepared</h1>"));
      this.files.set("dist/assets/app.js", new TextEncoder().encode("console.log('prepared')"));
    }
    if (command.command === "node" && command.args?.[0] === "-e") {
      const manifest = command.args[3];
      assert.ok(manifest);
      this.files.set(
        manifest,
        new TextEncoder().encode(JSON.stringify(["assets/app.js", "index.html"])),
      );
    }
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const file = this.files.get(path);
    if (!file) throw new Error(`Missing sandbox file ${path}`);
    return Uint8Array.from(file);
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class BuildSandboxAdapter implements SandboxAdapter {
  readonly provider = "fixture-sandbox";
  readonly capabilities = sandboxCapabilities({ files: true, commands: true });
  readonly creates: SandboxCreateInput[] = [];
  readonly instances: BuildSandboxInstance[] = [];

  async create(input: SandboxCreateInput): Promise<SandboxInstance> {
    this.creates.push(input);
    const instance = new BuildSandboxInstance(`build-${this.instances.length + 1}`);
    this.instances.push(instance);
    return instance;
  }
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

test("prepares prebuilt deployment files in a sandbox and preserves raw downloads", async () => {
  const fixture = deploymentFixture({ mode: "prebuilt", outputDirectory: "dist" });
  const sandbox = new BuildSandboxAdapter();
  const persistence = new MemoryRepository();
  const environmentStore = new MemoryEnvironmentVariableStore();
  const viby = createViby({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    persistence,
    environment: { store: environmentStore },
    sandbox,
    deployment: {
      preparation: { build: { command: "pnpm", args: ["build"] } },
    },
    connectionStore: new MemoryIntegrationConnectionStore(),
    secretStore: new MemorySecretStore(),
    integrations: { deployment: { preview: fixture.adapter } },
  });
  const user = viby.forUser({ tenantId: "tenant", userId: "user" });
  await authorize(viby, user);
  const chat = await user.chats.import({
    title: "Farm deployment",
    source: {
      type: "files",
      files: [
        { path: "package.json", content: '{"scripts":{"build":"farm build"}}\n' },
        { path: "src/index.ts", content: "export const source = true;\n" },
      ],
    },
  });
  const version = await chat.latestVersion();
  assert.ok(version);
  await chat.environment.set({
    environment: "preview",
    name: "PUBLIC_API_ORIGIN",
    value: "https://stored-api.example",
  });
  await chat.environment.set({
    environment: "preview",
    name: "SERVICE_TOKEN",
    value: "build-and-deploy-secret",
    secret: true,
  });
  const provider = user.integrations.deployment.use("preview");
  assert.equal(provider.sourceMode, "prebuilt");
  assert.equal(provider.outputDirectory, "dist");

  const result = await version.deploy({
    using: provider,
    project: { name: "prepared-app", createIfMissing: true },
    environment: "preview",
    preparation: { env: { PUBLIC_API_ORIGIN: "https://api.example" } },
  });
  assert.deepEqual(fixture.sources.get(result.id)?.map((file) => file.path), [
    "dist/assets/app.js",
    "dist/index.html",
  ]);
  assert.equal(sandbox.instances.length, 1);
  assert.equal(sandbox.instances[0]?.stopCalls, 1);
  assert.deepEqual(sandbox.creates[0]?.env, {
    PUBLIC_API_ORIGIN: "https://api.example",
    SERVICE_TOKEN: "build-and-deploy-secret",
  });
  assert.equal(sandbox.instances[0]?.commands[0]?.command, "pnpm");
  assert.deepEqual(sandbox.instances[0]?.commands[0]?.args, ["build"]);
  assert.deepEqual(sandbox.instances[0]?.commands[0]?.env, {
    PUBLIC_API_ORIGIN: "https://api.example",
    SERVICE_TOKEN: "build-and-deploy-secret",
  });
  assert.equal(sandbox.instances[0]?.commands[1]?.command, "node");
  assert.equal(sandbox.instances[0]?.commands[1]?.args?.[2], "dist");

  const [history] = await version.deployments();
  assert.ok(history?.preparationArtifactId);
  const artifact = await version.deploymentArtifact(history.id);
  assert.ok(artifact);
  assert.equal(artifact.sandboxProvider, "fixture-sandbox");
  assert.equal(artifact.outputDirectory, "dist");
  assert.deepEqual(artifact.commands[0]?.environment, ["PUBLIC_API_ORIGIN", "SERVICE_TOKEN"]);
  assert.deepEqual(fixture.environments.get(result.id), {
    PUBLIC_API_ORIGIN: "https://stored-api.example",
    SERVICE_TOKEN: "build-and-deploy-secret",
  });
  assert.equal(JSON.stringify(history).includes("build-and-deploy-secret"), false);
  assert.equal(JSON.stringify(artifact).includes("build-and-deploy-secret"), false);
  assert.deepEqual(Object.keys(unzipSync(artifact.bytes)).sort(), [
    "dist/assets/app.js",
    "dist/index.html",
  ]);

  const rawDownload = unzipSync((await version.download()).bytes);
  assert.deepEqual(Object.keys(rawDownload).sort(), ["package.json", "src/index.ts"]);
  assert.equal(rawDownload["dist/index.html"], undefined);

  const replay = await version.deploy({
    using: provider,
    project: { name: "prepared-app", createIfMissing: true },
    environment: "preview",
  });
  assert.equal(replay.id, result.id);
  assert.equal(sandbox.instances.length, 1);
  await viby.close();
});

test("records an actionable failure when a prebuilt provider has no preparation contract", async () => {
  const fixture = deploymentFixture({ mode: "prebuilt", outputDirectory: "dist" });
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
  const chat = await user.chats.import({
    title: "Missing preparation",
    source: { type: "files", files: [{ path: "index.html", content: "raw" }] },
  });
  const version = await chat.latestVersion();
  assert.ok(version);
  await assert.rejects(() => version.deploy({
    using: user.integrations.deployment.use("preview"),
    project: { name: "missing-preparation", createIfMissing: true },
    environment: "preview",
  }), /requires prebuilt files.*deployment\.preparation/i);
  assert.equal((await version.deployments())[0]?.status, "failed");
  assert.equal(fixture.sources.size, 0);
  await viby.close();
});

function assertCredential(value: Uint8Array): void {
  assert.equal(new TextDecoder().decode(value), "deployment-token");
}
