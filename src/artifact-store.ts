import { ConfigurationError } from "./errors.js";
import type { UserScope } from "./types.js";

export interface ArtifactReference {
  /** Stable identifier of the configured store that owns the bytes. */
  readonly store: string;
  /** Opaque store-local key. It is not a public URL. */
  readonly key: string;
}

export type ArtifactKind =
  | "attachment"
  | "generated"
  | "project"
  | "screenshot"
  | "deployment"
  | (string & {});

export interface ArtifactStoreContext extends UserScope {
  readonly kind: ArtifactKind;
  readonly ownerId: string;
}

export interface ArtifactStorePutInput {
  readonly key: string;
  readonly bytes: Uint8Array;
  readonly mediaType: string;
  readonly checksum: string;
  readonly signal?: AbortSignal;
}

export interface ArtifactStoreReadOptions {
  readonly signal?: AbortSignal;
}

/** Provider-neutral byte storage. Durable metadata remains in the persistence adapter. */
export interface ArtifactStore {
  readonly id: string;
  put(input: ArtifactStorePutInput, context: ArtifactStoreContext): Promise<void>;
  get(
    key: string,
    context: ArtifactStoreContext,
    options?: ArtifactStoreReadOptions,
  ): Promise<Uint8Array | null>;
  delete(
    key: string,
    context: ArtifactStoreContext,
    options?: ArtifactStoreReadOptions,
  ): Promise<void>;
}

export function normalizeArtifactStoreId(value: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError("Artifact store id must be a string.");
  }
  const id = value.trim();
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new ConfigurationError(
      "Artifact store id must contain 1-100 letters, numbers, dots, underscores, or hyphens.",
    );
  }
  if (id === "postgres-legacy") {
    throw new ConfigurationError("Artifact store id postgres-legacy is reserved by Viby.");
  }
  return id;
}

export function normalizeArtifactKey(value: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError("Artifact key must be a string.");
  }
  const key = value.trim();
  if (
    key.length === 0
    || key.length > 1_000
    || key.startsWith("/")
    || key.startsWith("\\")
    || key.includes("\\")
    || key.includes("\0")
    || key.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new ConfigurationError("Artifact key must be a safe relative slash-separated path.");
  }
  return key;
}
