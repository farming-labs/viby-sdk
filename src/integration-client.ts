import { randomBytes } from "node:crypto";
import {
  ConfigurationError,
  IntegrationAuthorizationError,
  IntegrationConnectionRequiredError,
  NotFoundError,
} from "./errors.js";
import type {
  IntegrationConnectionData,
  IntegrationConnectionStore,
  SecretStore,
  StoredIntegrationConnection,
} from "./integration-store.js";
import type {
  ConfiguredIntegration,
  DeploymentIntegration,
  IntegrationCategory,
  IntegrationCredential,
  IntegrationOperationContext,
  RepositoryIntegration,
  VibyIntegrations,
} from "./integrations.js";
import { configuredIntegrations } from "./integrations.js";
import { ScopedDeploymentIntegrations } from "./deployment-integrations.js";
import { ScopedRepositoryIntegrations } from "./repository-integrations.js";
import type { UserScope } from "./types.js";
import { assertIdentifier, createId, sha256 } from "./utils.js";

const AUTHORIZATION_SESSION_MS = 10 * 60 * 1_000;

export interface ConnectIntegrationInput {
  readonly callbackUrl: string;
  readonly returnTo: string;
  readonly scopes?: readonly string[];
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export type ConnectIntegrationResult =
  | {
      readonly status: "connected";
      readonly connection: IntegrationConnectionData;
    }
  | {
      readonly status: "authorization-required";
      readonly url: string;
      readonly expiresAt: Date;
    };

export interface CompleteIntegrationAuthorizationResult {
  readonly category: IntegrationCategory;
  readonly integrationId: string;
  readonly connection: IntegrationConnectionData;
  readonly returnTo: string;
}

export interface ConfiguredIntegrationStatus extends ConfiguredIntegration {
  readonly connections: readonly IntegrationConnectionData[];
  readonly connected: boolean;
}

export interface DisconnectIntegrationResult {
  readonly connection: IntegrationConnectionData;
  readonly providerRevoked: boolean;
}

type AnyIntegration = RepositoryIntegration<any, any, any> | DeploymentIntegration<any, any>;

export class IntegrationClient {
  readonly #config: VibyIntegrations;
  readonly #connectionStore: IntegrationConnectionStore | null;
  readonly #secretStore: SecretStore | null;

  constructor(
    config: VibyIntegrations | undefined,
    connectionStore: IntegrationConnectionStore | null,
    secretStore: SecretStore | null,
  ) {
    configuredIntegrations(config);
    this.#config = config ?? {};
    this.#connectionStore = connectionStore;
    this.#secretStore = secretStore;
    if (configuredIntegrations(config).length > 0 && (!connectionStore || !secretStore)) {
      throw new ConfigurationError(
        "Configured integrations require both a connection store and a secret store.",
      );
    }
  }

  forUser(scope: UserScope): ScopedIntegrations {
    const normalized = {
      tenantId: assertIdentifier(scope.tenantId, "tenantId"),
      userId: assertIdentifier(scope.userId, "userId"),
    };
    return new ScopedIntegrations(this, normalized);
  }

  async callback(request: Request | string): Promise<CompleteIntegrationAuthorizationResult> {
    const callbackUrl = normalizeHttpUrl(typeof request === "string" ? request : request.url, "Callback URL");
    const state = new URL(callbackUrl).searchParams.get("state");
    if (!state || state.length > 1_000) {
      throw new IntegrationAuthorizationError("The integration callback contains no valid state.");
    }
    const stores = this.#stores();
    const consumedAt = new Date();
    const stateHash = sha256(state);
    const pending = await stores.connection.getAuthorizationSession(stateHash, consumedAt);
    if (!pending) {
      throw new IntegrationAuthorizationError(
        "The integration authorization session is missing, expired, or already consumed.",
      );
    }
    assertMatchingCallback(pending.session.callbackUrl, callbackUrl);
    const consumed = await stores.connection.consumeAuthorizationSession(stateHash, consumedAt);
    if (!consumed) {
      throw new IntegrationAuthorizationError(
        "The integration authorization session was already consumed.",
        pending.session.provider,
      );
    }
    const { scope, session } = consumed;
    const adapter = this.#adapter(session.category, session.integrationId);
    if (adapter.provider !== session.provider) {
      throw new IntegrationAuthorizationError(
        "The configured integration provider changed during authorization.",
        session.provider,
      );
    }
    const adapterSession = session.sessionSecretRef
      ? await stores.secret.get(scope, session.sessionSecretRef)
      : undefined;
    if (session.sessionSecretRef && !adapterSession) {
      throw new IntegrationAuthorizationError(
        "The integration authorization session secret is unavailable.",
        session.provider,
      );
    }

    try {
      const result = validateAuthorizationResult(await adapter.connection.completeAuthorization({
        callbackUrl,
        ...(adapterSession ? { session: adapterSession } : {}),
      }, scope), session.provider);
      const secretRef = await stores.secret.put(scope, {
        bytes: result.credential.secret,
        purpose: "integration-credential",
        expiresAt: null,
      });
      try {
        const saved = await stores.connection.upsertConnection(scope, {
          id: createId(),
          category: session.category,
          integrationId: session.integrationId,
          provider: session.provider,
          account: result.account,
          secretRef,
          scopes: result.credential.scopes,
          expiresAt: result.credential.expiresAt,
          now: consumedAt,
        });
        if (saved.replacedSecretRef && saved.replacedSecretRef !== secretRef) {
          await stores.secret.delete(scope, saved.replacedSecretRef).catch(() => undefined);
        }
        return {
          category: session.category,
          integrationId: session.integrationId,
          connection: publicConnection(saved.connection),
          returnTo: session.returnTo,
        };
      } catch (error) {
        await stores.secret.delete(scope, secretRef).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof IntegrationAuthorizationError) throw error;
      throw new IntegrationAuthorizationError(
        `Could not complete authorization with ${session.provider}.`,
        session.provider,
        { cause: error },
      );
    } finally {
      if (session.sessionSecretRef) {
        await stores.secret.delete(scope, session.sessionSecretRef).catch(() => undefined);
      }
    }
  }

  async close(): Promise<void> {
    const stores = [this.#connectionStore, this.#secretStore].filter(
      (store): store is IntegrationConnectionStore | SecretStore => store !== null,
    );
    const results = await Promise.allSettled([...new Set(stores)].map((store) => store.close()));
    const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failed) throw failed.reason;
  }

  configured(category: IntegrationCategory): readonly ConfiguredIntegration[] {
    return configuredIntegrations(this.#config).filter((item) => item.category === category);
  }

  async statuses(
    scope: UserScope,
    category: IntegrationCategory,
  ): Promise<readonly ConfiguredIntegrationStatus[]> {
    const connections = await this.connections(scope, category);
    return this.configured(category).map((integration) => {
      const matching = connections.filter((connection) => connection.integrationId === integration.id);
      return {
        ...integration,
        connections: matching,
        connected: matching.some((connection) => connection.status === "active"),
      };
    });
  }

  repositoryAdapter(integrationId: string): RepositoryIntegration<any, any, any> {
    return this.#adapter(
      "repository",
      assertIdentifier(integrationId, "Repository integration id"),
    ) as RepositoryIntegration<any, any, any>;
  }

  deploymentAdapter(integrationId: string): DeploymentIntegration<any, any> {
    return this.#adapter(
      "deployment",
      assertIdentifier(integrationId, "Deployment integration id"),
    ) as DeploymentIntegration<any, any>;
  }

  async connections(
    scope: UserScope,
    category: IntegrationCategory,
    integrationId?: string,
  ): Promise<readonly IntegrationConnectionData[]> {
    const records = await this.#stores().connection.listConnections(scope, category, integrationId);
    return records.map(publicConnection);
  }

  async connect(
    scope: UserScope,
    category: IntegrationCategory,
    integrationId: string,
    input: ConnectIntegrationInput,
  ): Promise<ConnectIntegrationResult> {
    const id = assertIdentifier(integrationId, "Integration id");
    const adapter = this.#adapter(category, id);
    const stores = this.#stores();
    const callbackUrl = normalizeHttpUrl(input.callbackUrl, "Integration callback URL");
    const returnTo = normalizeReturnTo(input.returnTo, callbackUrl);
    const scopes = normalizeScopes(input.scopes);
    input.signal?.throwIfAborted();
    if (input.force !== true) {
      const existing = (await stores.connection.listConnections(scope, category, id))
        .find((connection) => connection.status === "active");
      if (existing) {
        try {
          const resolved = await this.operationContext(scope, category, id, existing.id, input.signal);
          return {
            status: "connected",
            connection: publicConnection(await stores.connection.getConnection(scope, resolved.connectionId)
              ?? existing),
          };
        } catch (error) {
          if (!(error instanceof IntegrationConnectionRequiredError)) throw error;
        }
      }
    }

    const state = randomBytes(32).toString("base64url");
    const now = new Date();
    let request;
    try {
      request = validateAuthorizationRequest(await adapter.connection.startAuthorization({
        callbackUrl,
        state,
        ...(scopes.length > 0 ? { scopes } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }, { ...scope, ...(input.signal ? { signal: input.signal } : {}) }), state, adapter.provider);
    } catch (error) {
      throw new IntegrationAuthorizationError(
        `Could not start authorization with ${adapter.provider}.`,
        adapter.provider,
        { cause: error },
      );
    }
    const expiresAt = new Date(Math.min(
      request.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
      now.getTime() + AUTHORIZATION_SESSION_MS,
    ));
    const sessionSecretRef = request.session
      ? await stores.secret.put(scope, {
          bytes: request.session,
          purpose: "authorization-session",
          expiresAt,
        })
      : null;
    try {
      await stores.connection.createAuthorizationSession(scope, {
        id: createId(),
        category,
        integrationId: id,
        provider: adapter.provider,
        stateHash: sha256(state),
        callbackUrl,
        returnTo,
        scopes,
        sessionSecretRef,
        expiresAt,
        createdAt: now,
      });
    } catch (error) {
      if (sessionSecretRef) await stores.secret.delete(scope, sessionSecretRef).catch(() => undefined);
      throw error;
    }
    return { status: "authorization-required", url: request.url, expiresAt };
  }

  async disconnect(
    scope: UserScope,
    category: IntegrationCategory,
    integrationId: string,
    connectionId?: string,
    signal?: AbortSignal,
  ): Promise<DisconnectIntegrationResult> {
    const adapter = this.#adapter(category, integrationId);
    const stores = this.#stores();
    const connection = await this.#selectConnection(scope, category, integrationId, connectionId);
    const secret = connection.secretRef
      ? await stores.secret.get(scope, connection.secretRef)
      : null;
    let providerRevoked = false;
    if (secret && adapter.connection.revokeCredential) {
      try {
        await adapter.connection.revokeCredential({
          secret,
          expiresAt: connection.expiresAt,
          scopes: connection.scopes,
        }, { ...scope, ...(signal ? { signal } : {}) });
        providerRevoked = true;
      } catch {
        providerRevoked = false;
      }
    }
    const updated = await stores.connection.updateConnection(scope, connection.id, {
      status: "revoked",
      secretRef: null,
      scopes: connection.scopes,
      expiresAt: connection.expiresAt,
      now: new Date(),
    });
    if (connection.secretRef) {
      await stores.secret.delete(scope, connection.secretRef).catch(() => undefined);
    }
    return { connection: publicConnection(updated), providerRevoked };
  }

  async operationContext(
    scope: UserScope,
    category: IntegrationCategory,
    integrationId: string,
    connectionId?: string,
    signal?: AbortSignal,
  ): Promise<IntegrationOperationContext> {
    const adapter = this.#adapter(category, integrationId);
    const stores = this.#stores();
    let connection = await this.#selectConnection(scope, category, integrationId, connectionId);
    if (connection.status !== "active" || !connection.secretRef) {
      throw new IntegrationConnectionRequiredError(category, integrationId);
    }
    let secret = await stores.secret.get(scope, connection.secretRef);
    if (!secret) {
      await stores.connection.updateConnection(scope, connection.id, {
        status: "authorization-required",
        secretRef: null,
        scopes: connection.scopes,
        expiresAt: connection.expiresAt,
        now: new Date(),
      });
      throw new IntegrationConnectionRequiredError(category, integrationId);
    }
    if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) {
      if (!adapter.connection.refreshCredential) {
        await stores.connection.updateConnection(scope, connection.id, {
          status: "authorization-required",
          secretRef: connection.secretRef,
          scopes: connection.scopes,
          expiresAt: connection.expiresAt,
          now: new Date(),
        });
        throw new IntegrationConnectionRequiredError(category, integrationId);
      }
      const refreshed = validateCredential(await adapter.connection.refreshCredential({
        secret,
        expiresAt: connection.expiresAt,
        scopes: connection.scopes,
      }, { ...scope, ...(signal ? { signal } : {}) }), adapter.provider);
      const nextSecretRef = await stores.secret.put(scope, {
        bytes: refreshed.secret,
        purpose: "integration-credential",
        expiresAt: null,
      });
      try {
        const previousSecretRef = connection.secretRef;
        connection = await stores.connection.updateConnection(scope, connection.id, {
          status: "active",
          secretRef: nextSecretRef,
          scopes: refreshed.scopes,
          expiresAt: refreshed.expiresAt,
          now: new Date(),
        });
        await stores.secret.delete(scope, previousSecretRef).catch(() => undefined);
        secret = refreshed.secret;
      } catch (error) {
        await stores.secret.delete(scope, nextSecretRef).catch(() => undefined);
        throw error;
      }
    }
    return {
      ...scope,
      connectionId: connection.id,
      externalAccount: connection.account,
      credential: new Uint8Array(secret),
      ...(signal ? { signal } : {}),
    };
  }

  #stores(): { connection: IntegrationConnectionStore; secret: SecretStore } {
    if (!this.#connectionStore || !this.#secretStore) {
      throw new ConfigurationError("No integration providers are configured.");
    }
    return { connection: this.#connectionStore, secret: this.#secretStore };
  }

  #adapter(category: IntegrationCategory, integrationId: string): AnyIntegration {
    const adapter = this.#config[category]?.[integrationId];
    if (!adapter) {
      throw new ConfigurationError(`Integration ${category}.${integrationId} is not configured.`);
    }
    return adapter;
  }

  async #selectConnection(
    scope: UserScope,
    category: IntegrationCategory,
    integrationId: string,
    connectionId?: string,
  ): Promise<StoredIntegrationConnection> {
    if (connectionId) {
      const record = await this.#stores().connection.getConnection(
        scope,
        assertIdentifier(connectionId, "Connection id"),
      );
      if (!record || record.category !== category || record.integrationId !== integrationId) {
        throw new NotFoundError("Integration connection");
      }
      return record;
    }
    const records = await this.#stores().connection.listConnections(scope, category, integrationId);
    const active = records.filter((record) => record.status === "active");
    if (active.length === 0) throw new IntegrationConnectionRequiredError(category, integrationId);
    if (active.length > 1) {
      throw new ConfigurationError(
        `Integration ${category}.${integrationId} has multiple active connections; pass connectionId.`,
      );
    }
    return active[0]!;
  }
}

export class ScopedIntegrations {
  readonly repository: ScopedRepositoryIntegrations;
  readonly deployment: ScopedDeploymentIntegrations;

  constructor(client: IntegrationClient, scope: UserScope) {
    this.repository = new ScopedRepositoryIntegrations(client, scope);
    this.deployment = new ScopedDeploymentIntegrations(client, scope);
  }
}

export class ScopedIntegrationCategory {
  readonly #client: IntegrationClient;
  readonly #scope: UserScope;
  readonly #category: IntegrationCategory;

  constructor(client: IntegrationClient, scope: UserScope, category: IntegrationCategory) {
    this.#client = client;
    this.#scope = scope;
    this.#category = category;
  }

  async list(): Promise<readonly ConfiguredIntegrationStatus[]> {
    return this.#client.statuses(this.#scope, this.#category);
  }

  connections(integrationId?: string): Promise<readonly IntegrationConnectionData[]> {
    return this.#client.connections(this.#scope, this.#category, integrationId);
  }

  connect(integrationId: string, input: ConnectIntegrationInput): Promise<ConnectIntegrationResult> {
    return this.#client.connect(this.#scope, this.#category, integrationId, input);
  }

  disconnect(
    integrationId: string,
    options: { readonly connectionId?: string; readonly signal?: AbortSignal } = {},
  ): Promise<DisconnectIntegrationResult> {
    return this.#client.disconnect(
      this.#scope,
      this.#category,
      integrationId,
      options.connectionId,
      options.signal,
    );
  }
}

function publicConnection(connection: StoredIntegrationConnection): IntegrationConnectionData {
  const { secretRef: _secretRef, ...data } = connection;
  return data;
}

function validateAuthorizationRequest(
  value: Awaited<ReturnType<AnyIntegration["connection"]["startAuthorization"]>>,
  state: string,
  provider: string,
) {
  if (!value || typeof value !== "object") {
    throw new ConfigurationError(`${provider} returned an invalid authorization request.`);
  }
  const url = normalizeHttpUrl(value.url, `${provider} authorization URL`);
  if (new URL(url).searchParams.get("state") !== state) {
    throw new ConfigurationError(`${provider} authorization URL did not preserve the Viby state.`);
  }
  if (value.expiresAt !== null && !(value.expiresAt instanceof Date)) {
    throw new ConfigurationError(`${provider} returned an invalid authorization expiry.`);
  }
  if (value.session !== undefined && (!(value.session instanceof Uint8Array)
    || value.session.byteLength === 0 || value.session.byteLength > 64_000)) {
    throw new ConfigurationError(`${provider} returned an invalid authorization session secret.`);
  }
  return { ...value, url };
}

function validateAuthorizationResult(
  value: Awaited<ReturnType<AnyIntegration["connection"]["completeAuthorization"]>>,
  provider: string,
) {
  if (!value || typeof value !== "object" || !value.account || !value.credential) {
    throw new ConfigurationError(`${provider} returned an invalid authorization result.`);
  }
  const id = assertIdentifier(value.account.id, `${provider} external account id`);
  const name = assertIdentifier(value.account.name, `${provider} external account name`);
  const credential = validateCredential(value.credential, provider);
  return {
    account: {
      id,
      name,
      ...(value.account.url ? { url: normalizeHttpUrl(value.account.url, `${provider} account URL`) } : {}),
      ...(value.account.metadata ? { metadata: value.account.metadata } : {}),
    },
    credential,
  };
}

function validateCredential(value: IntegrationCredential, provider: string): IntegrationCredential {
  if (!value || !(value.secret instanceof Uint8Array)
    || value.secret.byteLength === 0 || value.secret.byteLength > 64_000) {
    throw new ConfigurationError(`${provider} returned an invalid credential secret.`);
  }
  if (value.expiresAt !== null && !(value.expiresAt instanceof Date)) {
    throw new ConfigurationError(`${provider} returned an invalid credential expiry.`);
  }
  return {
    secret: new Uint8Array(value.secret),
    expiresAt: value.expiresAt,
    scopes: normalizeScopes(value.scopes),
  };
}

function normalizeScopes(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 100) {
    throw new ConfigurationError("Integration scopes must be an array of at most 100 strings.");
  }
  const scopes = value.map((scope) => assertIdentifier(scope, "Integration scope"));
  return Object.freeze([...new Set(scopes)].sort());
}

function normalizeHttpUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfigurationError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ConfigurationError(`${label} must be an absolute HTTP(S) URL.`);
  }
  if (url.username || url.password || url.hash) {
    throw new ConfigurationError(`${label} cannot contain credentials or a fragment.`);
  }
  return url.href;
}

function normalizeReturnTo(value: string, callbackUrl: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.startsWith("/") && !normalized.startsWith("//") && normalized.length <= 2_000) {
    return normalized;
  }
  const absolute = normalizeHttpUrl(normalized, "Integration returnTo");
  if (new URL(absolute).origin !== new URL(callbackUrl).origin) {
    throw new ConfigurationError("Integration returnTo must be relative or share the callback origin.");
  }
  return absolute;
}

function assertMatchingCallback(expected: string, actual: string): void {
  const expectedUrl = new URL(expected);
  const actualUrl = new URL(actual);
  if (expectedUrl.origin !== actualUrl.origin || expectedUrl.pathname !== actualUrl.pathname) {
    throw new IntegrationAuthorizationError(
      "The integration callback does not match the authorization session callback URL.",
    );
  }
}
