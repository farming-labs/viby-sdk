import { randomUUID } from "node:crypto";
import { ConfigurationError } from "./errors.js";
import type {
  DeploymentIntegration,
  IntegrationOperationContext,
  IntegrationSourceFile,
} from "./integrations.js";

export interface VerifyDeploymentIntegrationInput {
  readonly adapter: DeploymentIntegration<any, any>;
  readonly context: IntegrationOperationContext;
  readonly projectName?: string;
  readonly files?: readonly IntegrationSourceFile[];
  readonly environment?: string;
}

export interface DeploymentIntegrationConformanceReport {
  readonly provider: string;
  readonly projectId: string;
  readonly deploymentId: string;
  readonly checks: readonly string[];
}

export class DeploymentIntegrationConformanceError extends Error {
  readonly check: string;

  constructor(check: string, message: string, options?: ErrorOptions) {
    super(`Deployment integration conformance failed at ${check}: ${message}`, options);
    this.name = "DeploymentIntegrationConformanceError";
    this.check = check;
  }
}

/** Exercises a provider adapter against a disposable project owned by the caller. */
export async function verifyDeploymentIntegration(
  input: VerifyDeploymentIntegrationInput,
): Promise<DeploymentIntegrationConformanceReport> {
  if (!input || typeof input !== "object" || !input.adapter) {
    throw new ConfigurationError("Deployment integration conformance input is required.");
  }
  const adapter = input.adapter;
  const projectName = input.projectName?.trim()
    || `viby-conformance-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
  const files = input.files ?? [{
    path: "index.html",
    content: new TextEncoder().encode("<!doctype html><title>Viby conformance</title>"),
    mediaType: "text/html",
  }];
  if (files.length === 0) {
    throw new ConfigurationError("Deployment integration conformance requires at least one file.");
  }
  const environment = input.environment?.trim() || "preview";
  const checks: string[] = [];

  const projects = await run("list-projects", () => adapter.listProjects({}, input.context));
  assert(Array.isArray(projects.items), "list-projects", "the provider returned an invalid page");
  checks.push("list-projects");

  const project = await run("create-project", () => adapter.createProject({ name: projectName }, input.context));
  assert(project.name === projectName, "create-project", "the provider changed the project name");
  checks.push("create-project");

  const loadedProject = await run("get-project", () => adapter.getProject({ id: project.id }, input.context));
  assert(loadedProject?.id === project.id, "get-project", "the created project was not readable");
  checks.push("get-project");

  const idempotencyKey = randomUUID();
  const deployment = await run("deploy-version", () => adapter.deployVersion({
    project: project.id,
    environment,
    files,
    idempotencyKey,
  }, input.context));
  assert(deployment.projectId === project.id,
    "deploy-version", "the deployment belongs to another project");
  checks.push("deploy-version");

  const repeated = await run("deployment-idempotency", () => adapter.deployVersion({
    project: project.id,
    environment,
    files,
    idempotencyKey,
  }, input.context));
  assert(repeated.id === deployment.id,
    "deployment-idempotency", "the provider repeated the same deployment effect");
  checks.push("deployment-idempotency");

  const loaded = await run("get-deployment", () => adapter.getDeployment({ id: deployment.id }, input.context));
  assert(loaded?.id === deployment.id,
    "get-deployment", "the created deployment was not readable");
  checks.push("get-deployment");

  if (adapter.cancelDeployment) {
    const cancelled = await run("cancel-deployment", () => adapter.cancelDeployment!({
      id: deployment.id,
      idempotencyKey: `${idempotencyKey}:cancel`,
    }, input.context));
    assert(cancelled.status === "cancelled",
      "cancel-deployment", "the deployment was not cancelled");
    checks.push("cancel-deployment");
  }

  return Object.freeze({
    provider: adapter.provider,
    projectId: project.id,
    deploymentId: deployment.id,
    checks: Object.freeze(checks),
  });
}

async function run<Result>(check: string, operation: () => Promise<Result>): Promise<Result> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof DeploymentIntegrationConformanceError) throw error;
    throw new DeploymentIntegrationConformanceError(check, "the provider operation failed", {
      cause: error,
    });
  }
}

function assert(condition: boolean, check: string, message: string): asserts condition {
  if (!condition) throw new DeploymentIntegrationConformanceError(check, message);
}
