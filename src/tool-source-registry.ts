import { ConfigurationError, NotFoundError } from "./errors.js";
import {
  defineToolSource,
  type ToolSource,
  type ToolSourceContext,
  type ToolSourceResolver,
} from "./tool-source.js";
import type { FrameworkId, JsonValue, UserScope } from "./types.js";
import type { SecretStore } from "./integration-store.js";
import {
  ToolSourceAuthorizationManager,
  type CompleteToolSourceAuthorizationResult,
  type ConnectToolSourceInput,
  type ConnectToolSourceResult,
  type DisconnectToolSourceResult,
  type ToolSourceAuthorizationAdapter,
  type ToolSourceAuthorizationStore,
  type ToolSourceConnectionData,
  type ToolSourceCredentialContext,
} from "./tool-source-authorization.js";
import { assertIdentifier, createId } from "./utils.js";

const MAX_CONFIGURATION_BYTES = 32_000;
const MAX_LIST_LIMIT = 200;
const SECRET_SUFFIXES = [
  "authorization",
  "credential",
  "credentials",
  "password",
  "privatekey",
  "secret",
  "token",
  "apikey",
] as const;

export type ToolSourceRegistrationStatus = "active" | "disabled" | "archived";

export interface ToolSourceRegistrationData {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string | null;
  /** Public, JSON-only adapter configuration. Secrets are rejected. */
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly status: ToolSourceRegistrationStatus;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

/** JSON-safe immutable public registration retained with a durable generation. */
export interface ToolSourceRegistrationSnapshot {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string | null;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreateToolSourceRegistrationRecord {
  readonly id: string;
  readonly type: string;
  readonly name: string;
  readonly description: string | null;
  readonly configuration: Readonly<Record<string, JsonValue>>;
  readonly now: Date;
}

export interface UpdateToolSourceRegistrationRecord {
  readonly name?: string;
  readonly description?: string | null;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly status?: Exclude<ToolSourceRegistrationStatus, "archived">;
  readonly now: Date;
}

export interface ToolSourceRegistrationListOptions {
  readonly status?: ToolSourceRegistrationStatus;
  readonly type?: string;
  readonly limit?: number;
}

export interface ToolSourceRegistryStore {
  createToolSourceRegistration(
    scope: UserScope,
    input: CreateToolSourceRegistrationRecord,
  ): Promise<ToolSourceRegistrationData>;
  getToolSourceRegistration(
    scope: UserScope,
    id: string,
  ): Promise<ToolSourceRegistrationData | null>;
  listToolSourceRegistrations(
    scope: UserScope,
    options?: ToolSourceRegistrationListOptions,
  ): Promise<readonly ToolSourceRegistrationData[]>;
  updateToolSourceRegistration(
    scope: UserScope,
    id: string,
    input: UpdateToolSourceRegistrationRecord,
  ): Promise<ToolSourceRegistrationData>;
  archiveToolSourceRegistration(
    scope: UserScope,
    id: string,
    now: Date,
  ): Promise<ToolSourceRegistrationData>;
  replaceChatToolSources(
    scope: UserScope,
    chatId: string,
    sourceIds: readonly string[],
    now: Date,
  ): Promise<readonly ToolSourceRegistrationData[]>;
  listChatToolSources(
    scope: UserScope,
    chatId: string,
  ): Promise<readonly ToolSourceRegistrationData[]>;
}

export interface ToolSourceAdapterOpenInput {
  readonly source: ToolSourceRegistrationData;
  readonly scope: UserScope;
  /** Resolves short-lived opaque credential bytes only inside the adapter boundary. */
  readonly credential?: (signal?: AbortSignal) => Promise<ToolSourceCredentialContext>;
}

/** Materializes one durable, credential-free registration as the existing ToolSource contract. */
export interface ToolSourceAdapter<Framework extends FrameworkId = FrameworkId> {
  readonly type: string;
  /** Optional provider-neutral OAuth or authorization lifecycle for this source type. */
  readonly authorization?: ToolSourceAuthorizationAdapter;
  open(input: ToolSourceAdapterOpenInput): ToolSource<Framework> | Promise<ToolSource<Framework>>;
  close?(): Promise<void>;
}

export interface CreateToolSourceInput {
  readonly type: string;
  readonly name: string;
  readonly description?: string | null;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
}

export interface UpdateToolSourceInput {
  readonly name?: string;
  readonly description?: string | null;
  readonly configuration?: Readonly<Record<string, JsonValue>>;
  readonly enabled?: boolean;
}

export function defineToolSourceAdapter<Framework extends FrameworkId = FrameworkId>(
  adapter: ToolSourceAdapter<Framework>,
): ToolSourceAdapter<Framework> {
  assertAdapter(adapter);
  return adapter;
}

/** Tenant-scoped durable registrations resolved into provider-neutral generation tools. */
export class ToolSourceRegistry<Framework extends FrameworkId = FrameworkId>
implements ToolSourceResolver<Framework> {
  readonly #store: ToolSourceRegistryStore & ToolSourceAuthorizationStore;
  readonly #adapters: ReadonlyMap<string, ToolSourceAdapter<Framework>>;
  readonly #sources = new Map<string, Promise<ToolSource<Framework>>>();
  readonly #authorization: ToolSourceAuthorizationManager;

  constructor(
    store: ToolSourceRegistryStore & ToolSourceAuthorizationStore,
    adapters: Readonly<Record<string, ToolSourceAdapter<Framework>>> = {},
    secrets: SecretStore | null = null,
  ) {
    this.#store = store;
    this.#adapters = normalizeAdapters(adapters);
    this.#authorization = new ToolSourceAuthorizationManager(
      store,
      secrets,
      (type) => this.#adapter(type),
    );
  }

  get configured(): boolean {
    return this.#adapters.size > 0;
  }

  async create(scope: UserScope, input: CreateToolSourceInput): Promise<ToolSourceRegistrationData> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("A durable tool source requires an input object.");
    }
    const type = normalizeType(input.type);
    this.#adapter(type);
    return this.#store.createToolSourceRegistration(scope, {
      id: createId(),
      type,
      name: normalizeName(input.name),
      description: normalizeDescription(input.description),
      configuration: normalizeConfiguration(input.configuration),
      now: new Date(),
    });
  }

  async get(scope: UserScope, id: string): Promise<ToolSourceRegistrationData> {
    const source = await this.#store.getToolSourceRegistration(scope, id);
    if (!source) throw new NotFoundError("Tool source");
    return source;
  }

  list(
    scope: UserScope,
    options: ToolSourceRegistrationListOptions = {},
  ): Promise<readonly ToolSourceRegistrationData[]> {
    const limit = options.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
      throw new ConfigurationError(`Tool source list limit must be between 1 and ${MAX_LIST_LIMIT}.`);
    }
    return this.#store.listToolSourceRegistrations(scope, {
      ...options,
      limit,
      ...(options.type === undefined ? {} : { type: normalizeType(options.type) }),
    });
  }

  async update(
    scope: UserScope,
    id: string,
    input: UpdateToolSourceInput,
  ): Promise<ToolSourceRegistrationData> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Tool source updates require an input object.");
    }
    const current = await this.get(scope, id);
    if (current.status === "archived") {
      throw new ConfigurationError(`Tool source ${id} is archived.`);
    }
    const updated = await this.#store.updateToolSourceRegistration(scope, id, {
      ...(input.name === undefined ? {} : { name: normalizeName(input.name) }),
      ...(input.description === undefined
        ? {}
        : { description: normalizeDescription(input.description) }),
      ...(input.configuration === undefined
        ? {}
        : { configuration: normalizeConfiguration(input.configuration) }),
      ...(input.enabled === undefined
        ? {}
        : { status: input.enabled ? "active" : "disabled" }),
      now: new Date(),
    });
    await this.#closeCached(scope, id);
    return updated;
  }

  async archive(scope: UserScope, id: string): Promise<ToolSourceRegistrationData> {
    const archived = await this.#store.archiveToolSourceRegistration(scope, id, new Date());
    await this.#closeCached(scope, id);
    return archived;
  }

  connection(scope: UserScope, id: string): Promise<ToolSourceConnectionData | null> {
    return this.#authorization.connection(scope, id);
  }

  connect(
    scope: UserScope,
    id: string,
    input: ConnectToolSourceInput,
  ): Promise<ConnectToolSourceResult> {
    return this.#authorization.connect(scope, id, input);
  }

  callback(request: Request | string): Promise<CompleteToolSourceAuthorizationResult> {
    return this.#authorization.callback(request);
  }

  disconnect(
    scope: UserScope,
    id: string,
    signal?: AbortSignal,
  ): Promise<DisconnectToolSourceResult> {
    return this.#authorization.disconnect(scope, id, signal);
  }

  select(
    scope: UserScope,
    chatId: string,
    sourceIds: readonly string[],
  ): Promise<readonly ToolSourceRegistrationData[]> {
    if (!Array.isArray(sourceIds)) {
      throw new ConfigurationError("Chat tool source selection must be an array.");
    }
    const unique = [...new Set(sourceIds)];
    if (unique.length !== sourceIds.length) {
      throw new ConfigurationError("Chat tool source selection cannot contain duplicates.");
    }
    return this.#store.replaceChatToolSources(scope, chatId, unique, new Date());
  }

  selected(
    scope: UserScope,
    chatId: string,
  ): Promise<readonly ToolSourceRegistrationData[]> {
    return this.#store.listChatToolSources(scope, chatId);
  }

  async snapshot(
    scope: UserScope,
    chatId: string,
  ): Promise<readonly ToolSourceRegistrationSnapshot[]> {
    const selected = await this.#store.listChatToolSources(scope, chatId);
    return Object.freeze(selected
      .filter((source) => source.status === "active")
      .map(snapshotRegistration));
  }

  async resolve(context: ToolSourceContext<Framework>): Promise<readonly ToolSource<Framework>[]> {
    const registrations = context.toolSourceSnapshots === undefined
      ? await this.#store.listChatToolSources(context, context.chatId)
      : context.toolSourceSnapshots.map(registrationFromSnapshot);
    const active = context.toolSourceSnapshots === undefined
      ? registrations.filter((source) => source.status === "active")
      : registrations;
    return Promise.all(active.map((source) => this.#open(context, source)));
  }

  async close(): Promise<void> {
    const pending = [...this.#sources.values()];
    this.#sources.clear();
    const opened = await Promise.allSettled(pending);
    const results = await Promise.allSettled([
      ...opened.flatMap((result) => result.status === "fulfilled" && result.value.close
        ? [result.value.close()]
        : []),
      ...[...this.#adapters.values()].flatMap((adapter) => adapter.close ? [adapter.close()] : []),
    ]);
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }

  #adapter(type: string): ToolSourceAdapter<Framework> {
    const adapter = this.#adapters.get(type);
    if (!adapter) throw new ConfigurationError(`No durable tool source adapter is configured for ${type}.`);
    return adapter;
  }

  #open(scope: UserScope, registration: ToolSourceRegistrationData): Promise<ToolSource<Framework>> {
    const key = cacheKey(scope, registration.id, registrationRevision(registration));
    let pending = this.#sources.get(key);
    if (!pending) {
      const adapter = this.#adapter(registration.type);
      const credential = adapter.authorization
        ? (signal?: AbortSignal) => this.#authorization.credential(scope, registration.id, signal)
        : undefined;
      pending = Promise.resolve(adapter.open({
        source: registration,
        scope: { tenantId: scope.tenantId, userId: scope.userId },
        ...(credential ? { credential } : {}),
      })).then((source) => {
        defineToolSource(source);
        if (source.id !== registration.id) {
          throw new ConfigurationError(
            `Durable tool source adapter ${registration.type} returned id ${source.id}; expected ${registration.id}.`,
          );
        }
        if (!credential) return source;
        return defineToolSource<Framework>({
          id: source.id,
          async list(context) {
            await credential(context.signal);
            return source.list(context);
          },
          async call(call, context) {
            await credential(context.signal);
            return source.call(call, context);
          },
          ...(source.close ? { close: () => source.close!() } : {}),
        });
      }).catch((error) => {
        this.#sources.delete(key);
        throw error;
      });
      this.#sources.set(key, pending);
    }
    return pending;
  }

  async #closeCached(scope: UserScope, id: string): Promise<void> {
    const prefix = cacheKeyPrefix(scope, id);
    const pending = [...this.#sources.entries()]
      .filter(([key]) => key.startsWith(prefix))
      .map(([key, source]) => {
        this.#sources.delete(key);
        return source;
      });
    const sources = await Promise.all(pending.map((source) => source.catch(() => null)));
    await Promise.all(sources.map((source) => source?.close?.()));
  }
}

function snapshotRegistration(source: ToolSourceRegistrationData): ToolSourceRegistrationSnapshot {
  return Object.freeze({
    id: source.id,
    type: source.type,
    name: source.name,
    description: source.description,
    configuration: deepFreeze(structuredClone(source.configuration)),
    createdAt: source.createdAt.toISOString(),
    updatedAt: source.updatedAt.toISOString(),
  });
}

function registrationFromSnapshot(snapshot: ToolSourceRegistrationSnapshot): ToolSourceRegistrationData {
  const createdAt = new Date(snapshot.createdAt);
  const updatedAt = new Date(snapshot.updatedAt);
  if (Number.isNaN(createdAt.getTime()) || Number.isNaN(updatedAt.getTime())) {
    throw new ConfigurationError(`Tool source snapshot ${snapshot.id} has an invalid revision timestamp.`);
  }
  return {
    id: assertIdentifier(snapshot.id, "Tool source snapshot id"),
    type: normalizeType(snapshot.type),
    name: normalizeName(snapshot.name),
    description: normalizeDescription(snapshot.description),
    configuration: normalizeConfiguration(snapshot.configuration),
    status: "active",
    createdAt,
    updatedAt,
  };
}

function normalizeAdapters<Framework extends FrameworkId>(
  adapters: Readonly<Record<string, ToolSourceAdapter<Framework>>>,
): ReadonlyMap<string, ToolSourceAdapter<Framework>> {
  if (!adapters || typeof adapters !== "object" || Array.isArray(adapters)) {
    throw new ConfigurationError("tools.adapters must be an object.");
  }
  const entries = Object.entries(adapters);
  for (const [type, adapter] of entries) {
    assertAdapter(adapter);
    if (normalizeType(type) !== adapter.type) {
      throw new ConfigurationError(`Tool source adapter key ${type} must match adapter.type ${adapter.type}.`);
    }
  }
  return new Map(entries);
}

function assertAdapter(adapter: ToolSourceAdapter): void {
  if (!adapter || typeof adapter !== "object") {
    throw new ConfigurationError("A durable tool source adapter must be an object.");
  }
  normalizeType(adapter.type);
  if (typeof adapter.open !== "function") {
    throw new ConfigurationError(`Tool source adapter ${adapter.type} must implement open().`);
  }
  if (adapter.authorization) {
    const provider = adapter.authorization.provider?.trim();
    if (!provider || !/^[a-zA-Z0-9_.-]{1,80}$/.test(provider)) {
      throw new ConfigurationError(`Tool source adapter ${adapter.type} has an invalid authorization provider.`);
    }
    if (typeof adapter.authorization.startAuthorization !== "function"
      || typeof adapter.authorization.completeAuthorization !== "function") {
      throw new ConfigurationError(
        `Tool source adapter ${adapter.type} authorization must implement startAuthorization() and completeAuthorization().`,
      );
    }
  }
}

function normalizeType(value: string): string {
  const type = value?.trim();
  if (!type || !/^[a-z][a-z0-9-]{0,63}$/.test(type)) {
    throw new ConfigurationError("Tool source type must be a lowercase identifier up to 64 characters.");
  }
  return type;
}

function normalizeName(value: string): string {
  const name = value?.trim();
  if (!name || name.length > 120) {
    throw new ConfigurationError("Tool source name must contain 1 to 120 characters.");
  }
  return name;
}

function normalizeDescription(value: string | null | undefined): string | null {
  if (value === undefined || value === null) return null;
  const description = value.trim();
  if (description.length > 1_000) {
    throw new ConfigurationError("Tool source description cannot exceed 1000 characters.");
  }
  return description || null;
}

function normalizeConfiguration(
  value: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> {
  if (value === undefined) return Object.freeze({});
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("Tool source configuration must be a JSON object.");
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new ConfigurationError("Tool source configuration must be JSON serializable.", { cause: error });
  }
  if (new TextEncoder().encode(serialized).byteLength > MAX_CONFIGURATION_BYTES) {
    throw new ConfigurationError(`Tool source configuration cannot exceed ${MAX_CONFIGURATION_BYTES} bytes.`);
  }
  const normalized = JSON.parse(serialized) as Record<string, JsonValue>;
  assertNoSecrets(normalized, "configuration");
  return deepFreeze(normalized);
}

function assertNoSecrets(value: JsonValue, path: string): void {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecrets(item, `${path}[${index}]`));
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    const normalizedKey = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
    if (SECRET_SUFFIXES.some((suffix) => normalizedKey.endsWith(suffix))) {
      throw new ConfigurationError(
        `Tool source ${path}.${key} looks secret. Store credentials through the tool-source authorization layer.`,
      );
    }
    assertNoSecrets(item, `${path}.${key}`);
  }
}

function deepFreeze<Value extends JsonValue>(value: Value): Value {
  if (value && typeof value === "object") {
    for (const item of Array.isArray(value) ? value : Object.values(value)) deepFreeze(item);
    Object.freeze(value);
  }
  return value;
}

function cacheKeyPrefix(scope: UserScope, id: string): string {
  return `${scope.tenantId}\0${scope.userId}\0${id}\0`;
}

function cacheKey(scope: UserScope, id: string, revision: string): string {
  return `${cacheKeyPrefix(scope, id)}${revision}`;
}

function registrationRevision(source: ToolSourceRegistrationData): string {
  return JSON.stringify({
    type: source.type,
    name: source.name,
    description: source.description,
    configuration: source.configuration,
    updatedAt: source.updatedAt.toISOString(),
  });
}
