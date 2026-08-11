import type {
  CreateIntegrationAuthorizationSessionRecord,
  IntegrationAuthorizationSessionData,
  IntegrationConnectionStore,
  SecretStore,
  SecretStorePutInput,
  StoredIntegrationConnection,
  UpdateIntegrationConnectionRecord,
  UpsertIntegrationConnectionRecord,
  UpsertIntegrationConnectionResult,
} from "../../src/integration-store.js";
import type { IntegrationCategory } from "../../src/integrations.js";
import type { UserScope } from "../../src/types.js";
import { createId } from "../../src/utils.js";

interface ScopedSession {
  readonly scope: UserScope;
  session: IntegrationAuthorizationSessionData;
}

export class MemoryIntegrationConnectionStore implements IntegrationConnectionStore {
  readonly authorizationSessions = new Map<string, ScopedSession>();
  readonly connections = new Map<string, { scope: UserScope; connection: StoredIntegrationConnection }>();

  async createAuthorizationSession(scope: UserScope, input: CreateIntegrationAuthorizationSessionRecord) {
    const session: IntegrationAuthorizationSessionData = { ...input, consumedAt: null };
    this.authorizationSessions.set(input.stateHash, { scope: { ...scope }, session });
    return session;
  }

  async consumeAuthorizationSession(stateHash: string, consumedAt: Date) {
    const stored = this.authorizationSessions.get(stateHash);
    if (!stored || stored.session.consumedAt || stored.session.expiresAt <= consumedAt) return null;
    stored.session = { ...stored.session, consumedAt };
    return { scope: { ...stored.scope }, session: stored.session };
  }

  async getAuthorizationSession(stateHash: string, now: Date) {
    const stored = this.authorizationSessions.get(stateHash);
    if (!stored || stored.session.consumedAt || stored.session.expiresAt <= now) return null;
    return { scope: { ...stored.scope }, session: stored.session };
  }

  async listConnections(
    scope: UserScope,
    category?: IntegrationCategory,
    integrationId?: string,
  ) {
    return [...this.connections.values()]
      .filter((stored) => sameScope(stored.scope, scope)
        && (category === undefined || stored.connection.category === category)
        && (integrationId === undefined || stored.connection.integrationId === integrationId))
      .map((stored) => cloneConnection(stored.connection))
      .sort((left, right) => right.updatedAt.getTime() - left.updatedAt.getTime());
  }

  async getConnection(scope: UserScope, id: string) {
    const stored = this.connections.get(id);
    return stored && sameScope(stored.scope, scope) ? cloneConnection(stored.connection) : null;
  }

  async upsertConnection(
    scope: UserScope,
    input: UpsertIntegrationConnectionRecord,
  ): Promise<UpsertIntegrationConnectionResult> {
    const existing = [...this.connections.values()].find((stored) => sameScope(stored.scope, scope)
      && stored.connection.category === input.category
      && stored.connection.integrationId === input.integrationId
      && stored.connection.account.id === input.account.id);
    const connection: StoredIntegrationConnection = {
      id: existing?.connection.id ?? input.id,
      category: input.category,
      integrationId: input.integrationId,
      provider: input.provider,
      account: input.account,
      secretRef: input.secretRef,
      status: "active",
      scopes: [...input.scopes],
      expiresAt: input.expiresAt,
      createdAt: existing?.connection.createdAt ?? input.now,
      updatedAt: input.now,
    };
    this.connections.set(connection.id, { scope: { ...scope }, connection });
    return {
      connection: cloneConnection(connection),
      replacedSecretRef: existing?.connection.secretRef ?? null,
    };
  }

  async updateConnection(
    scope: UserScope,
    id: string,
    input: UpdateIntegrationConnectionRecord,
  ) {
    const stored = this.connections.get(id);
    if (!stored || !sameScope(stored.scope, scope)) throw new Error("Connection not found");
    stored.connection = {
      ...stored.connection,
      status: input.status,
      secretRef: input.secretRef,
      scopes: [...input.scopes],
      expiresAt: input.expiresAt,
      updatedAt: input.now,
    };
    return cloneConnection(stored.connection);
  }

  async close() {}
}

export class MemorySecretStore implements SecretStore {
  readonly secrets = new Map<string, { scope: UserScope; input: SecretStorePutInput }>();

  async put(scope: UserScope, input: SecretStorePutInput) {
    const reference = createId();
    this.secrets.set(reference, {
      scope: { ...scope },
      input: { ...input, bytes: new Uint8Array(input.bytes) },
    });
    return reference;
  }

  async get(scope: UserScope, reference: string) {
    const stored = this.secrets.get(reference);
    if (!stored || !sameScope(stored.scope, scope)) return null;
    if (stored.input.expiresAt && stored.input.expiresAt <= new Date()) return null;
    return new Uint8Array(stored.input.bytes);
  }

  async delete(scope: UserScope, reference: string) {
    const stored = this.secrets.get(reference);
    if (stored && sameScope(stored.scope, scope)) this.secrets.delete(reference);
  }

  async close() {
    for (const stored of this.secrets.values()) stored.input.bytes.fill(0);
    this.secrets.clear();
  }
}

function sameScope(left: UserScope, right: UserScope): boolean {
  return left.tenantId === right.tenantId && left.userId === right.userId;
}

function cloneConnection(connection: StoredIntegrationConnection): StoredIntegrationConnection {
  return {
    ...connection,
    account: {
      ...connection.account,
      ...(connection.account.metadata ? { metadata: { ...connection.account.metadata } } : {}),
    },
    scopes: [...connection.scopes],
  };
}
