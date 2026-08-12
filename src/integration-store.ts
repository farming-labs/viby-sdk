import type {
  IntegrationCategory,
  IntegrationExternalAccount,
} from "./integrations.js";
import type { UserScope } from "./types.js";

export type IntegrationConnectionStatus =
  | "active"
  | "authorization-required"
  | "permission-upgrade-required"
  | "revoked";

export interface IntegrationConnectionData {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly integrationId: string;
  readonly provider: string;
  readonly account: IntegrationExternalAccount;
  readonly status: IntegrationConnectionStatus;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface StoredIntegrationConnection extends IntegrationConnectionData {
  readonly secretRef: string | null;
}

export interface CreateIntegrationAuthorizationSessionRecord {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly integrationId: string;
  readonly provider: string;
  readonly stateHash: string;
  readonly callbackUrl: string;
  readonly returnTo: string;
  readonly scopes: readonly string[];
  readonly sessionSecretRef: string | null;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export interface IntegrationAuthorizationSessionData
extends CreateIntegrationAuthorizationSessionRecord {
  readonly consumedAt: Date | null;
}

export interface UpsertIntegrationConnectionRecord {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly integrationId: string;
  readonly provider: string;
  readonly account: IntegrationExternalAccount;
  readonly secretRef: string;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly now: Date;
}

export interface UpsertIntegrationConnectionResult {
  readonly connection: StoredIntegrationConnection;
  readonly replacedSecretRef: string | null;
}

export interface UpdateIntegrationConnectionRecord {
  readonly status: IntegrationConnectionStatus;
  readonly secretRef: string | null;
  readonly scopes: readonly string[];
  readonly expiresAt: Date | null;
  readonly now: Date;
}

export interface IntegrationConnectionStore {
  createAuthorizationSession(
    scope: UserScope,
    input: CreateIntegrationAuthorizationSessionRecord,
  ): Promise<IntegrationAuthorizationSessionData>;
  getAuthorizationSession(
    stateHash: string,
    now: Date,
  ): Promise<{ readonly scope: UserScope; readonly session: IntegrationAuthorizationSessionData } | null>;
  consumeAuthorizationSession(
    stateHash: string,
    consumedAt: Date,
  ): Promise<{ readonly scope: UserScope; readonly session: IntegrationAuthorizationSessionData } | null>;
  listConnections(
    scope: UserScope,
    category?: IntegrationCategory,
    integrationId?: string,
  ): Promise<readonly StoredIntegrationConnection[]>;
  getConnection(scope: UserScope, id: string): Promise<StoredIntegrationConnection | null>;
  upsertConnection(
    scope: UserScope,
    input: UpsertIntegrationConnectionRecord,
  ): Promise<UpsertIntegrationConnectionResult>;
  updateConnection(
    scope: UserScope,
    id: string,
    input: UpdateIntegrationConnectionRecord,
  ): Promise<StoredIntegrationConnection>;
  close(): Promise<void>;
}

export interface SecretStorePutInput {
  readonly bytes: Uint8Array;
  readonly purpose: "authorization-session" | "integration-credential" | "environment-variable";
  readonly expiresAt: Date | null;
}

export interface SecretStore {
  put(scope: UserScope, input: SecretStorePutInput): Promise<string>;
  get(scope: UserScope, reference: string): Promise<Uint8Array | null>;
  delete(scope: UserScope, reference: string): Promise<void>;
  close(): Promise<void>;
}
