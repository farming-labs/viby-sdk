import { randomUUID } from "node:crypto";
import type {
  IntegrationConnectionStore,
  SecretStore,
} from "./integration-store.js";

export class IntegrationStoreConformanceError extends Error {
  readonly check: string;

  constructor(check: string, message: string, options?: ErrorOptions) {
    super(`Integration store conformance failed at ${check}: ${message}`, options);
    this.name = "IntegrationStoreConformanceError";
    this.check = check;
  }
}

export interface VerifyIntegrationStoresOptions {
  readonly create: () => Promise<{
    readonly connectionStore: IntegrationConnectionStore;
    readonly secretStore: SecretStore;
  }> | {
    readonly connectionStore: IntegrationConnectionStore;
    readonly secretStore: SecretStore;
  };
}

export interface IntegrationStoreConformanceReport {
  readonly checks: readonly string[];
}

export async function verifyIntegrationStores(
  options: VerifyIntegrationStoresOptions,
): Promise<IntegrationStoreConformanceReport> {
  const created = await options.create();
  const { connectionStore, secretStore } = created;
  const checks: string[] = [];
  const scope = {
    tenantId: `conformance-${randomUUID()}`,
    userId: `conformance-${randomUUID()}`,
  };
  const otherScope = { tenantId: `${scope.tenantId}-other`, userId: scope.userId };
  try {
    const original = new Uint8Array([1, 2, 3, 4]);
    const secretRef = await secretStore.put(scope, {
      bytes: original,
      purpose: "integration-credential",
      expiresAt: null,
    });
    original.fill(0);
    const firstRead = await secretStore.get(scope, secretRef);
    assert(firstRead?.join(",") === "1,2,3,4", "secret-roundtrip", "secret bytes changed");
    firstRead.fill(9);
    assert(
      (await secretStore.get(scope, secretRef))?.join(",") === "1,2,3,4",
      "secret-defensive-read",
      "reads share mutable bytes",
    );
    assert(await secretStore.get(otherScope, secretRef) === null, "secret-isolation", "cross-tenant read succeeded");
    checks.push("secret-roundtrip", "secret-defensive-read", "secret-isolation");

    const sessionId = randomUUID();
    const stateHash = "a".repeat(64);
    const now = new Date();
    await connectionStore.createAuthorizationSession(scope, {
      id: sessionId,
      category: "repository",
      integrationId: "fixture",
      provider: "fixture",
      stateHash,
      callbackUrl: "https://app.example/integrations/callback",
      returnTo: "/project",
      scopes: ["contents:write"],
      sessionSecretRef: null,
      expiresAt: new Date(now.getTime() + 60_000),
      createdAt: now,
    });
    assert(await connectionStore.getAuthorizationSession(stateHash, now) !== null,
      "authorization-read", "authorization session was not readable");
    assert(await connectionStore.consumeAuthorizationSession(stateHash, now) !== null,
      "authorization-consume", "authorization session could not be consumed");
    assert(await connectionStore.consumeAuthorizationSession(stateHash, now) === null,
      "authorization-single-use", "authorization session was consumed twice");
    checks.push("authorization-read", "authorization-consume", "authorization-single-use");

    const connectionId = randomUUID();
    const saved = await connectionStore.upsertConnection(scope, {
      id: connectionId,
      category: "repository",
      integrationId: "fixture",
      provider: "fixture",
      account: { id: "account", name: "Fixture account" },
      secretRef,
      scopes: ["contents:write"],
      expiresAt: null,
      now,
    });
    assert(saved.connection.id === connectionId, "connection-upsert", "connection id changed");
    assert((await connectionStore.listConnections(scope)).length === 1,
      "connection-list", "connection was not listed");
    assert((await connectionStore.listConnections(otherScope)).length === 0,
      "connection-isolation", "connection crossed tenant scope");
    const revoked = await connectionStore.updateConnection(scope, connectionId, {
      status: "revoked",
      secretRef: null,
      scopes: saved.connection.scopes,
      expiresAt: null,
      now: new Date(now.getTime() + 1_000),
    });
    assert(revoked.status === "revoked" && revoked.secretRef === null,
      "connection-update", "connection was not revoked");
    checks.push("connection-upsert", "connection-list", "connection-isolation", "connection-update");

    await secretStore.delete(scope, secretRef);
    assert(await secretStore.get(scope, secretRef) === null, "secret-delete", "secret was not deleted");
    checks.push("secret-delete");
  } finally {
    const stores = [...new Set([connectionStore, secretStore])];
    await Promise.allSettled(stores.map((store) => store.close()));
  }
  return { checks: Object.freeze(checks) };
}

function assert(condition: boolean, check: string, message: string): asserts condition {
  if (!condition) throw new IntegrationStoreConformanceError(check, message);
}
