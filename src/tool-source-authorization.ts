import { randomBytes } from "node:crypto";
import {
  ConfigurationError,
  NotFoundError,
  ToolSourceAuthorizationError,
  ToolSourceConnectionRequiredError,
} from "./errors.js";
import type {
  IntegrationConnectionStatus,
  SecretStore,
} from "./integration-store.js";
import type {
  IntegrationAuthorizationCompleteInput,
  IntegrationAuthorizationRequest,
  IntegrationAuthorizationResult,
  IntegrationAuthorizationStartInput,
  IntegrationCredential,
  IntegrationExternalAccount,
} from "./integrations.js";
import type {
  ToolSourceAdapter,
  ToolSourceRegistrationData,
} from "./tool-source-registry.js";
import type { UserScope } from "./types.js";
import { assertIdentifier, createId, sha256 } from "./utils.js";

const AUTHORIZATION_SESSION_MS = 10 * 60 * 1_000;

export interface ToolSourceAuthorizationContext extends UserScope {
  readonly source: ToolSourceRegistrationData;
  readonly signal?: AbortSignal;
}

export interface ToolSourceAuthorizationAdapter {
  readonly provider: string;
  startAuthorization(
    input: IntegrationAuthorizationStartInput,
    context: ToolSourceAuthorizationContext,
  ): Promise<IntegrationAuthorizationRequest>;
  completeAuthorization(
    input: IntegrationAuthorizationCompleteInput,
    context: ToolSourceAuthorizationContext,
  ): Promise<IntegrationAuthorizationResult>;
  refreshCredential?(
    credential: IntegrationCredential,
    context: ToolSourceAuthorizationContext,
  ): Promise<IntegrationCredential>;
  revokeCredential?(
    credential: IntegrationCredential,
    context: ToolSourceAuthorizationContext,
  ): Promise<void>;
}

export interface ToolSourceConnectionData {
  readonly id: string;
  readonly toolSourceId: string;
  readonly provider: string;
  readonly account: IntegrationExternalAccount;
  readonly status: IntegrationConnectionStatus;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredToolSourceConnection extends ToolSourceConnectionData {
  readonly secretRef: string | null;
}

export interface CreateToolSourceAuthorizationSessionRecord {
  readonly id: string;
  readonly toolSourceId: string;
  readonly provider: string;
  readonly stateHash: string;
  readonly callbackUrl: string;
  readonly returnTo: string;
  readonly scopes: readonly string[];
  readonly sessionSecretRef: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface ToolSourceAuthorizationSessionData
extends CreateToolSourceAuthorizationSessionRecord {
  readonly consumedAt: Date | null;
}

export interface UpsertToolSourceConnectionRecord {
  readonly id: string;
  readonly toolSourceId: string;
  readonly provider: string;
  readonly account: IntegrationExternalAccount;
  readonly secretRef: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly now: Date;
}

export interface UpdateToolSourceConnectionRecord {
  readonly status: IntegrationConnectionStatus;
  readonly secretRef: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly now: Date;
}

export interface ToolSourceAuthorizationStore {
  createToolSourceAuthorizationSession(
    scope: UserScope,
    input: CreateToolSourceAuthorizationSessionRecord,
  ): Promise<ToolSourceAuthorizationSessionData>;
  getToolSourceAuthorizationSession(
    stateHash: string,
    now: Date,
  ): Promise<{ readonly scope: UserScope; readonly session: ToolSourceAuthorizationSessionData } | null>;
  consumeToolSourceAuthorizationSession(
    stateHash: string,
    consumedAt: Date,
  ): Promise<{ readonly scope: UserScope; readonly session: ToolSourceAuthorizationSessionData } | null>;
  getToolSourceConnection(
    scope: UserScope,
    toolSourceId: string,
  ): Promise<StoredToolSourceConnection | null>;
  upsertToolSourceConnection(
    scope: UserScope,
    input: UpsertToolSourceConnectionRecord,
  ): Promise<{
    readonly connection: StoredToolSourceConnection;
    readonly replacedSecretRef: string | null;
  }>;
  updateToolSourceConnection(
    scope: UserScope,
    id: string,
    input: UpdateToolSourceConnectionRecord,
  ): Promise<StoredToolSourceConnection>;
}

export interface ConnectToolSourceInput {
  readonly callbackUrl: string;
  readonly returnTo: string;
  readonly scopes?: readonly string[];
  readonly force?: boolean;
  readonly signal?: AbortSignal;
}

export type ConnectToolSourceResult =
  | { readonly status: "connected"; readonly connection: ToolSourceConnectionData }
  | {
      readonly status: "authorization-required";
      readonly url: string;
      readonly expiresAt: Date;
    };

export interface CompleteToolSourceAuthorizationResult {
  readonly toolSourceId: string;
  readonly connection: ToolSourceConnectionData;
  readonly returnTo: string;
}

export interface DisconnectToolSourceResult {
  readonly connection: ToolSourceConnectionData;
  readonly providerRevoked: boolean;
}

export interface ToolSourceCredentialContext extends UserScope {
  readonly connectionId: string;
  readonly account: IntegrationExternalAccount;
  readonly credential: Uint8Array;
  readonly scopes: readonly string[];
  readonly signal?: AbortSignal;
}

type AuthorizationStore = ToolSourceAuthorizationStore & {
  getToolSourceRegistration(
    scope: UserScope,
    id: string,
  ): Promise<ToolSourceRegistrationData | null>;
};

export class ToolSourceAuthorizationManager {
  readonly #store: AuthorizationStore;
  readonly #secrets: SecretStore | null;
  readonly #adapter: (type: string) => ToolSourceAdapter;

  constructor(
    store: AuthorizationStore,
    secrets: SecretStore | null,
    adapter: (type: string) => ToolSourceAdapter,
  ) {
    this.#store = store;
    this.#secrets = secrets;
    this.#adapter = adapter;
  }

  async connection(scope: UserScope, sourceId: string): Promise<ToolSourceConnectionData | null> {
    const connection = await this.#store.getToolSourceConnection(scope, sourceId);
    return connection ? publicConnection(connection) : null;
  }

  async connect(
    scope: UserScope,
    sourceId: string,
    input: ConnectToolSourceInput,
  ): Promise<ConnectToolSourceResult> {
    const source = await this.#source(scope, sourceId);
    const authorization = this.#authorization(source);
    const secrets = this.#secretStore();
    const callbackUrl = normalizeHttpUrl(input.callbackUrl, "Tool source callback URL");
    const returnTo = normalizeReturnTo(input.returnTo, callbackUrl);
    const scopes = normalizeScopes(input.scopes);
    input.signal?.throwIfAborted();
    if (input.force !== true) {
      const existing = await this.#store.getToolSourceConnection(scope, source.id);
      if (existing?.status === "active") {
        try {
          await this.credential(scope, source.id, input.signal);
          const current = await this.#store.getToolSourceConnection(scope, source.id);
          if (current?.status === "active") {
            return { status: "connected", connection: publicConnection(current) };
          }
        } catch (error) {
          if (!(error instanceof ToolSourceConnectionRequiredError)) throw error;
        }
      }
    }

    const state = randomBytes(32).toString("base64url");
    const now = new Date();
    let request: IntegrationAuthorizationRequest;
    try {
      request = validateAuthorizationRequest(await authorization.startAuthorization({
        callbackUrl,
        state,
        ...(scopes.length > 0 ? { scopes } : {}),
        ...(input.signal ? { signal: input.signal } : {}),
      }, { ...scope, source, ...(input.signal ? { signal: input.signal } : {}) }), state,
      authorization.provider);
    } catch (error) {
      if (error instanceof ToolSourceAuthorizationError) throw error;
      throw new ToolSourceAuthorizationError(
        `Could not start authorization with ${authorization.provider}.`,
        authorization.provider,
        { cause: error },
      );
    }
    const expiresAt = new Date(Math.min(
      request.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY,
      now.getTime() + AUTHORIZATION_SESSION_MS,
    ));
    const sessionSecretRef = request.session
      ? await secrets.put(scope, {
          bytes: request.session,
          purpose: "tool-source-authorization-session",
          expiresAt,
        })
      : null;
    try {
      await this.#store.createToolSourceAuthorizationSession(scope, {
        id: createId(),
        toolSourceId: source.id,
        provider: authorization.provider,
        stateHash: sha256(state),
        callbackUrl,
        returnTo,
        scopes,
        sessionSecretRef,
        expiresAt,
        createdAt: now,
      });
    } catch (error) {
      if (sessionSecretRef) await secrets.delete(scope, sessionSecretRef).catch(() => undefined);
      throw error;
    }
    return { status: "authorization-required", url: request.url, expiresAt };
  }

  async callback(request: Request | string): Promise<CompleteToolSourceAuthorizationResult> {
    const callbackUrl = normalizeHttpUrl(
      typeof request === "string" ? request : request.url,
      "Tool source callback URL",
    );
    const state = new URL(callbackUrl).searchParams.get("state");
    if (!state || state.length > 1_000) {
      throw new ToolSourceAuthorizationError("The tool source callback contains no valid state.");
    }
    const now = new Date();
    const stateHash = sha256(state);
    const pending = await this.#store.getToolSourceAuthorizationSession(stateHash, now);
    if (!pending) {
      throw new ToolSourceAuthorizationError(
        "The tool source authorization session is missing, expired, or already consumed.",
      );
    }
    assertMatchingCallback(pending.session.callbackUrl, callbackUrl);
    const consumed = await this.#store.consumeToolSourceAuthorizationSession(stateHash, now);
    if (!consumed) {
      throw new ToolSourceAuthorizationError("The tool source authorization session was already consumed.");
    }
    const { scope, session } = consumed;
    const source = await this.#source(scope, session.toolSourceId);
    const authorization = this.#authorization(source);
    if (authorization.provider !== session.provider) {
      throw new ToolSourceAuthorizationError(
        "The configured tool source provider changed during authorization.",
        session.provider,
      );
    }
    const secrets = this.#secretStore();
    const adapterSession = session.sessionSecretRef
      ? await secrets.get(scope, session.sessionSecretRef)
      : undefined;
    if (session.sessionSecretRef && !adapterSession) {
      throw new ToolSourceAuthorizationError(
        "The tool source authorization session secret is unavailable.",
        session.provider,
      );
    }
    try {
      const result = validateAuthorizationResult(await authorization.completeAuthorization({
        callbackUrl,
        ...(adapterSession ? { session: adapterSession } : {}),
      }, { ...scope, source }), authorization.provider);
      const secretRef = await secrets.put(scope, {
        bytes: result.credential.secret,
        purpose: "tool-source-credential",
        expiresAt: null,
      });
      try {
        const saved = await this.#store.upsertToolSourceConnection(scope, {
          id: createId(),
          toolSourceId: source.id,
          provider: authorization.provider,
          account: result.account,
          secretRef,
          scopes: result.credential.scopes,
          expiresAt: result.credential.expiresAt,
          now,
        });
        if (saved.replacedSecretRef && saved.replacedSecretRef !== secretRef) {
          await secrets.delete(scope, saved.replacedSecretRef).catch(() => undefined);
        }
        return {
          toolSourceId: source.id,
          connection: publicConnection(saved.connection),
          returnTo: session.returnTo,
        };
      } catch (error) {
        await secrets.delete(scope, secretRef).catch(() => undefined);
        throw error;
      }
    } catch (error) {
      if (error instanceof ToolSourceAuthorizationError) throw error;
      throw new ToolSourceAuthorizationError(
        `Could not complete authorization with ${authorization.provider}.`,
        authorization.provider,
        { cause: error },
      );
    } finally {
      if (session.sessionSecretRef) {
        await secrets.delete(scope, session.sessionSecretRef).catch(() => undefined);
      }
    }
  }

  async disconnect(
    scope: UserScope,
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<DisconnectToolSourceResult> {
    const source = await this.#source(scope, sourceId);
    const authorization = this.#authorization(source);
    const connection = await this.#store.getToolSourceConnection(scope, source.id);
    if (!connection) throw new NotFoundError("Tool source connection");
    const secrets = this.#secretStore();
    const secret = connection.secretRef ? await secrets.get(scope, connection.secretRef) : null;
    let providerRevoked = false;
    if (secret && authorization.revokeCredential) {
      try {
        await authorization.revokeCredential({
          secret,
          expiresAt: connection.expiresAt,
          scopes: connection.scopes,
        }, { ...scope, source, ...(signal ? { signal } : {}) });
        providerRevoked = true;
      } catch {
        providerRevoked = false;
      }
    }
    const updated = await this.#store.updateToolSourceConnection(scope, connection.id, {
      status: "revoked",
      secretRef: null,
      scopes: connection.scopes,
      expiresAt: connection.expiresAt,
      now: new Date(),
    });
    if (connection.secretRef) await secrets.delete(scope, connection.secretRef).catch(() => undefined);
    return { connection: publicConnection(updated), providerRevoked };
  }

  async credential(
    scope: UserScope,
    sourceId: string,
    signal?: AbortSignal,
  ): Promise<ToolSourceCredentialContext> {
    const source = await this.#source(scope, sourceId);
    const authorization = this.#authorization(source);
    const secrets = this.#secretStore();
    let connection = await this.#store.getToolSourceConnection(scope, source.id);
    if (!connection || connection.status !== "active" || !connection.secretRef) {
      throw new ToolSourceConnectionRequiredError(source.id);
    }
    let secret = await secrets.get(scope, connection.secretRef);
    if (!secret) {
      await this.#store.updateToolSourceConnection(scope, connection.id, {
        status: "authorization-required",
        secretRef: null,
        scopes: connection.scopes,
        expiresAt: connection.expiresAt,
        now: new Date(),
      });
      throw new ToolSourceConnectionRequiredError(source.id);
    }
    if (connection.expiresAt && connection.expiresAt.getTime() <= Date.now()) {
      if (!authorization.refreshCredential) {
        await this.#store.updateToolSourceConnection(scope, connection.id, {
          status: "authorization-required",
          secretRef: connection.secretRef,
          scopes: connection.scopes,
          expiresAt: connection.expiresAt,
          now: new Date(),
        });
        throw new ToolSourceConnectionRequiredError(source.id);
      }
      const refreshed = validateCredential(await authorization.refreshCredential({
        secret,
        expiresAt: connection.expiresAt,
        scopes: connection.scopes,
      }, { ...scope, source, ...(signal ? { signal } : {}) }), authorization.provider);
      const nextSecretRef = await secrets.put(scope, {
        bytes: refreshed.secret,
        purpose: "tool-source-credential",
        expiresAt: null,
      });
      try {
        const previousSecretRef = connection.secretRef;
        connection = await this.#store.updateToolSourceConnection(scope, connection.id, {
          status: "active",
          secretRef: nextSecretRef,
          scopes: refreshed.scopes,
          expiresAt: refreshed.expiresAt,
          now: new Date(),
        });
        await secrets.delete(scope, previousSecretRef).catch(() => undefined);
        secret = refreshed.secret;
      } catch (error) {
        await secrets.delete(scope, nextSecretRef).catch(() => undefined);
        throw error;
      }
    }
    return {
      ...scope,
      connectionId: connection.id,
      account: connection.account,
      credential: new Uint8Array(secret),
      scopes: Object.freeze([...connection.scopes]),
      ...(signal ? { signal } : {}),
    };
  }

  #secretStore(): SecretStore {
    if (!this.#secrets) {
      throw new ConfigurationError("Authorized tool sources require storage.secrets.");
    }
    return this.#secrets;
  }

  async #source(scope: UserScope, id: string): Promise<ToolSourceRegistrationData> {
    const source = await this.#store.getToolSourceRegistration(scope, assertIdentifier(id, "Tool source id"));
    if (!source || source.status === "archived") throw new NotFoundError("Tool source");
    return source;
  }

  #authorization(source: ToolSourceRegistrationData): ToolSourceAuthorizationAdapter {
    const authorization = this.#adapter(source.type).authorization;
    if (!authorization) {
      throw new ConfigurationError(`Tool source type ${source.type} does not require authorization.`);
    }
    validateProvider(authorization.provider);
    return authorization;
  }
}

function publicConnection(connection: StoredToolSourceConnection): ToolSourceConnectionData {
  const { secretRef: _secretRef, ...data } = connection;
  return {
    ...data,
    account: { ...data.account },
    scopes: Object.freeze([...data.scopes]),
  };
}

function validateAuthorizationRequest(
  value: IntegrationAuthorizationRequest,
  state: string,
  provider: string,
): IntegrationAuthorizationRequest & { readonly url: string } {
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
  value: IntegrationAuthorizationResult,
  provider: string,
): IntegrationAuthorizationResult {
  if (!value || typeof value !== "object" || !value.account || !value.credential) {
    throw new ConfigurationError(`${provider} returned an invalid authorization result.`);
  }
  const id = assertIdentifier(value.account.id, `${provider} external account id`);
  const name = assertIdentifier(value.account.name, `${provider} external account name`);
  return {
    account: {
      id,
      name,
      ...(value.account.url
        ? { url: normalizeHttpUrl(value.account.url, `${provider} account URL`) }
        : {}),
      ...(value.account.metadata ? { metadata: value.account.metadata } : {}),
    },
    credential: validateCredential(value.credential, provider),
  };
}

function validateCredential(value: IntegrationCredential, provider: string): IntegrationCredential {
  if (!value || !(value.secret instanceof Uint8Array)
    || value.secret.byteLength === 0 || value.secret.byteLength > 1_000_000) {
    throw new ConfigurationError(`${provider} returned an invalid credential secret.`);
  }
  if (value.expiresAt !== null && !(value.expiresAt instanceof Date)) {
    throw new ConfigurationError(`${provider} returned an invalid credential expiry.`);
  }
  return {
    secret: new Uint8Array(value.secret),
    scopes: normalizeScopes(value.scopes),
    expiresAt: value.expiresAt,
  };
}

function normalizeHttpUrl(value: string, label: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
    if (url.username || url.password || url.hash) throw new Error("credentials");
    return url.toString();
  } catch (error) {
    throw new ConfigurationError(`${label} must be an HTTP or HTTPS URL without credentials.`, {
      cause: error,
    });
  }
}

function normalizeReturnTo(value: string, callbackUrl: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2_000) {
    throw new ConfigurationError("Tool source returnTo must contain 1 to 2000 characters.");
  }
  if (value.startsWith("/")) {
    if (value.startsWith("//") || value.includes("\\") || value.includes("\0")) {
      throw new ConfigurationError("Tool source returnTo must be a safe application-relative path.");
    }
    return value;
  }
  const normalized = normalizeHttpUrl(value, "Tool source returnTo");
  if (new URL(normalized).origin !== new URL(callbackUrl).origin) {
    throw new ConfigurationError("Tool source returnTo must use the callback application origin.");
  }
  return normalized;
}

function normalizeScopes(value: readonly string[] | undefined): readonly string[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 100) {
    throw new ConfigurationError("Tool source scopes must be an array of at most 100 values.");
  }
  const scopes = value.map((scope) => {
    const normalized = scope?.trim();
    if (!normalized || normalized.length > 200) {
      throw new ConfigurationError("Each tool source scope must contain 1 to 200 characters.");
    }
    return normalized;
  });
  return Object.freeze([...new Set(scopes)]);
}

function assertMatchingCallback(expected: string, actual: string): void {
  const expectedUrl = new URL(expected);
  const actualUrl = new URL(actual);
  if (expectedUrl.origin !== actualUrl.origin || expectedUrl.pathname !== actualUrl.pathname) {
    throw new ToolSourceAuthorizationError(
      "The tool source callback URL does not match the authorization session.",
    );
  }
}

function validateProvider(value: string): string {
  const provider = value?.trim();
  if (!provider || !/^[a-zA-Z0-9_.-]{1,80}$/.test(provider)) {
    throw new ConfigurationError("A tool source authorization provider requires a valid id.");
  }
  return provider;
}
