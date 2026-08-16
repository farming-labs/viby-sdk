import type { LanguageModel } from "ai";
import type {
  AttachmentContent,
  ChatData,
  ChatDeletionData,
  ChatListOptions,
  CursorPage,
  ApplySourceChangesInput,
  CreateChatInput,
  DeleteChatInput,
  DesignEvaluationData,
  DesignEvaluationEvidence,
  FrameworkId,
  ForkVersionInput,
  GenerateInput,
  ImportProjectInput,
  ImportProjectSource,
  GenerationAttemptData,
  GenerationConfigurationData,
  GenerationData,
  GenerationEvent,
  GenerationEventDataMap,
  GenerationEventType,
  GenerationEventOptions,
  GenerationEventPage,
  GenerationStreamOptions,
  GenerationTaskData,
  GenerationTaskResolution,
  GeneratedArtifactContent,
  GeneratedArtifactData,
  GeneratedArtifactKind,
  GenerationWaitOptions,
  IterateInput,
  MessageData,
  MessagePartDataMap,
  MessagePartInput,
  MessagePartType,
  JsonValue,
  PageOptions,
  ProjectArtifactContent,
  PurgeDeletedChatsInput,
  ResolveGenerationTaskInput,
  RecordDesignEvaluationInput,
  RestoreVersionInput,
  SkillGroups,
  SkillReference,
  SourceChange,
  ToolCallData,
  UserScope,
  UpdateChatInput,
  VersionData,
  VersionArtifact,
  VersionEntry,
  VersionFile,
  VisualArtifactContent,
  VisualArtifactData,
  VibyConfig,
} from "./types.js";
import type { BrowserAdapter } from "./browser.js";
import {
  runVisualEvaluation,
  type VisualEvaluationInput,
  type VisualEvaluationResult,
} from "./visual-evaluation.js";
import type {
  SandboxAdapter,
  SandboxFile,
  SandboxLeaseData,
  SandboxOpenOptions,
  SandboxReconnectOptions,
} from "./sandbox.js";
import {
  PreviewRegistry,
  type PreviewOpenOptions,
  type PreviewSessionData,
  type PreviewSessionListOptions,
} from "./preview.js";
import type {
  AgentTraceError,
  AgentTracePart,
  AgentTraceWriter,
  AgentToolCall,
  AgentToolCallInput,
  AgentToolCallWriter,
  GeneratorOutput,
  ProjectGenerator,
} from "./generator.js";
import {
  normalizeGenerationEngineIdentity,
  type GenerationEngine,
} from "./generation-engine.js";
import {
  normalizeGenerationQuality,
  verifyGenerationQuality,
  type NormalizedGenerationQualityConfig,
} from "./generation-quality.js";
import type {
  ChatReadSnapshot,
  CreateAttachmentRecord,
  CreateGeneratedArtifactRecord,
  GenerationWorkerLease,
  Repository,
} from "./repository.js";
import { AgentProjectGenerator, normalizeAgentRunnerConfig } from "./agent-runner.js";
import { postgresPersistence } from "./persistence-postgres.js";
import { SkillResolver } from "./skills.js";
import { withFrameworkSkill } from "./framework-skills.js";
import {
  ConfigurationError,
  GenerationCancelledError,
  GenerationError,
  GenerationStateError,
  GenerationTaskRequiredError,
  NotFoundError,
  OutboundEventDeliveryError,
} from "./errors.js";
import {
  assertIdentifier,
  assertPrompt,
  createId,
  errorMessage,
  sha256,
} from "./utils.js";
import { createSourceDownload, type DownloadArtifact } from "./download.js";
import { importProjectFiles } from "./project-import.js";
import {
  resolveSourceImport,
  type AdapterProjectImportInput,
} from "./source-import.js";
import {
  applyVersionEntryChanges,
  mergeGeneratedFilesWithArtifacts,
  normalizeSourceChanges,
} from "./source-changes.js";
import {
  AgentWorkspace,
  type AgentWorkspaceCommitInput,
} from "./agent-workspace.js";
import {
  decodeChatCursor,
  decodeMessageCursor,
  decodeVersionCursor,
  decodeDesignEvaluationCursor,
  encodeChatCursor,
  encodeMessageCursor,
  encodeVersionCursor,
  encodeDesignEvaluationCursor,
} from "./cursors.js";
import { normalizeDesignEvaluation } from "./design-evaluations.js";
import { normalizeChatMetadata } from "./metadata.js";
import { SandboxRegistry, type SandboxSession } from "./sandbox.js";
import { isDatabaseAdapter } from "./storage.js";
import {
  EnvironmentManager,
  type EnvironmentVariableCollection,
} from "./environment.js";
import { PostgresEnvironmentVariableStore } from "./environment-postgres.js";
import type {
  OutboundEventDeliveryData,
  OutboundEventReceipt,
  OutboundEventRetryPolicy,
  OutboundEventDeliveryStatus,
  OutboundEventSink,
} from "./outbound-events.js";
import {
  generationEventStreamResponse,
  type GenerationEventStreamResponseOptions,
} from "./http.js";
import {
  normalizeCostAmount,
  normalizeCostCurrency,
  type GenerationCostConfig,
  type GenerationCostData,
  type GenerationCostInput,
  type TelemetryAttribute,
  type TelemetryAttributes,
  type TelemetrySpan,
  type VibyTelemetry,
} from "./telemetry.js";
import {
  configuredIntegrations,
  type DeploymentData,
  type IntegrationSourceFile,
} from "./integrations.js";
import { IntegrationClient } from "./integration-client.js";
import {
  deployVersionSource,
  deploymentTargetIdentity,
  type VersionDeployInput,
} from "./deployment-integrations.js";
import {
  pushVersionSource,
  type PushVersionRepositoryInput,
  type PushVersionRepositoryResult,
} from "./repository-integrations.js";
import type { RepositoryLinkData, RepositoryPushData } from "./repository-history.js";
import type {
  DeploymentProjectLinkData,
  DeploymentRecordData,
} from "./deployment-history.js";
import {
  deploymentFilesFromArtifact,
  prepareDeploymentSource,
  type DeploymentArtifactContent,
  type DeploymentPreparationConfig,
} from "./deployment-preparation.js";
import {
  EncryptedPostgresSecretStore,
  PostgresIntegrationConnectionStore,
} from "./integration-store-postgres.js";
import type { SecretStore, SecretStorePutInput } from "./integration-store.js";
import type {
  ToolSource,
  ToolSourcesRuntimeConfig,
} from "./tool-source.js";
import {
  ToolSourceRegistry,
  type CreateToolSourceInput,
  type ToolSourceRegistrationData,
  type ToolSourceRegistrationListOptions,
  type UpdateToolSourceInput,
} from "./tool-source-registry.js";
import type {
  CompleteToolSourceAuthorizationResult,
  ConnectToolSourceInput,
  ConnectToolSourceResult,
  DisconnectToolSourceResult,
  ToolSourceConnectionData,
} from "./tool-source-authorization.js";

const DEFAULT_POLL_INTERVAL_MS = 100;
const DEFAULT_EVENT_LIMIT = 100;
const DEFAULT_WORKER_LEASE_MS = 30_000;
const DEFAULT_WORKER_HEARTBEAT_MS = 10_000;
const DEFAULT_WORKER_POLL_INTERVAL_MS = 500;
const DEFAULT_DELETED_CHAT_RETENTION_MS = 30 * 24 * 60 * 60 * 1_000;
const MAX_DELETED_CHAT_RETENTION_MS = 10 * 365 * 24 * 60 * 60 * 1_000;
const DEFAULT_OUTBOUND_MAX_ATTEMPTS = 5;
const DEFAULT_OUTBOUND_INITIAL_DELAY_MS = 1_000;
const DEFAULT_OUTBOUND_MAX_DELAY_MS = 60_000;
const DEFAULT_OUTBOUND_MULTIPLIER = 2;
const DEFAULT_OUTBOUND_LEASE_MS = 30_000;
const MAX_GENERATION_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10_000_000;
const MAX_GENERATION_ATTACHMENT_BYTES = 25_000_000;
const MAX_GENERATED_ARTIFACTS = 20;
const MAX_GENERATED_ARTIFACT_BYTES = 25_000_000;
const MAX_GENERATED_ARTIFACT_TOTAL_BYTES = 100_000_000;

export interface OutboundEventDeliveryOptions extends GenerationEventOptions {
  readonly sink: string;
  readonly signal?: AbortSignal;
  readonly retry?: OutboundEventRetryPolicy;
}

export interface OutboundEventDeliveryPage {
  readonly deliveries: readonly OutboundEventReceipt[];
  readonly deadLetters: readonly OutboundEventDeliveryData[];
  readonly cursor: string;
  readonly hasMore: boolean;
  readonly retryAt: Date | null;
}

export interface OutboundEventDeliveryListOptions {
  readonly sink: string;
  readonly status?: OutboundEventDeliveryStatus;
}

export interface OutboundEventRedriveInput {
  readonly sink: string;
  readonly cursor: string;
}

export interface GenerationWorkerOptions {
  readonly id: string;
  readonly concurrency?: number;
  readonly leaseMs?: number;
  readonly heartbeatMs?: number;
  readonly pollIntervalMs?: number;
}

export interface GenerationWorkerRunOptions {
  readonly signal?: AbortSignal;
}

export interface Viby<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  readonly integrations: IntegrationClient;
  readonly toolSources: ToolSourceAuthorizationCallbacks;
  forUser(scope: UserScope): ScopedViby<Framework>;
  worker(options: GenerationWorkerOptions): GenerationWorker<Framework>;
  close(): Promise<void>;
}

export type GenerationOutcome<Framework extends FrameworkId = FrameworkId> =
  | {
      readonly status: "succeeded";
      readonly generation: GenerationData;
      readonly version: Version<Framework>;
    }
  | {
      readonly status: "waiting";
      readonly generation: GenerationData;
      readonly tasks: readonly GenerationTaskData[];
    }
  | {
      readonly status: "failed";
      readonly generation: GenerationData;
      readonly error: string;
    }
  | {
      readonly status: "cancelled";
      readonly generation: GenerationData;
      readonly reason: string;
    };

interface ClientDependencies<Framework extends FrameworkId> {
  readonly repository: Repository;
  readonly generator?: ProjectGenerator<Framework>;
  readonly generators?: Readonly<Record<string, ProjectGenerator<Framework>>>;
  readonly skillResolver: SkillResolver;
  readonly integrations?: IntegrationClient;
  readonly environment?: EnvironmentManager;
  readonly secretStore?: SecretStore | null;
}

interface GenerationModelBinding<Framework extends FrameworkId> {
  readonly alias: string;
  readonly provider: string;
  readonly id: string;
  readonly generator: ProjectGenerator<Framework>;
}

class GenerationModelRegistry<Framework extends FrameworkId> {
  readonly #bindings = new Map<string, GenerationModelBinding<Framework>>();

  constructor(
    config: VibyConfig<Framework>,
    dependencies: ClientDependencies<Framework>,
    tools: ToolSourcesRuntimeConfig<Framework> | undefined,
  ) {
    if (config.engine) {
      this.#addEngine("default", config.engine);
      for (const [alias, engine] of Object.entries(config.engines ?? {})) {
        if (alias === "default") {
          throw new ConfigurationError("engines.default is reserved for the top-level engine.");
        }
        this.#addEngine(alias, engine);
      }
      return;
    }

    const defaultGenerator = dependencies.generator ?? new AgentProjectGenerator(config.model, config.agent, tools);
    this.#addModel("default", config.model, defaultGenerator);
    for (const [alias, model] of Object.entries(config.models ?? {})) {
      if (alias === "default") {
        throw new ConfigurationError("models.default is reserved for the top-level model.");
      }
      this.#addModel(
        alias,
        model,
        dependencies.generators?.[alias] ?? new AgentProjectGenerator(model, config.agent, tools),
      );
    }
  }

  get identities(): readonly { readonly provider: string; readonly id: string }[] {
    const seen = new Set<string>();
    return [...this.#bindings.values()].flatMap(({ provider, id }) => {
      const key = `${provider}\u0000${id}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ provider, id }];
    });
  }

  resolve(alias = "default"): GenerationModelBinding<Framework> {
    const normalized = assertModelAlias(alias);
    const binding = this.#bindings.get(normalized);
    if (!binding) {
      throw new ConfigurationError(`Generation model alias is not configured: ${normalized}`);
    }
    return binding;
  }

  resolveGeneration(generation: GenerationData): GenerationModelBinding<Framework> {
    const binding = this.resolve(generation.configuration.model);
    if (binding.provider !== generation.modelProvider || binding.id !== generation.modelId) {
      throw new ConfigurationError(
        `Generation ${generation.id} model alias no longer resolves to ${generation.modelProvider}/${generation.modelId}.`,
      );
    }
    return binding;
  }

  #addModel(alias: string, model: LanguageModel, generator: ProjectGenerator<Framework>): void {
    const normalized = assertModelAlias(alias);
    if (this.#bindings.has(normalized)) {
      throw new ConfigurationError(`Generation model alias is duplicated: ${normalized}`);
    }
    const identity = languageModelIdentity(model);
    this.#bindings.set(normalized, { alias: normalized, ...identity, generator });
  }

  #addEngine(alias: string, engine: GenerationEngine<Framework>): void {
    const normalized = assertModelAlias(alias);
    if (this.#bindings.has(normalized)) {
      throw new ConfigurationError(`Generation engine alias is duplicated: ${normalized}`);
    }
    const identity = normalizeGenerationEngineIdentity(engine?.identity);
    if (typeof engine?.generate !== "function") {
      throw new ConfigurationError("A generation engine must implement generate(input, options).");
    }
    this.#bindings.set(normalized, {
      alias: normalized,
      provider: identity.provider,
      id: identity.model,
      generator: engine,
    });
  }
}

export function createViby<const Framework extends FrameworkId>(
  config: VibyConfig<Framework>,
): Viby<Framework> {
  const storage = normalizeStorageConfig(config);
  const database = storage.database ?? postgresPersistence({
    ...(storage.artifacts ? { artifactStore: storage.artifacts } : {}),
  });
  if (!isDatabaseAdapter(database) && storage.explicitDatabase && storage.artifacts) {
    throw new ConfigurationError(
      "A raw custom database adapter owns artifact references; use defineDatabaseAdapter() to receive storage.artifacts during initialization.",
    );
  }
  return createVibyWithDependencies(config, {
    repository: isDatabaseAdapter(database)
      ? database.open(storage.artifacts ? { artifacts: storage.artifacts } : {})
      : database,
    skillResolver: new SkillResolver(
      withFrameworkSkill(config.framework, config.skills),
      undefined,
      config.skillResolver ? [config.skillResolver] : [],
    ),
  });
}

export function createVibyWithDependencies<const Framework extends FrameworkId>(
  config: VibyConfig<Framework>,
  dependencies: ClientDependencies<Framework>,
): Viby<Framework> {
  if (typeof config.framework !== "string" || config.framework.trim().length === 0) {
    throw new ConfigurationError("framework must be a non-empty string value.");
  }
  const storage = normalizeStorageConfig(config);
  const integrationCount = configuredIntegrations(config.integrations).length;
  const environmentEnabled = config.environment !== undefined;
  const authorizedToolSources = Object.values(config.tools?.adapters ?? {})
    .some((adapter) => adapter.authorization !== undefined);
  if (config.environment !== undefined && (!config.environment || typeof config.environment !== "object")) {
    throw new ConfigurationError("environment must be an object when configured.");
  }
  const secretStore = storage.secrets ?? (integrationCount > 0 || environmentEnabled || authorizedToolSources
    ? new LazyDefaultSecretStore()
    : null);
  const integrations = dependencies.integrations ?? new IntegrationClient(
    config.integrations,
    storage.connections ?? (integrationCount > 0
      ? new PostgresIntegrationConnectionStore()
      : null),
    secretStore,
  );
  const environment = dependencies.environment ?? (environmentEnabled
    ? new EnvironmentManager(
        config.environment?.store ?? new PostgresEnvironmentVariableStore(),
        secretStore!,
      )
    : undefined);
  return new VibyClient(config, {
    ...dependencies,
    integrations,
    secretStore,
    ...(environment ? { environment } : {}),
  });
}

interface NormalizedStorageConfig {
  readonly database: import("./persistence.js").PersistenceAdapter | import("./storage.js").DatabaseAdapter | undefined;
  readonly explicitDatabase: boolean;
  readonly artifacts: import("./artifact-store.js").ArtifactStore | undefined;
  readonly connections: import("./integration-store.js").IntegrationConnectionStore | undefined;
  readonly secrets: import("./integration-store.js").SecretStore | undefined;
}

function normalizeStorageConfig<Framework extends FrameworkId>(
  config: VibyConfig<Framework>,
): NormalizedStorageConfig {
  if (config.storage !== undefined && (!config.storage || typeof config.storage !== "object")) {
    throw new ConfigurationError("storage must be an object grouped by storage category.");
  }
  assertStorageAlias("database", config.storage?.database, "persistence", config.persistence);
  assertStorageAlias("artifacts", config.storage?.artifacts, "artifactStore", config.artifactStore);
  assertStorageAlias("connections", config.storage?.connections, "connectionStore", config.connectionStore);
  assertStorageAlias("secrets", config.storage?.secrets, "secretStore", config.secretStore);
  const artifacts = config.storage?.artifacts ?? config.artifactStore;
  const configuredDatabase = config.storage?.database ?? config.persistence;
  return {
    database: configuredDatabase,
    explicitDatabase: configuredDatabase !== undefined,
    artifacts,
    connections: config.storage?.connections ?? config.connectionStore,
    secrets: config.storage?.secrets ?? config.secretStore,
  };
}

function assertStorageAlias(
  category: string,
  nested: unknown,
  alias: string,
  legacy: unknown,
): void {
  if (nested !== undefined && legacy !== undefined) {
    throw new ConfigurationError(`Configure storage.${category} or ${alias}, not both.`);
  }
}

function unavailableEnvironmentVariables(): EnvironmentVariableCollection {
  const unavailable = (): never => {
    throw new ConfigurationError(
      "Project environment variables are not configured. Add environment: {} to use the PostgreSQL default or provide environment.store.",
    );
  };
  return {
    set: async () => unavailable(),
    list: async () => unavailable(),
    delete: async () => unavailable(),
  };
}

class LazyDefaultSecretStore implements SecretStore {
  #store: EncryptedPostgresSecretStore | undefined;

  put(scope: UserScope, input: SecretStorePutInput): Promise<string> {
    return this.#get().put(scope, input);
  }

  get(scope: UserScope, reference: string): Promise<Uint8Array | null> {
    return this.#get().get(scope, reference);
  }

  delete(scope: UserScope, reference: string): Promise<void> {
    return this.#get().delete(scope, reference);
  }

  close(): Promise<void> {
    return this.#store?.close() ?? Promise.resolve();
  }

  #get(): EncryptedPostgresSecretStore {
    return this.#store ??= new EncryptedPostgresSecretStore();
  }
}

class VibyClient<Framework extends FrameworkId> implements Viby<Framework> {
  readonly framework: Framework;
  readonly integrations: IntegrationClient;
  readonly toolSources: ToolSourceAuthorizationCallbacks;
  readonly #repository: Repository;
  readonly #environment: EnvironmentManager | undefined;
  readonly #skillResolver: SkillResolver;
  readonly #models: GenerationModelRegistry<Framework>;
  readonly #skills: SkillGroups;
  readonly #sandbox: SandboxAdapter | undefined;
  readonly #deploymentPreparation: DeploymentPreparationConfig<Framework> | undefined;
  readonly #browser: BrowserAdapter | undefined;
  readonly #registry = new GenerationRunRegistry();
  readonly #sandboxes: SandboxRegistry;
  readonly #previews: PreviewRegistry<Framework>;
  readonly #runner: GenerationRunner<Framework>;
  readonly #workers = new Set<GenerationWorker<Framework>>();
  readonly #deletedChatsMs: number | null;
  readonly #eventSinks: ReadonlyMap<string, OutboundEventSink>;
  readonly #toolSources: readonly ToolSource<Framework>[];
  readonly #toolSourceRegistry: ToolSourceRegistry<Framework>;

  constructor(
    config: VibyConfig<Framework>,
    dependencies: ClientDependencies<Framework>,
  ) {
    this.framework = config.framework;
    this.integrations = dependencies.integrations ?? new IntegrationClient(undefined, null, null);
    this.#sandbox = config.sandbox;
    this.#deploymentPreparation = config.deployment?.preparation;
    this.#browser = config.browser;
    this.#repository = dependencies.repository;
    this.#environment = dependencies.environment;
    this.#deletedChatsMs = normalizeChatRetentionConfig(config.retention);
    this.#eventSinks = normalizeOutboundEventSinks(config.events);
    this.#toolSources = Object.freeze([
      ...new Set(Object.values(config.tools?.sources ?? {})),
    ]);
    this.#toolSourceRegistry = new ToolSourceRegistry(
      this.#repository,
      config.tools?.adapters,
      dependencies.secretStore ?? null,
    );
    this.toolSources = new ToolSourceAuthorizationCallbacks(this.#toolSourceRegistry);
    this.#sandboxes = new SandboxRegistry(this.#repository, config.sandboxPolicy);
    this.#previews = new PreviewRegistry(
      this.#repository,
      this.#sandboxes,
      this.#sandbox,
      config.preview,
    );
    this.#skillResolver = dependencies.skillResolver;
    this.#models = new GenerationModelRegistry(config, dependencies, config.tools ? {
      ...config.tools,
      registry: this.#toolSourceRegistry,
    } : undefined);
    this.#skills = normalizeSkillGroups(
      withFrameworkSkill(config.framework, config.skills),
    );
    const quality = normalizeGenerationQuality(config.generation?.quality);
    if (quality && !this.#sandbox) {
      throw new ConfigurationError(
        "generation.quality requires a sandbox adapter configured on createViby.",
      );
    }
    this.#runner = new GenerationRunner({
      framework: this.framework,
      repository: this.#repository,
      models: this.#models,
      skillResolver: this.#skillResolver,
      registry: this.#registry,
      automatic: normalizeGenerationExecution(config.generation) === "embedded",
      sandbox: this.#sandbox,
      sandboxPolicy: config.sandboxPolicy,
      sandboxes: this.#sandboxes,
      quality,
      agent: normalizeAgentRunnerConfig(config.agent),
      telemetry: normalizeTelemetry(config.telemetry),
      cost: normalizeCostConfig(config.cost),
    });
  }

  forUser(scope: UserScope): ScopedViby<Framework> {
    const normalizedScope = {
      tenantId: assertIdentifier(scope.tenantId, "tenantId"),
      userId: assertIdentifier(scope.userId, "userId"),
    };
    return new ScopedViby({
      scope: normalizedScope,
      framework: this.framework,
      repository: this.#repository,
      runner: this.#runner,
      registry: this.#registry,
      models: this.#models,
      skills: this.#skills,
      sandbox: this.#sandbox,
      deploymentPreparation: this.#deploymentPreparation,
      browser: this.#browser,
      sandboxes: this.#sandboxes,
      previews: this.#previews,
      toolSourceRegistry: this.#toolSourceRegistry,
      deletedChatsMs: this.#deletedChatsMs,
      eventSinks: this.#eventSinks,
      integrations: this.integrations,
      environment: this.#environment,
    });
  }

  worker(options: GenerationWorkerOptions): GenerationWorker<Framework> {
    const worker = new GenerationWorker(this.#runner, options);
    this.#workers.add(worker);
    return worker;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.#workers].map((worker) => worker.stop()));
    await this.#registry.abortAll("Viby client closed.");
    const preview = await Promise.allSettled([this.#previews.stopAll()]);
    const [sandboxes, toolSources, toolSourceRegistry, environment, integrations, repository]
      = await Promise.allSettled([
      this.#sandboxes.stopAll(),
      Promise.all(this.#toolSources.map((source) => source.close?.())),
      this.#toolSourceRegistry.close(),
      this.#environment?.close(),
      this.integrations.close(),
      this.#repository.close(),
    ]);
    if (preview[0]?.status === "rejected") throw preview[0].reason;
    if (sandboxes.status === "rejected") throw sandboxes.reason;
    if (toolSources.status === "rejected") throw toolSources.reason;
    if (toolSourceRegistry.status === "rejected") throw toolSourceRegistry.reason;
    if (environment.status === "rejected") throw environment.reason;
    if (integrations.status === "rejected") throw integrations.reason;
    if (repository.status === "rejected") throw repository.reason;
  }
}

/** Handles provider callbacks that are intentionally not tied to an authenticated browser request. */
export class ToolSourceAuthorizationCallbacks {
  readonly #registry: ToolSourceRegistry;

  constructor(registry: ToolSourceRegistry) {
    this.#registry = registry;
  }

  callback(request: Request | string): Promise<CompleteToolSourceAuthorizationResult> {
    return this.#registry.callback(request);
  }
}

interface NormalizedGenerationWorkerOptions {
  readonly id: string;
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly heartbeatMs: number;
  readonly pollIntervalMs: number;
}

export class GenerationWorker<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly #runner: GenerationRunner<Framework>;
  readonly #options: NormalizedGenerationWorkerOptions;
  readonly #controller = new AbortController();
  #runPromise: Promise<void> | null = null;
  #isRunning = false;

  constructor(runner: GenerationRunner<Framework>, options: GenerationWorkerOptions) {
    this.#runner = runner;
    this.#options = normalizeGenerationWorkerOptions(options);
    this.id = this.#options.id;
  }

  get running(): boolean {
    return this.#isRunning;
  }

  async runOnce(options: GenerationWorkerRunOptions = {}): Promise<boolean> {
    validateGenerationWorkerRunOptions(options);
    if (this.#runPromise) {
      throw new ConfigurationError("runOnce cannot be called while the generation worker is running.");
    }
    const signal = combineAbortSignals(this.#controller.signal, options.signal);
    signal.throwIfAborted();
    return this.#runner.runNext(this.#options, signal);
  }

  run(options: GenerationWorkerRunOptions = {}): Promise<void> {
    validateGenerationWorkerRunOptions(options);
    if (this.#runPromise) return this.#runPromise;
    const signal = combineAbortSignals(this.#controller.signal, options.signal);
    this.#isRunning = true;
    this.#runPromise = Promise.all(
      Array.from({ length: this.#options.concurrency }, () => this.#runLane(signal)),
    ).then(() => undefined).finally(() => {
      this.#isRunning = false;
    });
    return this.#runPromise;
  }

  async stop(): Promise<void> {
    if (!this.#controller.signal.aborted) {
      this.#controller.abort(new DOMException("Generation worker stopped.", "AbortError"));
    }
    await this.#runPromise?.catch((error) => {
      if (!isAbortError(error)) throw error;
    });
  }

  async #runLane(signal: AbortSignal): Promise<void> {
    try {
      while (!signal.aborted) {
        const worked = await this.#runner.runNext(this.#options, signal);
        if (!worked) await waitForPoll(this.#options.pollIntervalMs, signal);
      }
    } catch (error) {
      if (!signal.aborted && !isAbortError(error)) throw error;
    }
  }
}

interface ScopedDependencies<Framework extends FrameworkId> {
  readonly scope: UserScope;
  readonly framework: Framework;
  readonly repository: Repository;
  readonly runner: GenerationRunner<Framework>;
  readonly registry: GenerationRunRegistry;
  readonly models: GenerationModelRegistry<Framework>;
  readonly skills: SkillGroups;
  readonly sandbox: SandboxAdapter | undefined;
  readonly deploymentPreparation: DeploymentPreparationConfig<Framework> | undefined;
  readonly browser: BrowserAdapter | undefined;
  readonly sandboxes: SandboxRegistry;
  readonly previews: PreviewRegistry<Framework>;
  readonly toolSourceRegistry: ToolSourceRegistry<Framework>;
  readonly deletedChatsMs: number | null;
  readonly eventSinks: ReadonlyMap<string, OutboundEventSink>;
  readonly integrations: IntegrationClient;
  readonly environment: EnvironmentManager | undefined;
}

export class ScopedViby<Framework extends FrameworkId = FrameworkId> {
  readonly scope: UserScope;
  readonly chats: ChatCollection<Framework>;
  readonly generations: GenerationCollection<Framework>;
  readonly sandboxes: SandboxCollection<Framework>;
  readonly previews: PreviewCollection<Framework>;
  readonly toolSources: RegisteredToolSourceCollection<Framework>;
  readonly integrations: ReturnType<IntegrationClient["forUser"]>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.scope = dependencies.scope;
    this.chats = new ChatCollection(dependencies);
    this.generations = new GenerationCollection(dependencies);
    this.sandboxes = new SandboxCollection(dependencies);
    this.previews = new PreviewCollection(dependencies);
    this.toolSources = new RegisteredToolSourceCollection(dependencies);
    this.integrations = dependencies.integrations.forUser(
      dependencies.scope,
      dependencies.repository,
    );
  }
}

export class PreviewCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async get(id: string): Promise<Preview<Framework>> {
    const data = await this.#dependencies.previews.get(
      this.#dependencies.scope,
      assertIdentifier(id, "Preview id"),
    );
    return new Preview(data, this.#dependencies);
  }

  list(options: PreviewSessionListOptions = {}): Promise<PreviewSessionData<Framework>[]> {
    return this.#dependencies.previews.list(this.#dependencies.scope, options);
  }

  cleanupExpired(limit?: number): Promise<number> {
    return this.#dependencies.previews.cleanupExpired(this.#dependencies.scope, limit);
  }
}

export class Preview<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;
  #data: PreviewSessionData<Framework>;

  constructor(data: PreviewSessionData<Framework>, dependencies: ScopedDependencies<Framework>) {
    this.#data = data;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#data.id; }
  get chatId(): string { return this.#data.chatId; }
  get versionId(): string { return this.#data.versionId; }
  get framework(): Framework { return this.#data.framework; }
  get status(): PreviewSessionData["status"] { return this.#data.status; }
  get url(): string | null { return this.#data.url; }

  data(): PreviewSessionData<Framework> {
    return this.#data;
  }

  async reconnect(signal?: AbortSignal): Promise<this> {
    this.#data = await this.#dependencies.previews.reconnect(
      this.#dependencies.scope,
      this.id,
      signal,
    );
    return this;
  }

  async stop(signal?: AbortSignal): Promise<this> {
    this.#data = await this.#dependencies.previews.stop(
      this.#dependencies.scope,
      this.id,
      signal,
    );
    return this;
  }
}

export class RegisteredToolSourceCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async create(input: CreateToolSourceInput): Promise<RegisteredToolSource<Framework>> {
    const data = await this.#dependencies.toolSourceRegistry.create(
      this.#dependencies.scope,
      input,
    );
    return new RegisteredToolSource(data, this.#dependencies);
  }

  async get(id: string): Promise<RegisteredToolSource<Framework>> {
    const data = await this.#dependencies.toolSourceRegistry.get(
      this.#dependencies.scope,
      assertIdentifier(id, "Tool source id"),
    );
    return new RegisteredToolSource(data, this.#dependencies);
  }

  async list(
    options: ToolSourceRegistrationListOptions = {},
  ): Promise<readonly RegisteredToolSource<Framework>[]> {
    const records = await this.#dependencies.toolSourceRegistry.list(
      this.#dependencies.scope,
      options,
    );
    return records.map((data) => new RegisteredToolSource(data, this.#dependencies));
  }
}

export class RegisteredToolSource<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;
  #data: ToolSourceRegistrationData;

  constructor(
    data: ToolSourceRegistrationData,
    dependencies: ScopedDependencies<Framework>,
  ) {
    this.#data = data;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#data.id; }
  get type(): string { return this.#data.type; }
  get name(): string { return this.#data.name; }
  get status(): ToolSourceRegistrationData["status"] { return this.#data.status; }

  data(): ToolSourceRegistrationData {
    return this.#data;
  }

  connection(): Promise<ToolSourceConnectionData | null> {
    return this.#dependencies.toolSourceRegistry.connection(
      this.#dependencies.scope,
      this.id,
    );
  }

  connect(input: ConnectToolSourceInput): Promise<ConnectToolSourceResult> {
    return this.#dependencies.toolSourceRegistry.connect(
      this.#dependencies.scope,
      this.id,
      input,
    );
  }

  disconnect(signal?: AbortSignal): Promise<DisconnectToolSourceResult> {
    return this.#dependencies.toolSourceRegistry.disconnect(
      this.#dependencies.scope,
      this.id,
      signal,
    );
  }

  async update(input: UpdateToolSourceInput): Promise<this> {
    this.#data = await this.#dependencies.toolSourceRegistry.update(
      this.#dependencies.scope,
      this.id,
      input,
    );
    return this;
  }

  async archive(): Promise<this> {
    this.#data = await this.#dependencies.toolSourceRegistry.archive(
      this.#dependencies.scope,
      this.id,
    );
    return this;
  }
}

export class ChatToolSourceSelection<Framework extends FrameworkId = FrameworkId> {
  readonly #chatId: string;
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(chatId: string, dependencies: ScopedDependencies<Framework>) {
    this.#chatId = chatId;
    this.#dependencies = dependencies;
  }

  async list(): Promise<readonly RegisteredToolSource<Framework>[]> {
    const records = await this.#dependencies.toolSourceRegistry.selected(
      this.#dependencies.scope,
      this.#chatId,
    );
    return records.map((data) => new RegisteredToolSource(data, this.#dependencies));
  }

  async set(sourceIds: readonly string[]): Promise<readonly RegisteredToolSource<Framework>[]> {
    const records = await this.#dependencies.toolSourceRegistry.select(
      this.#dependencies.scope,
      this.#chatId,
      sourceIds.map((id) => assertIdentifier(id, "Tool source id")),
    );
    return records.map((data) => new RegisteredToolSource(data, this.#dependencies));
  }
}

export class SandboxCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async get(id: string): Promise<SandboxLeaseData<Framework>> {
    const lease = await this.#dependencies.sandboxes.get<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!lease) throw new NotFoundError("Sandbox lease");
    return lease;
  }

  reconnect(
    id: string,
    options: SandboxReconnectOptions = {},
  ): Promise<SandboxSession> {
    return this.#dependencies.sandboxes.reconnect(
      this.#dependencies.sandbox,
      this.#dependencies.scope,
      id,
      options,
    );
  }
}

export class ChatCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async create(input: CreateChatInput = {}): Promise<Chat<Framework>> {
    const title = normalizeChatTitle(input.title);
    const metadata = normalizeChatMetadata(input.metadata);
    const data = await this.#dependencies.repository.createChat(this.#dependencies.scope, {
      id: createId(),
      title,
      metadata,
      framework: this.#dependencies.framework,
    });
    return new Chat(data, this.#dependencies);
  }

  async import<Input = never>(
    input: ImportProjectInput | AdapterProjectImportInput<Input, Framework>,
  ): Promise<Chat<Framework>> {
    if (!input || !input.source) {
      throw new ConfigurationError("Project import requires files, ZIP bytes, or an adapter source.");
    }
    const adapterResult = input.source.type === "adapter"
      ? await resolveSourceImport(input as AdapterProjectImportInput<Input, Framework>, {
          ...this.#dependencies.scope,
          framework: this.#dependencies.framework,
        })
      : null;
    const title = normalizeChatTitle(input.title ?? adapterResult?.title);
    const summary = input.summary?.trim()
      || adapterResult?.summary?.trim()
      || "Imported project source.";
    if (summary.length > 2_000) {
      throw new ConfigurationError("An import summary cannot exceed 2,000 characters.");
    }
    const entries = importProjectFiles(adapterResult?.source ?? input.source as ImportProjectSource, input.filePolicy);
    const metadata = normalizeChatMetadata(input.metadata);
    const imported = await this.#dependencies.repository.importChat(
      this.#dependencies.scope,
      {
        chatId: createId(),
        versionId: createId(),
        title,
        metadata,
        summary,
        framework: this.#dependencies.framework,
        files: entries.files,
        artifacts: entries.artifacts,
      },
    );
    return new Chat(imported.chat, this.#dependencies);
  }

  async get(id: string): Promise<Chat<Framework>> {
    const data = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!data) throw new NotFoundError("Chat");
    return new Chat(data, this.#dependencies);
  }

  async snapshot(
    id: string,
    options: { readonly messages?: PageOptions; readonly versions?: PageOptions } = {},
  ): Promise<{
    readonly chat: Chat<Framework>;
    readonly messages: CursorPage<MessageData>;
    readonly versions: CursorPage<Version<Framework>>;
  }> {
    const chatId = assertIdentifier(id, "Chat id");
    const messageLimit = normalizePageLimit(options.messages?.limit);
    const versionLimit = normalizePageLimit(options.versions?.limit);
    const request = {
      chatId,
      messages: {
        limit: messageLimit,
        after: decodeMessageCursor(options.messages?.after),
      },
      versions: {
        limit: versionLimit,
        after: decodeVersionCursor(options.versions?.after),
      },
    };
    const snapshot: ChatReadSnapshot<Framework> | null = this.#dependencies.repository.readChatSnapshot
      ? await this.#dependencies.repository.readChatSnapshot<Framework>(
          this.#dependencies.scope,
          request,
        )
      : await this.#fallbackSnapshot(request);
    if (!snapshot) throw new NotFoundError("Chat");
    const lastMessage = snapshot.messages.items.at(-1);
    const lastVersion = snapshot.versions.items.at(-1);
    return {
      chat: new Chat(snapshot.chat, this.#dependencies),
      messages: {
        items: snapshot.messages.items,
        nextCursor: snapshot.messages.hasMore && lastMessage
          ? encodeMessageCursor({ createdAt: lastMessage.createdAt, id: lastMessage.id })
          : null,
      },
      versions: {
        items: snapshot.versions.items.map((version) => new Version(version, this.#dependencies)),
        nextCursor: snapshot.versions.hasMore && lastVersion
          ? encodeVersionCursor({ number: lastVersion.number })
          : null,
      },
    };
  }

  async #fallbackSnapshot(
    request: Parameters<NonNullable<Repository["readChatSnapshot"]>>[1],
  ): Promise<ChatReadSnapshot<Framework> | null> {
    const [chat, messages, versions] = await Promise.all([
      this.#dependencies.repository.getChat<Framework>(this.#dependencies.scope, request.chatId),
      this.#dependencies.repository.listMessagePage(
        this.#dependencies.scope,
        request.chatId,
        request.messages.limit,
        request.messages.after,
      ),
      this.#dependencies.repository.listVersionPage<Framework>(
        this.#dependencies.scope,
        request.chatId,
        request.versions.limit,
        request.versions.after,
      ),
    ]);
    return chat ? { chat, messages, versions } : null;
  }

  async restore(id: string): Promise<Chat<Framework>> {
    const data = await this.#dependencies.repository.restoreChat<Framework>(
      this.#dependencies.scope,
      assertIdentifier(id, "Chat id"),
      new Date(),
    );
    return new Chat(data, this.#dependencies);
  }

  async purgeDeleted(input: PurgeDeletedChatsInput = {}): Promise<number> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Deleted chat purge options must be an object.");
    }
    const limit = normalizePageLimit(input.limit);
    return this.#dependencies.repository.purgeDeletedChats(
      this.#dependencies.scope,
      new Date(),
      limit,
    );
  }

  async list(options: ChatListOptions = {}): Promise<CursorPage<Chat<Framework>>> {
    const limit = normalizePageLimit(options.limit);
    const metadata = normalizeChatMetadata(options.metadata);
    const page = await this.#dependencies.repository.listChatPage<Framework>(
      this.#dependencies.scope,
      limit,
      decodeChatCursor(options.after),
      metadata,
    );
    const items = page.items.map((record) => new Chat(record, this.#dependencies));
    const last = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last
        ? encodeChatCursor({ updatedAt: last.updatedAt, id: last.id })
        : null,
    };
  }
}

export class GenerationCollection<Framework extends FrameworkId = FrameworkId> {
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(dependencies: ScopedDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  async get(id: string): Promise<Generation<Framework>> {
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      id,
    );
    if (!generation) throw new NotFoundError("Generation");
    await assertActiveChat(this.#dependencies, generation.chatId);
    return new Generation(generation.id, generation.chatId, this.#dependencies);
  }
}

export class Chat<Framework extends FrameworkId = FrameworkId> {
  readonly #data: ChatData<Framework>;
  readonly #dependencies: ScopedDependencies<Framework>;
  readonly environment: EnvironmentVariableCollection;
  readonly toolSources: ChatToolSourceSelection<Framework>;

  constructor(data: ChatData<Framework>, dependencies: ScopedDependencies<Framework>) {
    this.#data = data;
    this.#dependencies = dependencies;
    this.environment = dependencies.environment?.forChat(dependencies.scope, data.id)
      ?? unavailableEnvironmentVariables();
    this.toolSources = new ChatToolSourceSelection(data.id, dependencies);
  }

  get id(): string { return this.#data.id; }
  get title(): string { return this.#data.title; }
  get metadata(): ChatData["metadata"] { return this.#data.metadata; }
  get framework(): Framework { return this.#data.framework; }
  get createdAt(): Date { return this.#data.createdAt; }
  get updatedAt(): Date { return this.#data.updatedAt; }

  async update(input: UpdateChatInput): Promise<Chat<Framework>> {
    if (!input || (input.title === undefined && input.metadata === undefined)) {
      throw new ConfigurationError("Chat update requires a title or metadata value.");
    }
    const data = await this.#dependencies.repository.updateChat<Framework>(
      this.#dependencies.scope,
      this.id,
      {
        title: input.title === undefined ? this.title : normalizeChatTitle(input.title),
        metadata: input.metadata === undefined
          ? this.metadata
          : normalizeChatMetadata(input.metadata),
      },
    );
    return new Chat(data, this.#dependencies);
  }

  async delete(input: DeleteChatInput = {}): Promise<ChatDeletionData> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Chat deletion options must be an object.");
    }
    const retentionMs = normalizeRetentionMs(input.retentionMs, this.#dependencies.deletedChatsMs);
    const deletedAt = new Date();
    return this.#dependencies.repository.deleteChat(this.#dependencies.scope, this.id, {
      deletedAt,
      purgeAfter: retentionMs === null ? null : new Date(deletedAt.getTime() + retentionMs),
    });
  }

  async start(input: GenerateInput): Promise<Generation<Framework>> {
    await this.#assertActive();
    const latest = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return this.#startFrom(input, latest);
  }

  async generate(input: GenerateInput): Promise<Version<Framework>> {
    return unwrapGenerationOutcome(await (await this.start(input)).wait());
  }

  async getGeneration(id: string): Promise<Generation<Framework>> {
    await this.#assertActive();
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      id,
    );
    if (!generation || generation.chatId !== this.id) throw new NotFoundError("Generation");
    return new Generation(generation.id, generation.chatId, this.#dependencies);
  }

  async latestVersion(): Promise<Version<Framework> | null> {
    await this.#assertActive();
    const data = await this.#dependencies.repository.getLatestVersion<Framework>(
      this.#dependencies.scope,
      this.id,
    );
    return data ? new Version(data, this.#dependencies) : null;
  }

  async getVersion(id: string): Promise<Version<Framework>> {
    await this.#assertActive();
    const data = await this.#dependencies.repository.getVersion<Framework>(
      this.#dependencies.scope,
      id,
    );
    if (!data || data.chatId !== this.id) throw new NotFoundError("Version");
    return new Version(data, this.#dependencies);
  }

  async listVersions(options: PageOptions = {}): Promise<CursorPage<Version<Framework>>> {
    await this.#assertActive();
    const limit = normalizePageLimit(options.limit);
    const page = await this.#dependencies.repository.listVersionPage<Framework>(
      this.#dependencies.scope,
      this.id,
      limit,
      decodeVersionCursor(options.after),
    );
    const items = page.items.map((record) => new Version(record, this.#dependencies));
    const last = page.items.at(-1);
    return {
      items,
      nextCursor: page.hasMore && last ? encodeVersionCursor({ number: last.number }) : null,
    };
  }

  async repositoryLinks(): Promise<readonly RepositoryLinkData[]> {
    await this.#assertActive();
    return this.#dependencies.repository.listRepositoryLinks(
      this.#dependencies.scope,
      this.id,
    );
  }

  async repositoryPushes(): Promise<readonly RepositoryPushData[]> {
    await this.#assertActive();
    return this.#dependencies.repository.listRepositoryPushes(
      this.#dependencies.scope,
      { chatId: this.id },
    );
  }

  async deploymentProjects(): Promise<readonly DeploymentProjectLinkData[]> {
    await this.#assertActive();
    return this.#dependencies.repository.listDeploymentProjects(
      this.#dependencies.scope,
      this.id,
    );
  }

  async deployments(): Promise<readonly DeploymentRecordData[]> {
    await this.#assertActive();
    return this.#dependencies.repository.listDeployments(
      this.#dependencies.scope,
      { chatId: this.id },
    );
  }

  async listMessages(options: PageOptions = {}): Promise<CursorPage<MessageData>> {
    await this.#assertActive();
    const limit = normalizePageLimit(options.limit);
    const page = await this.#dependencies.repository.listMessagePage(
      this.#dependencies.scope,
      this.id,
      limit,
      decodeMessageCursor(options.after),
    );
    const last = page.items.at(-1);
    return {
      items: page.items,
      nextCursor: page.hasMore && last
        ? encodeMessageCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    };
  }

  async getMessage(id: string): Promise<MessageData> {
    await this.#assertActive();
    const message = await this.#dependencies.repository.getMessage(
      this.#dependencies.scope,
      this.id,
      id,
    );
    if (!message) throw new NotFoundError("Message");
    return message;
  }

  async getAttachment(id: string): Promise<AttachmentContent> {
    await this.#assertActive();
    const attachment = await this.#dependencies.repository.getAttachment(
      this.#dependencies.scope,
      this.id,
      assertIdentifier(id, "attachment id"),
    );
    if (!attachment) throw new NotFoundError("Attachment");
    return attachment;
  }

  startFromVersion(
    input: GenerateInput,
    version: VersionData<Framework>,
  ): Promise<Generation<Framework>> {
    return this.#startFrom(input, version);
  }

  async generateFromVersion(
    input: GenerateInput,
    version: VersionData<Framework>,
  ): Promise<Version<Framework>> {
    return unwrapGenerationOutcome(await (await this.#startFrom(input, version)).wait());
  }

  async #startFrom(
    input: GenerateInput,
    baseVersion: VersionData<Framework> | null,
  ): Promise<Generation<Framework>> {
    await this.#assertActive();
    const prompt = assertPrompt(input.prompt);
    const selected = normalizeGenerationConfiguration(
      input,
      this.#dependencies.skills,
      this.#dependencies.models,
    );
    const attachments = normalizeAttachments(input.attachments);
    const toolSources = await this.#dependencies.toolSourceRegistry.snapshot(
      this.#dependencies.scope,
      this.id,
    );
    const generationId = createId();
    const attemptId = createId();
    await this.#dependencies.repository.createGeneration(this.#dependencies.scope, {
      id: generationId,
      attemptId,
      chatId: this.id,
      baseVersionId: baseVersion?.id ?? null,
      prompt,
      modelProvider: selected.model.provider,
      modelId: selected.model.id,
      configuration: { ...selected.configuration, toolSources },
      attachments,
    });
    this.#dependencies.runner.schedule(this.#dependencies.scope, generationId, attemptId);
    return new Generation(generationId, this.id, this.#dependencies);
  }

  async #assertActive(): Promise<void> {
    await assertActiveChat(this.#dependencies, this.id);
  }
}

export class Generation<Framework extends FrameworkId = FrameworkId> {
  readonly #id: string;
  readonly #chatId: string;
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(
    id: string,
    chatId: string,
    dependencies: ScopedDependencies<Framework>,
  ) {
    this.#id = id;
    this.#chatId = chatId;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#id; }
  get chatId(): string { return this.#chatId; }

  async data(): Promise<GenerationData> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      this.id,
    );
    if (!generation) throw new NotFoundError("Generation");
    return generation;
  }

  async attempts(): Promise<GenerationAttemptData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listGenerationAttempts(
      this.#dependencies.scope,
      this.id,
    );
  }

  async tasks(): Promise<GenerationTaskData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listGenerationTasks(
      this.#dependencies.scope,
      this.id,
    );
  }

  async toolCalls(): Promise<ToolCallData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listToolCalls(
      this.#dependencies.scope,
      this.id,
    );
  }

  async artifacts(): Promise<readonly GeneratedArtifactData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listGeneratedArtifacts(
      this.#dependencies.scope,
      this.id,
    );
  }

  async getArtifact(id: string): Promise<GeneratedArtifactContent> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const artifact = await this.#dependencies.repository.getGeneratedArtifact(
      this.#dependencies.scope,
      this.id,
      assertIdentifier(id, "generated artifact id"),
    );
    if (!artifact) throw new NotFoundError("Generated artifact");
    return artifact;
  }

  async events(options: GenerationEventOptions = {}): Promise<GenerationEventPage> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const after = normalizeCursor(options.after);
    const limit = options.limit ?? DEFAULT_EVENT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new ConfigurationError("Generation event limit must be an integer between 1 and 500.");
    }
    const events = await this.#dependencies.repository.listGenerationEvents(
      this.#dependencies.scope,
      this.id,
      after,
      limit,
    );
    return {
      events,
      nextCursor: events.at(-1)?.cursor ?? null,
    };
  }

  async deliverEvents(options: OutboundEventDeliveryOptions): Promise<OutboundEventDeliveryPage> {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Outbound event delivery options must be an object.");
    }
    const sinkId = assertIdentifier(options.sink, "Outbound event sink id");
    const sink = this.#dependencies.eventSinks.get(sinkId);
    if (!sink) throw new ConfigurationError(`Outbound event sink is not configured: ${sinkId}`);
    const retry = normalizeOutboundRetryPolicy(options.retry);
    const after = normalizeCursor(options.after);
    const page = await this.events({
      after,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
    });
    const deliveries: OutboundEventReceipt[] = [];
    const deadLetters: OutboundEventDeliveryData[] = [];
    let cursor = after;
    let retryAt: Date | null = null;
    for (const event of page.events) {
      options.signal?.throwIfAborted();
      const claim = await this.#dependencies.repository.claimOutboundEventDelivery(
        this.#dependencies.scope,
        {
          generationId: this.id,
          eventCursor: event.cursor,
          sinkId,
          leaseToken: createId(),
          leaseMs: retry.leaseMs,
          maxAttempts: retry.maxAttempts,
        },
      );
      if (!claim) {
        const existing = await this.#dependencies.repository.getOutboundEventDelivery(
          this.#dependencies.scope,
          this.id,
          event.cursor,
          sinkId,
        );
        if (!existing) {
          throw new GenerationStateError(this.id, `Outbound event ${event.cursor} could not be claimed.`);
        }
        if (existing.status === "delivered") {
          cursor = event.cursor;
          continue;
        }
        if (existing.status === "dead_lettered") {
          deadLetters.push(existing);
          cursor = event.cursor;
          continue;
        }
        retryAt = existing.status === "delivering"
          ? existing.leaseExpiresAt
          : existing.nextAttemptAt;
        break;
      }
      try {
        const receipt = await sink.deliver(event, {
          ...this.#dependencies.scope,
          chatId: this.chatId,
          generationId: this.id,
          ...(options.signal ? { signal: options.signal } : {}),
        });
        await this.#dependencies.repository.completeOutboundEventDelivery(
          this.#dependencies.scope,
          claim,
          receipt.deliveredAt,
        );
        deliveries.push(receipt);
        cursor = event.cursor;
      } catch (error) {
        let failed: OutboundEventDeliveryData | null = null;
        try {
          failed = await this.#dependencies.repository.failOutboundEventDelivery(
            this.#dependencies.scope,
            {
              generationId: this.id,
              eventCursor: event.cursor,
              sinkId,
              leaseToken: claim.leaseToken,
              error: errorMessage(error),
              retryDelayMs: outboundRetryDelay(retry, claim.delivery.attemptCount),
            },
          );
        } catch {
          failed = await this.#dependencies.repository.getOutboundEventDelivery(
            this.#dependencies.scope,
            this.id,
            event.cursor,
            sinkId,
          ).catch(() => null);
        }
        throw new OutboundEventDeliveryError(
          sink.id,
          `${this.id}:${event.cursor}`,
          event.cursor,
          cursor,
          failed,
          { cause: error },
        );
      }
    }
    return Object.freeze({
      deliveries: Object.freeze(deliveries),
      deadLetters: Object.freeze(deadLetters),
      cursor,
      hasMore: retryAt !== null || page.events.length === (options.limit ?? DEFAULT_EVENT_LIMIT),
      retryAt,
    });
  }

  async outboundDeliveries(
    options: OutboundEventDeliveryListOptions,
  ): Promise<readonly OutboundEventDeliveryData[]> {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Outbound event delivery list options must be an object.");
    }
    const sinkId = assertIdentifier(options.sink, "Outbound event sink id");
    normalizeOutboundDeliveryStatus(options.status);
    return this.#dependencies.repository.listOutboundEventDeliveries(
      this.#dependencies.scope,
      this.id,
      sinkId,
      options.status,
    );
  }

  async redriveOutboundEvent(
    input: OutboundEventRedriveInput,
  ): Promise<OutboundEventDeliveryData> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Outbound event redrive input must be an object.");
    }
    const sinkId = assertIdentifier(input.sink, "Outbound event sink id");
    const cursor = normalizeCursor(input.cursor);
    if (cursor === "0") throw new ConfigurationError("A persisted event cursor is required.");
    return this.#dependencies.repository.redriveOutboundEventDelivery(
      this.#dependencies.scope,
      this.id,
      cursor,
      sinkId,
    );
  }

  async *stream(options: GenerationStreamOptions = {}): AsyncGenerator<GenerationEvent> {
    let cursor = normalizeCursor(options.after);
    const pollIntervalMs = normalizePollInterval(options.pollIntervalMs);

    while (true) {
      options.signal?.throwIfAborted();
      const page = await this.events({ after: cursor, limit: DEFAULT_EVENT_LIMIT });
      for (const event of page.events) {
        cursor = event.cursor;
        yield event;
      }
      if (page.events.length === DEFAULT_EVENT_LIMIT) continue;

      const generation = await this.data();
      if (isSettled(generation.status)) {
        const finalPage = await this.events({ after: cursor, limit: DEFAULT_EVENT_LIMIT });
        if (finalPage.events.length > 0) {
          for (const event of finalPage.events) {
            cursor = event.cursor;
            yield event;
          }
          continue;
        }
        return;
      }
      await waitForPoll(pollIntervalMs, options.signal);
    }
  }

  toEventStreamResponse(options: GenerationEventStreamResponseOptions = {}): Response {
    return generationEventStreamResponse(this, options);
  }

  async wait(options: GenerationWaitOptions = {}): Promise<GenerationOutcome<Framework>> {
    const pollIntervalMs = normalizePollInterval(options.pollIntervalMs);
    while (true) {
      options.signal?.throwIfAborted();
      const generation = await this.data();
      switch (generation.status) {
        case "succeeded": {
          const version = await this.#dependencies.repository.getVersionByGeneration<Framework>(
            this.#dependencies.scope,
            this.id,
          );
          if (!version) throw new NotFoundError("Generated version");
          return {
            status: "succeeded",
            generation,
            version: new Version(version, this.#dependencies),
          };
        }
        case "waiting":
          return {
            status: "waiting",
            generation,
            tasks: (await this.tasks()).filter((task) => task.status === "pending"),
          };
        case "failed":
          return {
            status: "failed",
            generation,
            error: generation.error ?? "Generation failed.",
          };
        case "cancelled":
          return {
            status: "cancelled",
            generation,
            reason: generation.error ?? "Generation was cancelled.",
          };
        default:
          await waitForPoll(pollIntervalMs, options.signal);
      }
    }
  }

  async cancel(reason = "Cancelled by user."): Promise<GenerationData> {
    const normalizedReason = assertReason(reason);
    const changed = await this.#dependencies.repository.cancelGeneration(
      this.#dependencies.scope,
      this.id,
      normalizedReason,
    );
    if (changed) this.#dependencies.registry.abort(this.id, normalizedReason);
    return this.data();
  }

  async retry(): Promise<this> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (this.#dependencies.registry.has(this.id)) {
      throw new GenerationStateError(this.id, "Generation already has an active local attempt.");
    }
    const attempt = await this.#dependencies.repository.createGenerationAttempt(
      this.#dependencies.scope,
      { id: createId(), generationId: this.id, reason: "retry" },
    );
    this.#dependencies.runner.schedule(this.#dependencies.scope, this.id, attempt.id);
    return this;
  }

  async resume(): Promise<this> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (this.#dependencies.registry.has(this.id)) {
      throw new GenerationStateError(this.id, "Generation already has an active local attempt.");
    }
    const attempt = await this.#dependencies.repository.createGenerationAttempt(
      this.#dependencies.scope,
      { id: createId(), generationId: this.id, reason: "resume" },
    );
    this.#dependencies.runner.schedule(this.#dependencies.scope, this.id, attempt.id);
    return this;
  }

  async resolve(input: ResolveGenerationTaskInput): Promise<this> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (this.#dependencies.registry.has(this.id)) {
      throw new GenerationStateError(this.id, "Generation already has an active local attempt.");
    }
    const tasks = await this.tasks();
    const task = tasks.find((candidate) => candidate.id === input.taskId);
    if (!task) throw new NotFoundError("Generation task");
    validateResolution(task, input.resolution);
    const attempt = await this.#dependencies.repository.resolveGenerationTask(
      this.#dependencies.scope,
      {
        generationId: this.id,
        taskId: task.id,
        attemptId: createId(),
        resolution: input.resolution,
        resolutionMessage: renderResolution(input.resolution),
      },
    );
    this.#dependencies.runner.schedule(this.#dependencies.scope, this.id, attempt.id);
    return this;
  }
}

export class Version<Framework extends FrameworkId = FrameworkId> {
  readonly #data: VersionData<Framework>;
  readonly #dependencies: ScopedDependencies<Framework>;

  constructor(data: VersionData<Framework>, dependencies: ScopedDependencies<Framework>) {
    this.#data = data;
    this.#dependencies = dependencies;
  }

  get id(): string { return this.#data.id; }
  get chatId(): string { return this.#data.chatId; }
  get generationId(): string | null { return this.#data.generationId; }
  get parentVersionId(): string | null { return this.#data.parentVersionId; }
  get number(): number { return this.#data.number; }
  get origin(): VersionData["origin"] { return this.#data.origin; }
  get framework(): Framework { return this.#data.framework; }
  get title(): string { return this.#data.title; }
  get summary(): string { return this.#data.summary; }
  get createdAt(): Date { return this.#data.createdAt; }

  async startIteration(input: IterateInput): Promise<Generation<Framework>> {
    const chatData = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!chatData) throw new NotFoundError("Chat");
    return new Chat(chatData, this.#dependencies).startFromVersion(input, this.#data);
  }

  async iterate(input: IterateInput): Promise<Version<Framework>> {
    const chatData = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!chatData) throw new NotFoundError("Chat");
    return new Chat(chatData, this.#dependencies).generateFromVersion(input, this.#data);
  }

  async apply(input: ApplySourceChangesInput): Promise<Version<Framework>> {
    if (!input) throw new ConfigurationError("A source change set is required.");
    const changes = normalizeSourceChanges(input.changes);
    const entries = applyVersionEntryChanges(await this.entries(), changes);
    const { files, artifacts } = splitVersionEntries(entries);
    const title = normalizeVersionTitle(input.title ?? this.title);
    const summary = input.summary?.trim()
      || `Applied ${changes.length} source change${changes.length === 1 ? "" : "s"}.`;
    if (summary.length > 2_000) {
      throw new ConfigurationError("A version summary cannot exceed 2,000 characters.");
    }
    const data = await this.#dependencies.repository.createSourceVersion(
      this.#dependencies.scope,
      {
        id: createId(),
        chatId: this.chatId,
        parentVersionId: this.id,
        origin: "edited",
        framework: this.framework,
        title,
        summary,
        files,
        artifacts,
        changes,
      },
    );
    return new Version(data, this.#dependencies);
  }

  async fork(input: ForkVersionInput = {}): Promise<Chat<Framework>> {
    const title = normalizeVersionTitle(input.title ?? `${this.title} fork`);
    const summary = normalizeVersionSummary(
      input.summary,
      `Forked from version ${this.number}.`,
    );
    const sourceChat = await this.#dependencies.repository.getChat<Framework>(
      this.#dependencies.scope,
      this.chatId,
    );
    if (!sourceChat) throw new NotFoundError("Chat");
    const forked = await this.#dependencies.repository.forkVersion(
      this.#dependencies.scope,
      {
        chatId: createId(),
        versionId: createId(),
        sourceVersionId: this.id,
        title,
        metadata: input.metadata === undefined
          ? sourceChat.metadata
          : normalizeChatMetadata(input.metadata),
        summary,
        framework: this.framework,
      },
    );
    return new Chat(forked.chat, this.#dependencies);
  }

  async restore(input: RestoreVersionInput = {}): Promise<Version<Framework>> {
    const title = normalizeVersionTitle(input.title ?? this.title);
    const summary = normalizeVersionSummary(
      input.summary,
      `Restored source from version ${this.number}.`,
    );
    const data = await this.#dependencies.repository.restoreVersion(
      this.#dependencies.scope,
      {
        id: createId(),
        chatId: this.chatId,
        sourceVersionId: this.id,
        title,
        summary,
        framework: this.framework,
      },
    );
    return new Version(data, this.#dependencies);
  }

  async files(): Promise<VersionFile[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.getVersionFiles(this.#dependencies.scope, this.id);
  }

  async entries(): Promise<VersionEntry[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.getVersionEntries(this.#dependencies.scope, this.id);
  }

  async projectArtifact(id: string): Promise<ProjectArtifactContent> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const artifact = await this.#dependencies.repository.getProjectArtifact(
      this.#dependencies.scope,
      this.id,
      assertIdentifier(id, "Project artifact id"),
    );
    if (!artifact) throw new NotFoundError("Project artifact");
    return artifact;
  }

  async changes(): Promise<SourceChange[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.getVersionChanges(this.#dependencies.scope, this.id);
  }

  async workspace(): Promise<AgentWorkspace<Version<Framework>>> {
    return new AgentWorkspace(
      await this.entries(),
      (changes, input: AgentWorkspaceCommitInput) => this.apply({ ...input, changes }),
    );
  }

  /** Starts a durable sandbox-backed preview for this immutable source version. */
  async preview(options: PreviewOpenOptions = {}): Promise<Preview<Framework>> {
    const resolved = this.#dependencies.previews.resolve(options);
    const data = await this.#dependencies.previews.start(
      this.#dependencies.scope,
      this.#data,
      resolved,
      () => this.sandbox(resolved.sandbox),
    );
    return new Preview(data, this.#dependencies);
  }

  /** Pushes this complete immutable source snapshot through a connected repository integration. */
  async push<PushOptions = never, PullRequestOptions = never>(
    input: PushVersionRepositoryInput<PushOptions, PullRequestOptions>,
  ): Promise<PushVersionRepositoryResult> {
    if (!input) throw new ConfigurationError("A repository push target is required.");
    const branch = typeof input.branch === "string" ? input.branch : input.branch.name;
    const context = await input.using.operationContext(input.signal);
    const idempotencyKey = input.idempotencyKey?.trim()
      ? assertIdentifier(input.idempotencyKey, "Repository push idempotency key")
      : `viby-${sha256([
          this.id,
          input.using.id,
          context.connectionId,
          input.repository.owner,
          input.repository.name,
          branch,
          input.commit.message,
          input.pullRequest?.base ?? "",
          input.pullRequest?.title ?? "",
        ].join("\0")).slice(0, 48)}`;
    const pushId = createId();
    const started = await this.#dependencies.repository.beginRepositoryPush(
      this.#dependencies.scope,
      {
        id: pushId,
        chatId: this.chatId,
        versionId: this.id,
        integrationId: input.using.id,
        connectionId: context.connectionId,
        provider: input.using.provider,
        target: { owner: input.repository.owner, name: input.repository.name },
        branch,
        commitMessage: input.commit.message,
        expectedHead: input.commit.expectedHead ?? null,
        idempotencyKey,
        now: new Date(),
      },
    );
    const replay = await storedRepositoryPushResult(
      this.#dependencies.repository,
      this.#dependencies.scope,
      started,
    );
    if (replay) return replay;
    try {
      const result = await pushVersionSource(await materializeVersionSourceFiles(
        this.#dependencies.repository,
        this.#dependencies.scope,
        this.id,
        await this.entries(),
      ), input);
      await this.#dependencies.repository.completeRepositoryPush(
        this.#dependencies.scope,
        {
          id: started.id,
          repository: result.repository,
          result: result.status === "pushed"
            ? {
                status: "pushed",
                commit: result.commit,
                changedFiles: result.changedFiles,
                pullRequest: result.pullRequest,
              }
            : { status: "conflict", actualHead: result.actualHead },
          completedAt: new Date(),
        },
      );
      return result;
    } catch (error) {
      try {
        await this.#dependencies.repository.failRepositoryPush(
          this.#dependencies.scope,
          { id: started.id, error: errorMessage(error), completedAt: new Date() },
        );
      } catch (historyError) {
        throw new AggregateError(
          [error, historyError],
          "Repository push failed and its durable history could not be updated.",
        );
      }
      throw error;
    }
  }

  async repositoryPushes(): Promise<readonly RepositoryPushData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listRepositoryPushes(
      this.#dependencies.scope,
      { chatId: this.chatId, versionId: this.id },
    );
  }

  /** Deploys this immutable source snapshot through a connected deployment integration. */
  async deploy<ProjectOptions = never, DeployOptions = never>(
    input: VersionDeployInput<ProjectOptions, DeployOptions>,
  ): Promise<DeploymentData> {
    if (!input) throw new ConfigurationError("A deployment target is required.");
    const context = await input.using.operationContext(input.signal);
    const environmentVariables = this.#dependencies.environment
      ? await this.#dependencies.environment.resolve(
          this.#dependencies.scope,
          this.chatId,
          String(input.environment),
        )
      : {};
    const runtimeInput = {
      ...input,
      environmentVariables,
      ...(input.preparation
        ? { preparation: {
            ...input.preparation,
            env: { ...environmentVariables, ...(input.preparation.env ?? {}) },
          } }
        : {}),
    };
    const idempotencyKey = input.idempotencyKey?.trim() || `viby-${sha256([
      this.id,
      input.using.id,
      context.connectionId,
      deploymentTargetIdentity(input.project),
      String(input.environment),
    ].join("\0")).slice(0, 48)}`;
    assertIdentifier(idempotencyKey, "Deployment idempotency key");
    const started = await this.#dependencies.repository.beginDeployment(
      this.#dependencies.scope,
      {
        id: createId(),
        chatId: this.chatId,
        versionId: this.id,
        integrationId: input.using.id,
        connectionId: context.connectionId,
        provider: input.using.provider,
        projectTarget: deploymentTargetIdentity(input.project),
        environment: assertIdentifier(String(input.environment), "Deployment environment"),
        idempotencyKey,
        now: new Date(),
      },
    );
    const replay = await storedDeploymentResult(
      this.#dependencies.repository,
      this.#dependencies.scope,
      started,
    );
    if (replay) return replay;
    try {
      const sourceFiles = input.using.sourceMode === "prebuilt"
        ? await this.#preparedDeploymentFiles(started, runtimeInput)
        : await materializeVersionSourceFiles(
            this.#dependencies.repository,
            this.#dependencies.scope,
            this.id,
            await this.entries(),
          );
      const deployment = await deployVersionSource(sourceFiles, { ...runtimeInput, idempotencyKey });
      const project = await input.using.projects.get({ id: deployment.projectId }, input.signal);
      if (!project) throw new NotFoundError("Deployed project");
      await this.#dependencies.repository.completeDeployment(
        this.#dependencies.scope,
        { id: started.id, project, deployment, observedAt: new Date() },
      );
      return deployment;
    } catch (error) {
      try {
        await this.#dependencies.repository.failDeployment(
          this.#dependencies.scope,
          { id: started.id, error: errorMessage(error), observedAt: new Date() },
        );
      } catch (historyError) {
        throw new AggregateError(
          [error, historyError],
          "Deployment failed and its durable history could not be updated.",
        );
      }
      throw error;
    }
  }

  async deployments(): Promise<readonly DeploymentRecordData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listDeployments(
      this.#dependencies.scope,
      { chatId: this.chatId, versionId: this.id },
    );
  }

  async deploymentArtifact(deploymentId: string): Promise<DeploymentArtifactContent | null> {
    const id = assertIdentifier(deploymentId, "Deployment id");
    const deployment = (await this.deployments()).find((candidate) => candidate.id === id);
    if (!deployment) throw new NotFoundError("Deployment");
    if (!deployment.preparationArtifactId) return null;
    const artifact = await this.#dependencies.repository.getDeploymentArtifact(
      this.#dependencies.scope,
      deployment.id,
      deployment.preparationArtifactId,
    );
    if (!artifact) throw new NotFoundError("Deployment artifact");
    return artifact;
  }

  async #preparedDeploymentFiles<ProjectOptions, DeployOptions>(
    deployment: DeploymentRecordData,
    input: VersionDeployInput<ProjectOptions, DeployOptions>,
  ): Promise<readonly IntegrationSourceFile[]> {
    if (deployment.preparationArtifactId) {
      const artifact = await this.#dependencies.repository.getDeploymentArtifact(
        this.#dependencies.scope,
        deployment.id,
        deployment.preparationArtifactId,
      );
      if (!artifact) throw new NotFoundError("Deployment artifact");
      return deploymentFilesFromArtifact(artifact);
    }
    const config = this.#dependencies.deploymentPreparation;
    if (!config) {
      throw new ConfigurationError(
        `${input.using.displayName} requires prebuilt files. Configure deployment.preparation with the framework build command.`,
      );
    }
    const sandbox = await this.sandbox({
      environment: String(input.environment),
      ...(input.preparation?.env ? { env: input.preparation.env } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    try {
      const prepared = await prepareDeploymentSource(
        sandbox,
        config,
        input.using.outputDirectory,
        input.preparation,
        input.signal,
      );
      await this.#dependencies.repository.createDeploymentArtifact(
        this.#dependencies.scope,
        {
          id: createId(),
          chatId: this.chatId,
          versionId: this.id,
          deploymentId: deployment.id,
          framework: this.framework,
          sandboxProvider: sandbox.provider,
          outputDirectory: prepared.outputDirectory,
          commands: prepared.commands,
          fileCount: prepared.files.length,
          bytes: prepared.archive,
          size: prepared.archive.byteLength,
          checksum: sha256(prepared.archive),
        },
      );
      return prepared.files;
    } finally {
      await sandbox.stop();
    }
  }

  async sandbox(options: SandboxOpenOptions = {}): Promise<SandboxSession> {
    const resolved = options.environment && this.#dependencies.environment
      ? await this.#dependencies.environment.resolve(
          this.#dependencies.scope,
          this.chatId,
          options.environment,
        )
      : {};
    return this.#dependencies.sandboxes.open(
      this.#dependencies.sandbox,
      this.#dependencies.scope,
      this.#data,
      await materializeVersionEntries(
        this.#dependencies.repository,
        this.#dependencies.scope,
        this.id,
        await this.entries(),
      ),
      { ...options, env: { ...resolved, ...(options.env ?? {}) } },
    );
  }

  async generation(): Promise<GenerationData | null> {
    await assertActiveChat(this.#dependencies, this.chatId);
    if (!this.generationId) return null;
    const generation = await this.#dependencies.repository.getGeneration(
      this.#dependencies.scope,
      this.generationId,
    );
    if (!generation) throw new NotFoundError("Generation");
    return generation;
  }

  async recordDesignEvaluation(
    input: RecordDesignEvaluationInput,
  ): Promise<DesignEvaluationData> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const evaluation = normalizeDesignEvaluation(input);
    await this.#validateDesignEvaluationEvidence([
      ...evaluation.evidence,
      ...evaluation.criteria.flatMap((criterion) => criterion.evidence ?? []),
    ]);
    return this.#dependencies.repository.createDesignEvaluation(
      this.#dependencies.scope,
      {
        id: createId(),
        chatId: this.chatId,
        versionId: this.id,
        generationId: this.generationId,
        ...evaluation,
      },
    );
  }

  async getDesignEvaluation(id: string): Promise<DesignEvaluationData> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const evaluation = await this.#dependencies.repository.getDesignEvaluation(
      this.#dependencies.scope,
      this.id,
      assertIdentifier(id, "design evaluation id"),
    );
    if (!evaluation) throw new NotFoundError("Design evaluation");
    return evaluation;
  }

  async listDesignEvaluations(
    options: PageOptions = {},
  ): Promise<CursorPage<DesignEvaluationData>> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const limit = normalizePageLimit(options.limit);
    const page = await this.#dependencies.repository.listDesignEvaluationPage(
      this.#dependencies.scope,
      this.id,
      limit,
      decodeDesignEvaluationCursor(options.after),
    );
    const last = page.items.at(-1);
    return {
      items: page.items,
      nextCursor: page.hasMore && last
        ? encodeDesignEvaluationCursor({ createdAt: last.createdAt, id: last.id })
        : null,
    };
  }

  async evaluateVisual(
    input: VisualEvaluationInput<Framework>,
  ): Promise<VisualEvaluationResult> {
    if (!this.#dependencies.browser) {
      throw new ConfigurationError(
        "A browser adapter must be configured to run visual evaluations.",
      );
    }
    await assertActiveChat(this.#dependencies, this.chatId);
    return runVisualEvaluation(input, {
      browser: this.#dependencies.browser,
      repository: this.#dependencies.repository,
      scope: this.#dependencies.scope,
      version: this.#data,
      record: (evaluation) => this.recordDesignEvaluation(evaluation),
    });
  }

  async visualArtifacts(): Promise<VisualArtifactData[]> {
    await assertActiveChat(this.#dependencies, this.chatId);
    return this.#dependencies.repository.listVisualArtifacts(
      this.#dependencies.scope,
      this.id,
    );
  }

  async getVisualArtifact(id: string): Promise<VisualArtifactContent> {
    await assertActiveChat(this.#dependencies, this.chatId);
    const artifact = await this.#dependencies.repository.getVisualArtifact(
      this.#dependencies.scope,
      this.id,
      assertIdentifier(id, "visual artifact id"),
    );
    if (!artifact) throw new NotFoundError("Visual artifact");
    return artifact;
  }

  async #validateDesignEvaluationEvidence(
    evidence: readonly DesignEvaluationEvidence[],
  ): Promise<void> {
    const filePaths = new Set(evidence.flatMap((item) => (
      item.type === "version-file" ? [item.path] : []
    )));
    if (filePaths.size > 0) {
      const existing = new Set((await this.files()).map((file) => file.path));
      for (const path of filePaths) {
        if (!existing.has(path)) throw new NotFoundError("Design evaluation version file");
      }
    }
    const attachmentIds = new Set(evidence.flatMap((item) => (
      item.type === "attachment" ? [item.attachmentId] : []
    )));
    await Promise.all([...attachmentIds].map(async (id) => {
      const attachment = await this.#dependencies.repository.getAttachment(
        this.#dependencies.scope,
        this.chatId,
        id,
      );
      if (!attachment) throw new NotFoundError("Design evaluation attachment");
    }));
    const artifactIds = new Set(evidence.flatMap((item) => (
      item.type === "artifact" ? [item.artifactId] : []
    )));
    await Promise.all([...artifactIds].map(async (id) => {
      const artifact = await this.#dependencies.repository.getVisualArtifact(
        this.#dependencies.scope,
        this.id,
        id,
      );
      if (!artifact) throw new NotFoundError("Design evaluation artifact");
    }));
  }

  async download(): Promise<DownloadArtifact> {
    return createSourceDownload(
      this.title,
      await materializeVersionEntries(
        this.#dependencies.repository,
        this.#dependencies.scope,
        this.id,
        await this.entries(),
      ),
    );
  }
}

function splitVersionEntries(entries: readonly VersionEntry[]): {
  files: VersionFile[];
  artifacts: VersionArtifact[];
} {
  return {
    files: entries
      .filter((entry) => entry.type === "text")
      .map(({ type: _type, ...file }) => file),
    artifacts: entries.filter((entry): entry is VersionArtifact => entry.type === "artifact"),
  };
}

async function storedRepositoryPushResult(
  repository: Repository,
  scope: UserScope,
  push: RepositoryPushData,
): Promise<PushVersionRepositoryResult | null> {
  if (push.status !== "pushed" && push.status !== "conflict") return null;
  if (!push.repositoryLinkId) {
    throw new Error(`Completed repository push ${push.id} has no repository link.`);
  }
  const link = (await repository.listRepositoryLinks(scope, push.chatId))
    .find((candidate) => candidate.id === push.repositoryLinkId);
  if (!link) throw new Error(`Repository link ${push.repositoryLinkId} is unavailable.`);
  const remote = {
    id: link.repositoryId,
    owner: link.owner,
    name: link.name,
    defaultBranch: link.defaultBranch,
    visibility: link.visibility,
    url: link.url,
  };
  if (push.status === "conflict") {
    if (push.actualHead === null) throw new Error(`Repository conflict ${push.id} has no actual head.`);
    return {
      status: "conflict",
      repository: remote,
      expectedHead: push.expectedHead,
      actualHead: push.actualHead,
    };
  }
  if (!push.commit || push.changedFiles === null) {
    throw new Error(`Completed repository push ${push.id} has no commit result.`);
  }
  return {
    status: "pushed",
    repository: remote,
    commit: push.commit,
    changedFiles: push.changedFiles,
    pullRequest: push.pullRequest,
  };
}

async function storedDeploymentResult(
  repository: Repository,
  scope: UserScope,
  deployment: DeploymentRecordData,
): Promise<DeploymentData | null> {
  if (deployment.status === "pending" || deployment.status === "failed") return null;
  if (!deployment.providerDeploymentId || !deployment.providerCreatedAt || !deployment.projectLinkId) {
    throw new Error(`Completed deployment ${deployment.id} has no provider identity.`);
  }
  const project = (await repository.listDeploymentProjects(scope, deployment.chatId))
    .find((candidate) => candidate.id === deployment.projectLinkId);
  if (!project) throw new Error(`Deployment project link ${deployment.projectLinkId} is unavailable.`);
  return {
    id: deployment.providerDeploymentId,
    projectId: project.providerProjectId,
    environment: deployment.environment,
    status: deployment.status,
    url: deployment.url,
    createdAt: deployment.providerCreatedAt,
  };
}

async function materializeVersionEntries(
  repository: Repository,
  scope: UserScope,
  versionId: string,
  entries: readonly VersionEntry[],
): Promise<SandboxFile[]> {
  return Promise.all(entries.map(async (entry) => {
    if (entry.type !== "artifact") return { path: entry.path, content: entry.content };
    const artifact = await repository.getProjectArtifact(scope, versionId, entry.artifactId);
    if (!artifact) throw new NotFoundError("Project artifact");
    return { path: entry.path, content: artifact.bytes };
  }));
}

async function materializeCandidateEntries(
  repository: Repository,
  scope: UserScope,
  baseVersionId: string | null,
  entries: readonly VersionEntry[],
): Promise<SandboxFile[]> {
  return Promise.all(entries.map(async (entry) => {
    if (entry.type !== "artifact") return { path: entry.path, content: entry.content };
    if (!baseVersionId) {
      throw new ConfigurationError(
        `Generated source artifact ${entry.path} has no immutable base version.`,
      );
    }
    const artifact = await repository.getProjectArtifact(scope, baseVersionId, entry.artifactId);
    if (!artifact) throw new NotFoundError("Project artifact");
    return { path: entry.path, content: artifact.bytes };
  }));
}

async function materializeVersionSourceFiles(
  repository: Repository,
  scope: UserScope,
  versionId: string,
  entries: readonly VersionEntry[],
): Promise<IntegrationSourceFile[]> {
  const materialized = await materializeVersionEntries(repository, scope, versionId, entries);
  const mediaTypes = new Map(entries.map((entry) => [entry.path, entry.mediaType]));
  return materialized.map((file) => {
    const mediaType = mediaTypes.get(file.path);
    return {
      path: file.path,
      content: typeof file.content === "string"
        ? new TextEncoder().encode(file.content)
        : new Uint8Array(file.content),
      ...(mediaType ? { mediaType } : {}),
    };
  });
}

async function assertActiveChat<Framework extends FrameworkId>(
  dependencies: ScopedDependencies<Framework>,
  chatId: string,
): Promise<void> {
  const chat = await dependencies.repository.getChat(dependencies.scope, chatId);
  if (!chat) throw new NotFoundError("Chat");
}

function normalizeChatTitle(value: string | undefined): string {
  const title = value?.trim() || "Untitled";
  if (title.length > 200) {
    throw new ConfigurationError("A chat title cannot exceed 200 characters.");
  }
  return title;
}

function normalizePageLimit(value: number | undefined): number {
  const limit = value ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new ConfigurationError("Page limit must be an integer between 1 and 100.");
  }
  return limit;
}

function normalizeVersionTitle(value: string): string {
  const title = value.trim();
  if (title.length === 0 || title.length > 120) {
    throw new ConfigurationError("A version title must contain between 1 and 120 characters.");
  }
  return title;
}

function normalizeVersionSummary(value: string | undefined, fallback: string): string {
  const summary = value?.trim() || fallback;
  if (summary.length > 2_000) {
    throw new ConfigurationError("A version summary cannot exceed 2,000 characters.");
  }
  return summary;
}

function languageModelIdentity(model: LanguageModel): { provider: string; id: string } {
  if (typeof model === "string") {
    return { provider: model.split("/", 1)[0] || "gateway", id: model };
  }
  return { provider: model.provider, id: model.modelId };
}

function assertModelAlias(value: string): string {
  const alias = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(alias)) {
    throw new ConfigurationError(
      "Generation model aliases must contain 1-100 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  return alias;
}

function normalizeSkillGroups(value: SkillGroups | undefined): SkillGroups {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("Generation skills must be a categorized object.");
  }
  const groups: Record<string, SkillGroups[string]> = {};
  for (const [category, references] of Object.entries(value)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(category)) {
      throw new ConfigurationError(`Generation skill category is invalid: ${category}`);
    }
    if (!Array.isArray(references)) {
      throw new ConfigurationError(`Generation skill category ${category} must be an array.`);
    }
    groups[category] = references.map((reference) => {
      if (typeof reference === "string") return reference as SkillReference;
      if (!reference || typeof reference !== "object") {
        throw new ConfigurationError(`Generation skill reference in ${category} is invalid.`);
      }
      if (reference.source === "file" && typeof reference.path === "string" && reference.path.trim()) {
        return { source: "file", path: reference.path } as const;
      }
      if (
        reference.source === "inline"
        && typeof reference.name === "string"
        && reference.name.trim()
        && (reference.description === undefined || typeof reference.description === "string")
        && Array.isArray(reference.files)
      ) {
        return {
          source: "inline",
          name: reference.name,
          ...(reference.description === undefined ? {} : { description: reference.description }),
          files: reference.files.map((file: unknown) => {
            if (
              !file
              || typeof file !== "object"
              || !("path" in file)
              || typeof file.path !== "string"
              || !("content" in file)
              || typeof file.content !== "string"
            ) {
              throw new ConfigurationError(`Inline skill file in ${category} is invalid.`);
            }
            return { path: file.path, content: file.content };
          }),
        } as const;
      }
      if (
        reference.source === "resolver"
        && typeof reference.resolver === "string"
        && reference.resolver.trim()
        && typeof reference.locator === "string"
        && reference.locator.trim()
      ) {
        return {
          source: "resolver",
          resolver: reference.resolver,
          locator: reference.locator,
          ...(reference.metadata === undefined
            ? {}
            : { metadata: normalizeChatMetadata(reference.metadata) }),
        } as const;
      }
      throw new ConfigurationError(`Generation skill reference in ${category} is invalid.`);
    });
  }
  return groups;
}

function normalizeAttachments(
  value: GenerateInput["attachments"],
): readonly CreateAttachmentRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GENERATION_ATTACHMENTS) {
    throw new ConfigurationError(
      `Generation attachments must be an array with at most ${MAX_GENERATION_ATTACHMENTS} items.`,
    );
  }
  let totalBytes = 0;
  return value.map((attachment) => {
    if (!attachment || typeof attachment !== "object") {
      throw new ConfigurationError("Each generation attachment must be an object.");
    }
    const filename = attachment.filename.trim();
    if (
      filename.length === 0
      || filename.length > 255
      || filename === "."
      || filename === ".."
      || /[\\/\u0000-\u001f\u007f]/.test(filename)
    ) {
      throw new ConfigurationError(`Attachment filename is invalid: ${attachment.filename}`);
    }
    const mediaType = attachment.mediaType.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mediaType)) {
      throw new ConfigurationError(`Attachment media type is invalid: ${attachment.mediaType}`);
    }
    if (!(attachment.bytes instanceof Uint8Array)) {
      throw new ConfigurationError(`Attachment ${filename} bytes must be a Uint8Array.`);
    }
    if (attachment.bytes.byteLength === 0 || attachment.bytes.byteLength > MAX_ATTACHMENT_BYTES) {
      throw new ConfigurationError(
        `Attachment ${filename} must contain 1-${MAX_ATTACHMENT_BYTES} bytes.`,
      );
    }
    totalBytes += attachment.bytes.byteLength;
    if (totalBytes > MAX_GENERATION_ATTACHMENT_BYTES) {
      throw new ConfigurationError(
        `Generation attachments cannot exceed ${MAX_GENERATION_ATTACHMENT_BYTES} total bytes.`,
      );
    }
    const bytes = Uint8Array.from(attachment.bytes);
    return {
      id: createId(),
      filename,
      mediaType,
      bytes,
      size: bytes.byteLength,
      checksum: sha256(bytes),
    };
  });
}

function normalizeGeneratedArtifacts(
  value: GeneratorOutput["artifacts"],
): readonly CreateGeneratedArtifactRecord[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_GENERATED_ARTIFACTS) {
    throw new ConfigurationError(
      `Generated artifacts must be an array with at most ${MAX_GENERATED_ARTIFACTS} items.`,
    );
  }
  let totalBytes = 0;
  return value.map((artifact, position) => {
    if (!artifact || typeof artifact !== "object") {
      throw new ConfigurationError("Each generated artifact must be an object.");
    }
    const filename = artifact.filename.trim();
    if (
      filename.length === 0
      || filename.length > 255
      || filename === "."
      || filename === ".."
      || /[\\/\u0000-\u001f\u007f]/.test(filename)
    ) {
      throw new ConfigurationError(`Generated artifact filename is invalid: ${artifact.filename}`);
    }
    const mediaType = artifact.mediaType.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/.test(mediaType)) {
      throw new ConfigurationError(`Generated artifact media type is invalid: ${artifact.mediaType}`);
    }
    if (!(artifact.bytes instanceof Uint8Array)) {
      throw new ConfigurationError(`Generated artifact ${filename} bytes must be a Uint8Array.`);
    }
    if (
      artifact.bytes.byteLength === 0
      || artifact.bytes.byteLength > MAX_GENERATED_ARTIFACT_BYTES
    ) {
      throw new ConfigurationError(
        `Generated artifact ${filename} must contain 1-${MAX_GENERATED_ARTIFACT_BYTES} bytes.`,
      );
    }
    totalBytes += artifact.bytes.byteLength;
    if (totalBytes > MAX_GENERATED_ARTIFACT_TOTAL_BYTES) {
      throw new ConfigurationError(
        `Generated artifacts cannot exceed ${MAX_GENERATED_ARTIFACT_TOTAL_BYTES} total bytes.`,
      );
    }
    const bytes = Uint8Array.from(artifact.bytes);
    return {
      id: createId(),
      position,
      kind: normalizeGeneratedArtifactKind(artifact.kind, mediaType),
      filename,
      mediaType,
      bytes,
      size: bytes.byteLength,
      checksum: sha256(bytes),
    };
  });
}

function normalizeGeneratedArtifactKind(
  value: GeneratedArtifactKind | undefined,
  mediaType: string,
): GeneratedArtifactKind {
  const inferred = mediaType.startsWith("image/")
    ? "image"
    : mediaType.startsWith("audio/")
      ? "audio"
      : mediaType.startsWith("video/")
        ? "video"
        : mediaType.startsWith("text/")
          || mediaType === "application/pdf"
          || mediaType.includes("document")
          || mediaType.includes("json")
          ? "document"
          : "binary";
  if (value === undefined) return inferred;
  if (!["image", "audio", "video", "document", "binary"].includes(value)) {
    throw new ConfigurationError(`Generated artifact kind is invalid: ${value}`);
  }
  return value;
}

function normalizeGenerationConfiguration<Framework extends FrameworkId>(
  input: GenerateInput,
  defaults: SkillGroups,
  models: GenerationModelRegistry<Framework>,
): { configuration: GenerationConfigurationData; model: GenerationModelBinding<Framework> } {
  const model = models.resolve(input.model);
  const instructions = input.instructions?.trim() || null;
  if (instructions && instructions.length > 50_000) {
    throw new ConfigurationError("Generation instructions cannot exceed 50,000 characters.");
  }
  const skills = {
    ...defaults,
    ...normalizeSkillGroups(input.skills),
  };
  return {
    model,
    configuration: {
      model: model.alias,
      instructions,
      skills,
      metadata: normalizeChatMetadata(input.metadata),
    },
  };
}

interface RunnerDependencies<Framework extends FrameworkId> {
  readonly framework: Framework;
  readonly repository: Repository;
  readonly models: GenerationModelRegistry<Framework>;
  readonly skillResolver: SkillResolver;
  readonly registry: GenerationRunRegistry;
  readonly automatic: boolean;
  readonly sandbox: SandboxAdapter | undefined;
  readonly sandboxPolicy: VibyConfig<Framework>["sandboxPolicy"];
  readonly sandboxes: SandboxRegistry;
  readonly quality: NormalizedGenerationQualityConfig | undefined;
  readonly agent: ReturnType<typeof normalizeAgentRunnerConfig>;
  readonly telemetry: VibyTelemetry | undefined;
  readonly cost: NormalizedGenerationCostConfig | undefined;
}

interface NormalizedGenerationCostConfig {
  readonly currency: string;
  readonly calculate: GenerationCostConfig["calculate"];
}

class GenerationRunner<Framework extends FrameworkId> {
  readonly #dependencies: RunnerDependencies<Framework>;
  readonly #embeddedWorkerId = `embedded-${createId()}`;

  constructor(dependencies: RunnerDependencies<Framework>) {
    this.#dependencies = dependencies;
  }

  schedule(scope: UserScope, generationId: string, attemptId: string): void {
    if (!this.#dependencies.automatic) return;
    void this.#dependencies.registry.start(
      generationId,
      async (signal) => {
        const lease = await this.#claim({
          id: this.#embeddedWorkerId,
          concurrency: 1,
          leaseMs: DEFAULT_WORKER_LEASE_MS,
          heartbeatMs: DEFAULT_WORKER_HEARTBEAT_MS,
          pollIntervalMs: DEFAULT_WORKER_POLL_INTERVAL_MS,
        }, attemptId);
        if (!lease || lease.scope.tenantId !== scope.tenantId || lease.scope.userId !== scope.userId) {
          return;
        }
        await this.#executeWithHeartbeat(lease, DEFAULT_WORKER_LEASE_MS, DEFAULT_WORKER_HEARTBEAT_MS, signal, true);
      },
    ).catch(() => undefined);
  }

  async runNext(options: NormalizedGenerationWorkerOptions, signal: AbortSignal): Promise<boolean> {
    const lease = await this.#claim(options);
    if (!lease) return false;
    await this.#dependencies.registry.start(
      lease.generationId,
      (runSignal) => this.#executeWithHeartbeat(
        lease,
        options.leaseMs,
        options.heartbeatMs,
        combineAbortSignals(runSignal, signal),
        false,
      ),
    );
    return true;
  }

  #claim(
    options: NormalizedGenerationWorkerOptions,
    attemptId?: string,
  ): Promise<GenerationWorkerLease | null> {
    return this.#dependencies.repository.claimGenerationAttempt({
      workerId: options.id,
      leaseToken: createId(),
      leaseMs: options.leaseMs,
      framework: this.#dependencies.framework,
      modelProvider: this.#dependencies.models.identities[0]!.provider,
      modelId: this.#dependencies.models.identities[0]!.id,
      models: this.#dependencies.models.identities,
      ...(attemptId ? { attemptId } : {}),
    });
  }

  async #executeWithHeartbeat(
    lease: GenerationWorkerLease,
    leaseMs: number,
    heartbeatMs: number,
    signal: AbortSignal,
    cancelOnAbort: boolean,
  ): Promise<void> {
    const controller = new AbortController();
    const forwardAbort = () => controller.abort(signal.reason);
    if (signal.aborted) forwardAbort();
    else signal.addEventListener("abort", forwardAbort, { once: true });
    const heartbeat = this.#heartbeat(lease, leaseMs, heartbeatMs, controller);
    try {
      await this.#execute(lease, controller.signal, cancelOnAbort);
    } finally {
      if (!controller.signal.aborted) {
        controller.abort(new DOMException("Generation attempt completed.", "AbortError"));
      }
      signal.removeEventListener("abort", forwardAbort);
      await heartbeat;
    }
  }

  async #heartbeat(
    lease: GenerationWorkerLease,
    leaseMs: number,
    heartbeatMs: number,
    controller: AbortController,
  ): Promise<void> {
    try {
      while (!controller.signal.aborted) {
        await waitForPoll(heartbeatMs, controller.signal);
        const renewed = await this.#dependencies.repository.heartbeatGenerationAttempt(
          lease,
          leaseMs,
        );
        if (!renewed) {
          throw new GenerationWorkerLeaseLostError(lease.generationId, lease.attemptId);
        }
      }
    } catch (error) {
      if (!controller.signal.aborted) {
        controller.abort(error instanceof GenerationWorkerLeaseLostError
          ? error
          : new GenerationWorkerLeaseLostError(lease.generationId, lease.attemptId));
      }
    }
  }

  async #execute(
    lease: GenerationWorkerLease,
    signal: AbortSignal,
    cancelOnAbort: boolean,
  ): Promise<void> {
    const { scope, generationId, attemptId, leaseToken } = lease;
    const telemetryStartedAt = performance.now();
    let telemetrySpan: TelemetrySpan | undefined;
    let telemetryAttributes: TelemetryAttributes = {
      "viby.tenant.id": scope.tenantId,
      "viby.user.id": scope.userId,
      "viby.generation.id": generationId,
      "viby.attempt.id": attemptId,
    };
    let telemetryOutcome = "failed";
    let sandbox: SandboxSession | undefined;
    const trace = new DurableAgentTrace(async (type, data) => {
      signal.throwIfAborted();
      await this.#dependencies.repository.appendGenerationEvent(scope, {
        generationId,
        attemptId,
        leaseToken,
        type,
        data,
      });
    });
    const toolCalls = new DurableAgentToolCalls(
      this.#dependencies.repository,
      scope,
      generationId,
      attemptId,
      leaseToken,
      trace,
    );
    try {
      signal.throwIfAborted();

      const generation = await this.#dependencies.repository.getGeneration(scope, generationId);
      if (!generation) throw new NotFoundError("Generation");
      const chat = await this.#dependencies.repository.getChat<Framework>(scope, generation.chatId);
      if (!chat) throw new NotFoundError("Chat");
      telemetryAttributes = {
        ...telemetryAttributes,
        "viby.chat.id": chat.id,
        "viby.framework": chat.framework,
        "gen_ai.provider.name": generation.modelProvider,
        "gen_ai.request.model": generation.modelId,
      };
      telemetrySpan = safeStartSpan(this.#dependencies.telemetry, {
        name: "viby.generation.attempt",
        attributes: telemetryAttributes,
      });
      safeRecordMetric(this.#dependencies.telemetry, {
        name: "viby.generation.attempts",
        kind: "counter",
        value: 1,
        unit: "{attempt}",
        attributes: metricAttributes(telemetryAttributes, "started"),
      });

      let skills = await this.#dependencies.repository.getGenerationSkills(scope, generationId);
      if (skills === null) {
        skills = await this.#dependencies.skillResolver.resolveForPrompt(
          generation.prompt,
          generation.configuration.skills,
        );
        await this.#dependencies.repository.attachGenerationSkills(
          scope,
          generationId,
          attemptId,
          leaseToken,
          skills,
        );
      }

      const [messages, previousEntries, tasks, attachments] = await Promise.all([
        this.#dependencies.repository.listMessages(scope, generation.chatId),
        generation.baseVersionId
          ? this.#dependencies.repository.getVersionEntries(scope, generation.baseVersionId)
          : Promise.resolve([]),
        this.#dependencies.repository.listGenerationTasks(scope, generationId),
        this.#dependencies.repository.listGenerationAttachments(scope, generationId),
      ]);
      const previousFiles = previousEntries
        .filter((entry) => entry.type === "text")
        .map(({ type: _type, ...file }) => file);
      signal.throwIfAborted();
      if (generation.baseVersionId && this.#dependencies.sandbox) {
        sandbox = await this.#dependencies.sandboxes.open(
          this.#dependencies.sandbox,
          scope,
          {
            id: generation.baseVersionId,
            chatId: generation.chatId,
            framework: chat.framework,
          },
          await materializeVersionEntries(
            this.#dependencies.repository,
            scope,
            generation.baseVersionId,
            previousEntries,
          ),
          {
            timeoutMs: this.#dependencies.agent.maxDurationMs,
            ports: this.#dependencies.agent.sandboxPorts,
            signal,
          },
          {
            approvedActionKeys: tasks.flatMap((task) => (
              task.kind === "permission"
              && task.status === "resolved"
              && task.resolution?.kind === "permission"
              && task.resolution.decision === "allow"
              && task.proposedAction
                ? [task.proposedAction.idempotencyKey]
                : []
            )),
            deniedActionKeys: tasks.flatMap((task) => (
              task.kind === "permission"
              && task.status === "resolved"
              && task.resolution?.kind === "permission"
              && task.resolution.decision === "deny"
              && task.proposedAction
                ? [task.proposedAction.idempotencyKey]
                : []
            )),
          },
        );
      }

      const output = await this.#dependencies.models.resolveGeneration(generation).generator.generate(
        {
          framework: chat.framework,
          prompt: generation.prompt,
          instructions: generation.configuration.instructions,
          metadata: generation.configuration.metadata,
          messages: messages.filter((message) => message.generationId !== generationId),
          previousFiles,
          previousEntries,
          skills,
          tasks,
          attachments,
          toolContext: {
            ...scope,
            chatId: chat.id,
            generationId,
            attemptId,
            framework: chat.framework,
            metadata: chat.metadata,
            ...(generation.configuration.toolSources === undefined
              ? {}
              : { toolSourceSnapshots: generation.configuration.toolSources }),
            signal,
          },
          ...(sandbox ? { sandbox } : {}),
        },
        {
          signal,
          trace,
          toolCalls,
          onDelta: async (delta) => {
            signal.throwIfAborted();
            await this.#dependencies.repository.appendGenerationEvent(scope, {
              generationId,
              attemptId,
              leaseToken,
              type: "output.delta",
              data: { delta },
            });
          },
        },
      );
      signal.throwIfAborted();
      await trace.finish();
      const artifacts = normalizeGeneratedArtifacts(output.artifacts);

      if (output.kind === "task") {
        const inputTokens = output.usage.inputTokens ?? null;
        const outputTokens = output.usage.outputTokens ?? null;
        const totalTokens = output.usage.totalTokens ?? null;
        const cost = await calculateGenerationCost(this.#dependencies.cost, {
          ...scope,
          chatId: chat.id,
          generationId,
          attemptId,
          modelProvider: generation.modelProvider,
          modelId: generation.modelId,
          inputTokens,
          outputTokens,
          totalTokens,
        }, this.#dependencies.telemetry, telemetrySpan, telemetryAttributes);
        await this.#dependencies.repository.pauseGeneration(scope, {
          generationId,
          attemptId,
          leaseToken,
          taskId: createId(),
          task: output.task,
          assistantParts: [
            ...trace.completedParts(),
            { type: "status", data: { message: output.task.message, state: "waiting" } },
            { type: "text", data: { text: output.task.message } },
            usageMessagePart(inputTokens, outputTokens, totalTokens, cost),
          ],
          inputTokens,
          outputTokens,
          totalTokens,
          finishReason: output.finishReason,
          cost,
          artifacts,
        });
        telemetryOutcome = "waiting";
        recordGenerationUsage(
          this.#dependencies.telemetry,
          telemetrySpan,
          telemetryAttributes,
          telemetryOutcome,
          inputTokens,
          outputTokens,
          totalTokens,
          cost,
        );
        safeSetSpanStatus(telemetrySpan, "ok");
        return;
      }

      const entries = output.kind === "changes"
        ? applyVersionEntryChanges(previousEntries, output.changes)
        : mergeGeneratedFilesWithArtifacts(previousEntries, output.files);
      if (this.#dependencies.quality) {
        await verifyGenerationQuality({
          config: this.#dependencies.quality,
          adapter: this.#dependencies.sandbox!,
          ...(this.#dependencies.sandboxPolicy
            ? { policy: this.#dependencies.sandboxPolicy }
            : {}),
          scope,
          chatId: chat.id,
          framework: chat.framework,
          files: await materializeCandidateEntries(
            this.#dependencies.repository,
            scope,
            generation.baseVersionId,
            entries,
          ),
          signal,
          onEvent: async (event) => {
            if (event.type === "quality.started") {
              await this.#dependencies.repository.appendGenerationEvent(scope, {
                generationId,
                attemptId,
                leaseToken,
                type: event.type,
                data: event.data,
              });
              return;
            }
            await this.#dependencies.repository.appendGenerationEvent(scope, {
              generationId,
              attemptId,
              leaseToken,
              type: event.type,
              data: event.data,
            });
          },
        });
      }
      const { files, artifacts: projectArtifacts } = splitVersionEntries(entries);
      const changes = output.kind === "changes" ? output.changes : null;
      const inputTokens = output.usage.inputTokens ?? null;
      const outputTokens = output.usage.outputTokens ?? null;
      const totalTokens = output.usage.totalTokens ?? null;
      const cost = await calculateGenerationCost(this.#dependencies.cost, {
        ...scope,
        chatId: chat.id,
        generationId,
        attemptId,
        modelProvider: generation.modelProvider,
        modelId: generation.modelId,
        inputTokens,
        outputTokens,
        totalTokens,
      }, this.#dependencies.telemetry, telemetrySpan, telemetryAttributes);
      await this.#dependencies.repository.completeGeneration(scope, {
        generationId,
        attemptId,
        leaseToken,
        parentVersionId: generation.baseVersionId,
        framework: chat.framework,
        title: output.title,
        summary: output.summary,
        files,
        projectArtifacts,
        changes,
        assistantMessage: output.summary,
        assistantParts: [
          ...mergeTraceAndFileEditParts(trace.completedParts(), files, changes),
          { type: "text", data: { text: output.summary } },
          usageMessagePart(inputTokens, outputTokens, totalTokens, cost),
        ],
        inputTokens,
        outputTokens,
        totalTokens,
        finishReason: output.finishReason,
        cost,
        artifacts,
      });
      telemetryOutcome = "succeeded";
      recordGenerationUsage(
        this.#dependencies.telemetry,
        telemetrySpan,
        telemetryAttributes,
        telemetryOutcome,
        inputTokens,
        outputTokens,
        totalTokens,
        cost,
      );
      safeSetSpanStatus(telemetrySpan, "ok");
    } catch (error) {
      telemetryOutcome = signal.aborted || isAbortError(error) ? "cancelled" : "failed";
      safeRecordException(telemetrySpan, error);
      safeSetSpanStatus(telemetrySpan, "error", errorMessage(error));
      await trace.failOpen({
        message: errorMessage(error),
        code: "generation_failed",
        retryable: true,
      }).catch(() => undefined);
      if (signal.aborted || isAbortError(error)) {
        if (!cancelOnAbort || signal.reason instanceof GenerationWorkerLeaseLostError) return;
        await this.#dependencies.repository.cancelGeneration(
          scope,
          generationId,
          errorMessage(signal.reason ?? error),
        ).catch(() => false);
        return;
      }
      if (error instanceof GenerationStateError) return;
      await this.#dependencies.repository.failGenerationAttempt(
        scope,
        generationId,
        attemptId,
        leaseToken,
        errorMessage(error),
      ).catch(() => undefined);
    } finally {
      await sandbox?.stop().catch(() => undefined);
      safeRecordMetric(this.#dependencies.telemetry, {
        name: "viby.generation.duration",
        kind: "histogram",
        value: Math.max(0, performance.now() - telemetryStartedAt),
        unit: "ms",
        attributes: metricAttributes(telemetryAttributes, telemetryOutcome),
      });
      safeEndSpan(telemetrySpan);
    }
  }
}

type AgentPartEventType = Extract<GenerationEventType, `part.${string}`>;
type AgentPartEventAppend = <Type extends AgentPartEventType>(
  type: Type,
  data: GenerationEventDataMap[Type],
) => Promise<void>;

interface TraceEntry<Type extends MessagePartType = MessagePartType> {
  readonly id: string;
  readonly position: number;
  readonly type: Type;
  state: "active" | "completed" | "failed";
  data?: MessagePartDataMap[Type];
}

class DurableAgentTrace implements AgentTraceWriter {
  readonly #append: AgentPartEventAppend;
  readonly #entries: TraceEntry[] = [];
  #closed = false;

  constructor(append: AgentPartEventAppend) {
    this.#append = append;
  }

  async start<Type extends MessagePartType>(type: Type): Promise<AgentTracePart<Type>> {
    if (this.#closed) throw new GenerationStateError("trace", "The agent trace is closed.");
    const entry: TraceEntry<Type> = {
      id: createId(),
      position: this.#entries.length,
      type,
      state: "active",
    };
    await this.#append("part.started", {
      partId: entry.id,
      position: entry.position,
      type,
    });
    this.#entries.push(entry as TraceEntry);
    return {
      id: entry.id,
      type,
      delta: async (delta) => {
        this.#assertActive(entry);
        await this.#append("part.delta", { partId: entry.id, delta });
      },
      complete: async (data) => {
        this.#assertActive(entry);
        await this.#append("part.completed", {
          part: { id: entry.id, type, data } as MessagePartInput & { readonly id: string },
        });
        entry.data = data;
        entry.state = "completed";
      },
      fail: async (error) => {
        await this.#fail(entry, error);
      },
    };
  }

  completedParts(): MessagePartInput[] {
    return this.#entries.flatMap((entry) => entry.state === "completed"
      ? [{ id: entry.id, type: entry.type, data: entry.data! } as MessagePartInput]
      : []);
  }

  async finish(): Promise<void> {
    await this.failOpen({
      message: "The agent stopped before completing this trace part.",
      code: "incomplete_part",
      retryable: false,
    });
    this.#closed = true;
  }

  async failOpen(error: AgentTraceError): Promise<void> {
    for (const entry of this.#entries) {
      if (entry.state === "active") await this.#fail(entry, error);
    }
  }

  #assertActive(entry: TraceEntry): void {
    if (this.#closed || entry.state !== "active") {
      throw new GenerationStateError("trace", `Trace part ${entry.id} is no longer active.`);
    }
  }

  async #fail(entry: TraceEntry, error: AgentTraceError): Promise<void> {
    this.#assertActive(entry);
    await this.#append("part.failed", {
      partId: entry.id,
      error: {
        message: error.message,
        code: error.code ?? null,
        retryable: error.retryable ?? false,
      },
    });
    entry.state = "failed";
  }
}

class DurableAgentToolCalls implements AgentToolCallWriter {
  readonly #repository: Repository;
  readonly #scope: UserScope;
  readonly #generationId: string;
  readonly #attemptId: string;
  readonly #leaseToken: string;
  readonly #trace: AgentTraceWriter;

  constructor(
    repository: Repository,
    scope: UserScope,
    generationId: string,
    attemptId: string,
    leaseToken: string,
    trace: AgentTraceWriter,
  ) {
    this.#repository = repository;
    this.#scope = scope;
    this.#generationId = generationId;
    this.#attemptId = attemptId;
    this.#leaseToken = leaseToken;
    this.#trace = trace;
  }

  async start<Arguments extends JsonValue, Result extends JsonValue>(
    input: AgentToolCallInput<Arguments>,
  ): Promise<AgentToolCall<Arguments, Result>> {
    const created = await this.#repository.createToolCall(this.#scope, {
      id: createId(),
      generationId: this.#generationId,
      attemptId: this.#attemptId,
      leaseToken: this.#leaseToken,
      providerCallId: input.providerCallId,
      name: input.name,
      effect: input.effect,
      arguments: input.arguments,
      ...(input.idempotencyKey === undefined ? {} : { idempotencyKey: input.idempotencyKey }),
    });
    const tracePart = await this.#trace.start("tool-call");
    const initial = created.toolCall as ToolCallData<Arguments, Result>;
    let traceSettled = initial.status !== "pending";
    if (!created.created && initial.status !== "pending") {
      await tracePart.complete({
        toolCallId: initial.id,
        name: initial.name,
        state: initial.status === "succeeded" ? "completed" : "failed",
      });
    }

    const settleTrace = async (toolCall: ToolCallData): Promise<void> => {
      if (traceSettled) return;
      await tracePart.complete({
        toolCallId: toolCall.id,
        name: toolCall.name,
        state: toolCall.status === "succeeded" ? "completed" : "failed",
      });
      traceSettled = true;
    };
    return {
      toolCall: initial,
      created: created.created,
      succeed: async (result) => {
        const toolCall = await this.#repository.completeToolCall(this.#scope, {
          id: initial.id,
          generationId: this.#generationId,
          attemptId: initial.attemptId,
          leaseToken: this.#leaseToken,
          result,
        }) as ToolCallData<Arguments, Result>;
        await settleTrace(toolCall);
        return toolCall;
      },
      fail: async (error) => {
        const toolCall = await this.#repository.failToolCall(this.#scope, {
          id: initial.id,
          generationId: this.#generationId,
          attemptId: initial.attemptId,
          leaseToken: this.#leaseToken,
          error,
        }) as ToolCallData<Arguments, Result>;
        await settleTrace(toolCall);
        return toolCall;
      },
    };
  }
}

function mergeTraceAndFileEditParts(
  traceParts: readonly MessagePartInput[],
  files: readonly VersionFile[],
  changes: readonly SourceChange[] | null,
): MessagePartInput[] {
  const tracedEdits = new Set(traceParts.flatMap((part) => (
    part.type === "file-edit" ? [fileEditPartKey(part)] : []
  )));
  return [
    ...traceParts,
    ...fileEditMessageParts(files, changes).filter((part) => !tracedEdits.has(fileEditPartKey(part))),
  ];
}

function fileEditPartKey(part: MessagePartInput<"file-edit">): string {
  return part.data.operation === "move"
    ? `move:${part.data.from}:${part.data.to}`
    : `${part.data.operation}:${part.data.path}`;
}

function fileEditMessageParts(
  files: readonly VersionFile[],
  changes: readonly SourceChange[] | null,
): MessagePartInput<"file-edit">[] {
  if (!changes) {
    return files.map((file) => ({
      type: "file-edit",
      data: { operation: "write", path: file.path },
    }));
  }
  return changes.map((change) => {
    switch (change.type) {
      case "write":
        return { type: "file-edit", data: { operation: "write", path: change.path } };
      case "delete":
        return { type: "file-edit", data: { operation: "delete", path: change.path } };
      case "move":
        return {
          type: "file-edit",
          data: { operation: "move", from: change.from, to: change.to },
        };
    }
  });
}

function usageMessagePart(
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
  cost: GenerationCostData | null,
): MessagePartInput<"usage"> {
  return {
    type: "usage",
    data: {
      inputTokens,
      outputTokens,
      totalTokens,
      ...(cost ? { cost } : {}),
    },
  };
}

async function calculateGenerationCost(
  config: NormalizedGenerationCostConfig | undefined,
  input: GenerationCostInput,
  telemetry: VibyTelemetry | undefined,
  span: TelemetrySpan | undefined,
  attributes: TelemetryAttributes,
): Promise<GenerationCostData | null> {
  if (!config) return null;
  try {
    const amountMicros = normalizeCostAmount(await config.calculate(input));
    return amountMicros === null ? null : { amountMicros, currency: config.currency };
  } catch (error) {
    safeRecordException(span, error);
    safeRecordMetric(telemetry, {
      name: "viby.generation.cost_attribution_errors",
      kind: "counter",
      value: 1,
      unit: "{error}",
      attributes: metricAttributes(attributes, "failed"),
    });
    return null;
  }
}

function recordGenerationUsage(
  telemetry: VibyTelemetry | undefined,
  span: TelemetrySpan | undefined,
  attributes: TelemetryAttributes,
  outcome: string,
  inputTokens: number | null,
  outputTokens: number | null,
  totalTokens: number | null,
  cost: GenerationCostData | null,
): void {
  const spanAttributes: Record<string, TelemetryAttribute> = {
    "viby.generation.outcome": outcome,
  };
  const values = [
    ["input", inputTokens],
    ["output", outputTokens],
    ["total", totalTokens],
  ] as const;
  for (const [type, value] of values) {
    if (value === null) continue;
    spanAttributes[`gen_ai.usage.${type}_tokens`] = value;
    safeRecordMetric(telemetry, {
      name: "viby.generation.tokens",
      kind: "counter",
      value,
      unit: "{token}",
      attributes: {
        ...metricAttributes(attributes, outcome),
        "viby.token.type": type,
      },
    });
  }
  if (cost) {
    spanAttributes["viby.cost.amount_micros"] = cost.amountMicros;
    spanAttributes["viby.cost.currency"] = cost.currency;
    safeRecordMetric(telemetry, {
      name: "viby.generation.cost",
      kind: "counter",
      value: cost.amountMicros,
      unit: "{micro-unit}",
      attributes: {
        ...metricAttributes(attributes, outcome),
        "viby.cost.currency": cost.currency,
      },
    });
  }
  try {
    span?.setAttributes(spanAttributes);
  } catch {
    // Telemetry is fail-open and cannot change the generation result.
  }
}

function metricAttributes(
  attributes: TelemetryAttributes,
  outcome: string,
): TelemetryAttributes {
  return {
    "viby.framework": String(attributes["viby.framework"] ?? "unknown"),
    "gen_ai.provider.name": String(attributes["gen_ai.provider.name"] ?? "unknown"),
    "gen_ai.request.model": String(attributes["gen_ai.request.model"] ?? "unknown"),
    "viby.generation.outcome": outcome,
  };
}

function safeStartSpan(
  telemetry: VibyTelemetry | undefined,
  input: { readonly name: string; readonly attributes: TelemetryAttributes },
): TelemetrySpan | undefined {
  try {
    return telemetry?.startSpan(input);
  } catch {
    return undefined;
  }
}

function safeRecordMetric(
  telemetry: VibyTelemetry | undefined,
  input: Parameters<VibyTelemetry["recordMetric"]>[0],
): void {
  try {
    telemetry?.recordMetric(input);
  } catch {
    // Telemetry is fail-open and cannot change the generation result.
  }
}

function safeRecordException(span: TelemetrySpan | undefined, error: unknown): void {
  try {
    span?.recordException(error);
  } catch {
    // Telemetry is fail-open and cannot change the generation result.
  }
}

function safeSetSpanStatus(
  span: TelemetrySpan | undefined,
  status: "ok" | "error",
  message?: string,
): void {
  try {
    span?.setStatus(status, message);
  } catch {
    // Telemetry is fail-open and cannot change the generation result.
  }
}

function safeEndSpan(span: TelemetrySpan | undefined): void {
  try {
    span?.end();
  } catch {
    // Telemetry is fail-open and cannot change the generation result.
  }
}

interface ActiveRun {
  readonly controller: AbortController;
  readonly promise: Promise<void>;
}

class GenerationRunRegistry {
  readonly #runs = new Map<string, ActiveRun>();

  has(generationId: string): boolean {
    return this.#runs.has(generationId);
  }

  start(
    generationId: string,
    execute: (signal: AbortSignal) => Promise<void>,
  ): Promise<void> {
    if (this.#runs.has(generationId)) {
      throw new GenerationStateError(generationId, "Generation already has an active local attempt.");
    }
    const controller = new AbortController();
    const run: ActiveRun = {
      controller,
      promise: Promise.resolve()
        .then(() => execute(controller.signal))
        .finally(() => {
          if (this.#runs.get(generationId) === run) this.#runs.delete(generationId);
        }),
    };
    this.#runs.set(generationId, run);
    return run.promise;
  }

  abort(generationId: string, reason: string): boolean {
    const run = this.#runs.get(generationId);
    if (!run) return false;
    run.controller.abort(new DOMException(reason, "AbortError"));
    return true;
  }

  async abortAll(reason: string): Promise<void> {
    const runs = [...this.#runs.values()];
    for (const run of runs) run.controller.abort(new DOMException(reason, "AbortError"));
    await Promise.allSettled(runs.map((run) => run.promise));
  }
}

function unwrapGenerationOutcome<Framework extends FrameworkId>(
  outcome: GenerationOutcome<Framework>,
): Version<Framework> {
  switch (outcome.status) {
    case "succeeded":
      return outcome.version;
    case "waiting":
      throw new GenerationTaskRequiredError(
        outcome.generation.id,
        outcome.tasks.map((task) => task.id),
      );
    case "failed":
      throw new GenerationError(outcome.generation.id, outcome.error);
    case "cancelled":
      throw new GenerationCancelledError(outcome.generation.id, outcome.reason);
  }
}

function validateResolution(task: GenerationTaskData, resolution: GenerationTaskResolution): void {
  if (task.status !== "pending") {
    throw new GenerationStateError(task.generationId, `Task ${task.id} is already resolved.`);
  }
  if (task.kind !== resolution.kind) {
    throw new ConfigurationError(
      `Task ${task.id} requires a ${task.kind} resolution, not ${resolution.kind}.`,
    );
  }
  switch (resolution.kind) {
    case "plan":
      if (resolution.decision === "revise" && !resolution.feedback?.trim()) {
        throw new ConfigurationError("A revised plan requires feedback.");
      }
      break;
    case "question":
      if (!resolution.answer.trim()) {
        throw new ConfigurationError("A question resolution requires a non-empty answer.");
      }
      break;
    case "permission":
      if (resolution.note !== undefined && !resolution.note.trim()) {
        throw new ConfigurationError("A permission note cannot be empty when provided.");
      }
      break;
  }
}

function renderResolution(resolution: GenerationTaskResolution): string {
  switch (resolution.kind) {
    case "plan":
      return resolution.decision === "approve"
        ? "Plan approved. Continue with the proposed steps."
        : `Revise the plan with this feedback: ${resolution.feedback}`;
    case "question":
      return `Answer to the requested question: ${resolution.answer.trim()}`;
    case "permission":
      return [
        `Permission ${resolution.decision === "allow" ? "granted" : "denied"}.`,
        resolution.note?.trim(),
      ].filter(Boolean).join(" ");
  }
}

function normalizeCursor(cursor: string | undefined): string {
  if (cursor === undefined) return "0";
  if (!/^(?:0|[1-9]\d*)$/.test(cursor)) {
    throw new ConfigurationError("Generation event cursor must be a non-negative integer string.");
  }
  return cursor;
}

function normalizePollInterval(value: number | undefined): number {
  const interval = value ?? DEFAULT_POLL_INTERVAL_MS;
  if (!Number.isInteger(interval) || interval < 10 || interval > 60_000) {
    throw new ConfigurationError("Poll interval must be an integer between 10 and 60000 milliseconds.");
  }
  return interval;
}

function normalizeGenerationExecution(
  value: VibyConfig["generation"],
): "embedded" | "worker" {
  if (value === undefined) return "embedded";
  if (!value || typeof value !== "object") {
    throw new ConfigurationError("generation must be an object.");
  }
  const execution = value.execution ?? "embedded";
  if (execution !== "embedded" && execution !== "worker") {
    throw new ConfigurationError("generation.execution must be embedded or worker.");
  }
  return execution;
}

function normalizeRetentionMs(
  value: number | null | undefined,
  fallback: number | null,
): number | null {
  const retention = value === undefined ? fallback : value;
  if (retention === null) return null;
  if (!Number.isInteger(retention) || retention < 0 || retention > MAX_DELETED_CHAT_RETENTION_MS) {
    throw new ConfigurationError(
      `Deleted chat retention must be null or an integer between 0 and ${MAX_DELETED_CHAT_RETENTION_MS} milliseconds.`,
    );
  }
  return retention;
}

function normalizeChatRetentionConfig(value: VibyConfig["retention"]): number | null {
  if (value === undefined) return DEFAULT_DELETED_CHAT_RETENTION_MS;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("retention must be an object.");
  }
  return normalizeRetentionMs(value.deletedChatsMs, DEFAULT_DELETED_CHAT_RETENTION_MS);
}

function normalizeOutboundEventSinks(
  value: VibyConfig["events"],
): ReadonlyMap<string, OutboundEventSink> {
  if (value === undefined) return new Map();
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("events must be an object.");
  }
  if (value.sinks !== undefined && !Array.isArray(value.sinks)) {
    throw new ConfigurationError("events.sinks must be an array.");
  }
  const sinks = new Map<string, OutboundEventSink>();
  for (const sink of value.sinks ?? []) {
    if (!sink || typeof sink !== "object" || typeof sink.deliver !== "function") {
      throw new ConfigurationError("Every outbound event sink must provide id and deliver.");
    }
    const id = assertIdentifier(sink.id, "Outbound event sink id");
    if (sinks.has(id)) throw new ConfigurationError(`Outbound event sink id is duplicated: ${id}`);
    sinks.set(id, sink);
  }
  return sinks;
}

interface NormalizedOutboundRetryPolicy {
  readonly maxAttempts: number;
  readonly initialDelayMs: number;
  readonly maxDelayMs: number;
  readonly multiplier: number;
  readonly leaseMs: number;
}

function normalizeOutboundRetryPolicy(
  value: OutboundEventRetryPolicy | undefined,
): NormalizedOutboundRetryPolicy {
  if (value !== undefined && (!value || typeof value !== "object" || Array.isArray(value))) {
    throw new ConfigurationError("Outbound event retry policy must be an object.");
  }
  const maxAttempts = value?.maxAttempts ?? DEFAULT_OUTBOUND_MAX_ATTEMPTS;
  const initialDelayMs = value?.initialDelayMs ?? DEFAULT_OUTBOUND_INITIAL_DELAY_MS;
  const maxDelayMs = value?.maxDelayMs ?? DEFAULT_OUTBOUND_MAX_DELAY_MS;
  const multiplier = value?.multiplier ?? DEFAULT_OUTBOUND_MULTIPLIER;
  const leaseMs = value?.leaseMs ?? DEFAULT_OUTBOUND_LEASE_MS;
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 100) {
    throw new ConfigurationError("Outbound event maxAttempts must be an integer between 1 and 100.");
  }
  if (!Number.isInteger(initialDelayMs) || initialDelayMs < 0 || initialDelayMs > 86_400_000) {
    throw new ConfigurationError("Outbound event initialDelayMs must be an integer between 0 and 86400000.");
  }
  if (!Number.isInteger(maxDelayMs) || maxDelayMs < initialDelayMs || maxDelayMs > 86_400_000) {
    throw new ConfigurationError("Outbound event maxDelayMs must be an integer between initialDelayMs and 86400000.");
  }
  if (!Number.isFinite(multiplier) || multiplier < 1 || multiplier > 10) {
    throw new ConfigurationError("Outbound event retry multiplier must be between 1 and 10.");
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 900_000) {
    throw new ConfigurationError("Outbound event leaseMs must be an integer between 100 and 900000.");
  }
  return { maxAttempts, initialDelayMs, maxDelayMs, multiplier, leaseMs };
}

function outboundRetryDelay(policy: NormalizedOutboundRetryPolicy, attemptCount: number): number {
  return Math.min(
    policy.maxDelayMs,
    Math.round(policy.initialDelayMs * policy.multiplier ** Math.max(0, attemptCount - 1)),
  );
}

function normalizeOutboundDeliveryStatus(
  value: OutboundEventDeliveryStatus | undefined,
): void {
  if (
    value !== undefined
    && value !== "pending"
    && value !== "delivering"
    && value !== "delivered"
    && value !== "dead_lettered"
  ) throw new ConfigurationError("Outbound event delivery status is invalid.");
}

function normalizeTelemetry(value: VibyTelemetry | undefined): VibyTelemetry | undefined {
  if (value === undefined) return undefined;
  if (
    !value
    || typeof value !== "object"
    || typeof value.startSpan !== "function"
    || typeof value.recordMetric !== "function"
  ) {
    throw new ConfigurationError("telemetry must provide startSpan and recordMetric functions.");
  }
  return value;
}

function normalizeCostConfig(
  value: GenerationCostConfig | undefined,
): NormalizedGenerationCostConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || typeof value.calculate !== "function") {
    throw new ConfigurationError("cost must provide currency and calculate values.");
  }
  return {
    currency: normalizeCostCurrency(value.currency),
    calculate: value.calculate,
  };
}

function normalizeGenerationWorkerOptions(
  options: GenerationWorkerOptions,
): NormalizedGenerationWorkerOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Generation worker options must be an object.");
  }
  const id = assertIdentifier(options.id, "Generation worker id");
  const concurrency = options.concurrency ?? 1;
  const leaseMs = options.leaseMs ?? DEFAULT_WORKER_LEASE_MS;
  const heartbeatMs = options.heartbeatMs ?? Math.min(DEFAULT_WORKER_HEARTBEAT_MS, leaseMs / 3);
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_WORKER_POLL_INTERVAL_MS;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 32) {
    throw new ConfigurationError("Generation worker concurrency must be an integer between 1 and 32.");
  }
  if (!Number.isInteger(leaseMs) || leaseMs < 100 || leaseMs > 900_000) {
    throw new ConfigurationError("Generation worker leaseMs must be an integer between 100 and 900000.");
  }
  if (!Number.isInteger(heartbeatMs) || heartbeatMs < 25 || heartbeatMs >= leaseMs / 2) {
    throw new ConfigurationError("Generation worker heartbeatMs must be at least 25 and less than half leaseMs.");
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs < 10 || pollIntervalMs > 60_000) {
    throw new ConfigurationError("Generation worker pollIntervalMs must be an integer between 10 and 60000.");
  }
  return { id, concurrency, leaseMs, heartbeatMs, pollIntervalMs };
}

function validateGenerationWorkerRunOptions(options: GenerationWorkerRunOptions): void {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Generation worker run options must be an object.");
  }
}

function assertReason(reason: string): string {
  const normalized = reason.trim();
  if (!normalized) throw new ConfigurationError("Cancellation reason cannot be empty.");
  if (normalized.length > 2_000) {
    throw new ConfigurationError("Cancellation reason cannot exceed 2000 characters.");
  }
  return normalized;
}

function isSettled(status: GenerationData["status"]): boolean {
  return status === "waiting"
    || status === "succeeded"
    || status === "failed"
    || status === "cancelled";
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError"
    || error instanceof Error && error.name === "AbortError";
}

class GenerationWorkerLeaseLostError extends Error {
  constructor(generationId: string, attemptId: string) {
    super(`Generation ${generationId} attempt ${attemptId} lost its worker lease.`);
    this.name = "GenerationWorkerLeaseLostError";
  }
}

function combineAbortSignals(first: AbortSignal, second?: AbortSignal): AbortSignal {
  if (!second) return first;
  const controller = new AbortController();
  const abortFirst = () => abort(first.reason);
  const abortSecond = () => abort(second.reason);
  const abort = (reason: unknown) => {
    if (!controller.signal.aborted) controller.abort(reason);
    first.removeEventListener("abort", abortFirst);
    second.removeEventListener("abort", abortSecond);
  };
  if (first.aborted) abort(first.reason);
  else if (second.aborted) abort(second.reason);
  else {
    first.addEventListener("abort", abortFirst, { once: true });
    second.addEventListener("abort", abortSecond, { once: true });
  }
  return controller.signal;
}

function waitForPoll(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
