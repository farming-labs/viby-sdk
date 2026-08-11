import {
  ConfigurationError,
  IntegrationOperationError,
  NotFoundError,
} from "./errors.js";
import type {
  ConnectIntegrationInput,
  ConnectIntegrationResult,
  DisconnectIntegrationResult,
  IntegrationClient,
} from "./integration-client.js";
import type {
  CancelDeploymentInput,
  CreateDeploymentProjectInput,
  DeploymentData,
  DeploymentEnvironment,
  DeploymentIntegration,
  DeploymentProjectData,
  DeployVersionInput,
  GetDeploymentInput,
  IntegrationOperationContext,
  IntegrationPage,
  IntegrationSourceFile,
  ListDeploymentProjectsInput,
} from "./integrations.js";
import type { UserScope } from "./types.js";
import { assertIdentifier } from "./utils.js";

export interface DeploymentIntegrationHandleOptions {
  readonly connectionId?: string;
}

export type DeploymentProjectTarget<ProjectOptions = never> =
  | string
  | { readonly id: string }
  | {
      readonly name: string;
      readonly createIfMissing?: boolean;
      readonly providerOptions?: ProjectOptions;
    };

export interface DeploySourceInput<ProjectOptions = never, DeployOptions = never> {
  readonly using: DeploymentIntegrationHandle<ProjectOptions, DeployOptions>;
  /** A string is treated as an existing project name; use `{ id }` for a provider project ID. */
  readonly project: DeploymentProjectTarget<ProjectOptions>;
  readonly environment: DeploymentEnvironment;
  readonly idempotencyKey: string;
  readonly providerOptions?: DeployOptions;
  readonly signal?: AbortSignal;
}

export type VersionDeployInput<ProjectOptions = never, DeployOptions = never> =
  Omit<DeploySourceInput<ProjectOptions, DeployOptions>, "idempotencyKey"> & {
    /** Defaults to a stable key derived from the immutable version and deployment target. */
    readonly idempotencyKey?: string;
  };

export class ScopedDeploymentIntegrations {
  readonly #client: IntegrationClient;
  readonly #scope: UserScope;

  constructor(client: IntegrationClient, scope: UserScope) {
    this.#client = client;
    this.#scope = scope;
  }

  list() {
    return this.#client.statuses(this.#scope, "deployment");
  }

  connections(integrationId?: string) {
    return this.#client.connections(this.#scope, "deployment", integrationId);
  }

  connect(integrationId: string, input: ConnectIntegrationInput): Promise<ConnectIntegrationResult> {
    return this.#client.connect(this.#scope, "deployment", integrationId, input);
  }

  disconnect(
    integrationId: string,
    options: { readonly connectionId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<DisconnectIntegrationResult> {
    return this.#client.disconnect(
      this.#scope,
      "deployment",
      integrationId,
      options.connectionId,
      options.signal,
    );
  }

  use(
    integrationId: string,
    options: DeploymentIntegrationHandleOptions = {},
  ): DeploymentIntegrationHandle<any, any> {
    return new DeploymentIntegrationHandle(
      this.#client,
      this.#scope,
      assertIdentifier(integrationId, "Deployment integration id"),
      options.connectionId,
    );
  }
}

export class DeploymentIntegrationHandle<ProjectOptions = never, DeployOptions = never> {
  readonly id: string;
  readonly provider: string;
  readonly displayName: string;
  readonly projects: DeploymentProjectOperations<ProjectOptions>;
  readonly deployments: DeploymentOperations;
  readonly #client: IntegrationClient;
  readonly #scope: UserScope;
  readonly #adapter: DeploymentIntegration<ProjectOptions, DeployOptions>;
  readonly #connectionId: string | undefined;

  constructor(
    client: IntegrationClient,
    scope: UserScope,
    integrationId: string,
    connectionId?: string,
  ) {
    this.#client = client;
    this.#scope = scope;
    this.id = integrationId;
    this.#adapter = client.deploymentAdapter(integrationId) as DeploymentIntegration<
      ProjectOptions,
      DeployOptions
    >;
    this.provider = this.#adapter.provider;
    this.displayName = this.#adapter.displayName;
    this.#connectionId = connectionId;
    this.projects = new DeploymentProjectOperations(this);
    this.deployments = new DeploymentOperations(this);
  }

  connect(input: ConnectIntegrationInput): Promise<ConnectIntegrationResult> {
    return this.#client.connect(this.#scope, "deployment", this.id, input);
  }

  disconnect(options: { readonly signal?: AbortSignal } = {}): Promise<DisconnectIntegrationResult> {
    return this.#client.disconnect(
      this.#scope,
      "deployment",
      this.id,
      this.#connectionId,
      options.signal,
    );
  }

  async deploySource(
    input: DeployVersionInput<DeployOptions>,
    signal?: AbortSignal,
  ): Promise<DeploymentData> {
    return this.#run("deploy version", signal, (adapter, context) => (
      adapter.deployVersion(input, context)
    ));
  }

  async operationContext(signal?: AbortSignal): Promise<IntegrationOperationContext> {
    return this.#client.operationContext(
      this.#scope,
      "deployment",
      this.id,
      this.#connectionId,
      signal,
    );
  }

  async run<Result>(
    operation: string,
    signal: AbortSignal | undefined,
    callback: (
      adapter: DeploymentIntegration<ProjectOptions, DeployOptions>,
      context: IntegrationOperationContext,
    ) => Promise<Result>,
  ): Promise<Result> {
    return this.#run(operation, signal, callback);
  }

  async #run<Result>(
    operation: string,
    signal: AbortSignal | undefined,
    callback: (
      adapter: DeploymentIntegration<ProjectOptions, DeployOptions>,
      context: IntegrationOperationContext,
    ) => Promise<Result>,
  ): Promise<Result> {
    signal?.throwIfAborted();
    const context = await this.operationContext(signal);
    try {
      const result = await callback(this.#adapter, context);
      signal?.throwIfAborted();
      return result;
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (error instanceof ConfigurationError || error instanceof NotFoundError) throw error;
      throw new IntegrationOperationError("deployment", this.provider, operation, { cause: error });
    }
  }
}

export class DeploymentProjectOperations<ProjectOptions = never> {
  readonly #handle: DeploymentIntegrationHandle<ProjectOptions, any>;

  constructor(handle: DeploymentIntegrationHandle<ProjectOptions, any>) {
    this.#handle = handle;
  }

  list(
    input: ListDeploymentProjectsInput = {},
    signal?: AbortSignal,
  ): Promise<IntegrationPage<DeploymentProjectData>> {
    return this.#handle.run("list projects", signal, (adapter, context) => (
      adapter.listProjects(input, context)
    ));
  }

  get(
    input: { readonly id?: string; readonly name?: string },
    signal?: AbortSignal,
  ): Promise<DeploymentProjectData | null> {
    return this.#handle.run("get project", signal, (adapter, context) => (
      adapter.getProject(input, context)
    ));
  }

  create(
    input: CreateDeploymentProjectInput<ProjectOptions>,
    signal?: AbortSignal,
  ): Promise<DeploymentProjectData> {
    return this.#handle.run("create project", signal, (adapter, context) => (
      adapter.createProject(input, context)
    ));
  }
}

export class DeploymentOperations {
  readonly #handle: DeploymentIntegrationHandle<any, any>;

  constructor(handle: DeploymentIntegrationHandle<any, any>) {
    this.#handle = handle;
  }

  get(input: GetDeploymentInput, signal?: AbortSignal): Promise<DeploymentData | null> {
    return this.#handle.run("get deployment", signal, (adapter, context) => (
      adapter.getDeployment(input, context)
    ));
  }

  cancel(input: CancelDeploymentInput, signal?: AbortSignal): Promise<DeploymentData> {
    return this.#handle.run("cancel deployment", signal, (adapter, context) => {
      if (!adapter.cancelDeployment) {
        throw new ConfigurationError(`${adapter.displayName} does not support deployment cancellation.`);
      }
      return adapter.cancelDeployment(input, context);
    });
  }
}

export async function deployVersionSource<ProjectOptions, DeployOptions>(
  files: readonly IntegrationSourceFile[],
  input: DeploySourceInput<ProjectOptions, DeployOptions>,
): Promise<DeploymentData> {
  if (!Array.isArray(files)) throw new ConfigurationError("Deployment source files are required.");
  const project = await resolveProject(input);
  const environment = assertIdentifier(String(input.environment), "Deployment environment");
  const idempotencyKey = assertIdentifier(input.idempotencyKey, "Deployment idempotency key");
  return input.using.deploySource({
    project: project.id,
    environment,
    files,
    idempotencyKey,
    ...(input.providerOptions !== undefined ? { providerOptions: input.providerOptions } : {}),
  }, input.signal);
}

async function resolveProject<ProjectOptions, DeployOptions>(
  input: DeploySourceInput<ProjectOptions, DeployOptions>,
): Promise<DeploymentProjectData> {
  const target = normalizeProjectTarget(input.project);
  const existing = await input.using.projects.get(
    target.type === "id" ? { id: target.id } : { name: target.name },
    input.signal,
  );
  if (existing) return existing;
  if (target.type === "id" || !target.createIfMissing) {
    throw new NotFoundError("Deployment project");
  }
  return input.using.projects.create({
    name: target.name,
    ...(target.providerOptions !== undefined
      ? { providerOptions: target.providerOptions }
      : {}),
  }, input.signal);
}

function normalizeProjectTarget<ProjectOptions>(target: DeploymentProjectTarget<ProjectOptions>):
  | { readonly type: "id"; readonly id: string }
  | {
      readonly type: "name";
      readonly name: string;
      readonly createIfMissing: boolean;
      readonly providerOptions?: ProjectOptions;
    } {
  if (typeof target === "string") {
    return { type: "name", name: assertIdentifier(target, "Deployment project name"), createIfMissing: false };
  }
  if (!target || typeof target !== "object") {
    throw new ConfigurationError("Deployment project target is required.");
  }
  if ("id" in target) {
    return { type: "id", id: assertIdentifier(target.id, "Deployment project id") };
  }
  return {
    type: "name",
    name: assertIdentifier(target.name, "Deployment project name"),
    createIfMissing: target.createIfMissing === true,
    ...(target.providerOptions !== undefined ? { providerOptions: target.providerOptions } : {}),
  };
}

export function deploymentTargetIdentity(target: DeploymentProjectTarget<any>): string {
  const normalized = normalizeProjectTarget(target);
  return normalized.type === "id" ? `id:${normalized.id}` : `name:${normalized.name}`;
}
