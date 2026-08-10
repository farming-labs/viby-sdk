import {
  normalizeArtifactStoreId,
  type ArtifactStore,
  type ArtifactStoreContext,
} from "./artifact-store.js";
import { ConfigurationError } from "./errors.js";
import { sha256 } from "./utils.js";

export interface ArtifactStoreConformanceInput {
  readonly store: ArtifactStore;
  readonly context: ArtifactStoreContext;
  readonly key?: string;
}

export interface ArtifactStoreConformanceReport {
  readonly store: string;
  readonly checks: readonly (
    | "identity"
    | "missing-read"
    | "byte-roundtrip"
    | "defensive-read"
    | "idempotent-delete"
  )[];
}

/** Runs the portable byte lifecycle contract against a caller-owned store fixture. */
export async function verifyArtifactStore(
  input: ArtifactStoreConformanceInput,
): Promise<ArtifactStoreConformanceReport> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Artifact store conformance input is required.");
  }
  const store = normalizeArtifactStoreId(input.store?.id);
  if (
    typeof input.store?.put !== "function"
    || typeof input.store?.get !== "function"
    || typeof input.store?.delete !== "function"
  ) {
    throw new ConfigurationError("A conforming artifact store must implement put, get, and delete.");
  }
  const key = input.key ?? `conformance/${crypto.randomUUID()}.bin`;
  const bytes = new Uint8Array([0, 1, 2, 127, 128, 254, 255]);
  const checks: ArtifactStoreConformanceReport["checks"][number][] = ["identity"];

  await input.store.delete(key, input.context);
  if (await input.store.get(key, input.context) !== null) {
    throw new ArtifactStoreConformanceError("Deleted or missing artifact did not return null.");
  }
  checks.push("missing-read");

  try {
    await input.store.put({
      key,
      bytes,
      mediaType: "application/octet-stream",
      checksum: sha256(bytes),
    }, input.context);
    bytes.fill(99);
    const stored = await input.store.get(key, input.context);
    if (!stored || !equalBytes(stored, new Uint8Array([0, 1, 2, 127, 128, 254, 255]))) {
      throw new ArtifactStoreConformanceError("Artifact store changed bytes during roundtrip.");
    }
    checks.push("byte-roundtrip");
    stored.fill(42);
    const reread = await input.store.get(key, input.context);
    if (!reread || reread[0] !== 0) {
      throw new ArtifactStoreConformanceError("Artifact store returned mutable shared bytes.");
    }
    checks.push("defensive-read");
  } finally {
    await input.store.delete(key, input.context);
    await input.store.delete(key, input.context);
  }
  checks.push("idempotent-delete");
  return Object.freeze({ store, checks: Object.freeze(checks) });
}

export class ArtifactStoreConformanceError extends Error {
  override readonly name = "ArtifactStoreConformanceError";
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
