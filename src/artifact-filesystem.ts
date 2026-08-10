import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import {
  normalizeArtifactKey,
  normalizeArtifactStoreId,
  type ArtifactStore,
  type ArtifactStoreContext,
  type ArtifactStorePutInput,
  type ArtifactStoreReadOptions,
} from "./artifact-store.js";
import { ConfigurationError } from "./errors.js";

export interface FileSystemArtifactStoreOptions {
  readonly directory: string;
  readonly id?: string;
}

/** Reference store for durable local volumes and development environments. */
export class FileSystemArtifactStore implements ArtifactStore {
  readonly id: string;
  readonly #directory: string;

  constructor(options: FileSystemArtifactStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Filesystem artifact store options are required.");
    }
    if (typeof options.directory !== "string" || options.directory.trim().length === 0) {
      throw new ConfigurationError("Filesystem artifact store directory is required.");
    }
    this.id = normalizeArtifactStoreId(options.id ?? "filesystem");
    this.#directory = resolve(options.directory);
  }

  async put(input: ArtifactStorePutInput, _context: ArtifactStoreContext): Promise<void> {
    input.signal?.throwIfAborted();
    if (!(input.bytes instanceof Uint8Array)) {
      throw new ConfigurationError("Artifact bytes must be a Uint8Array.");
    }
    const path = this.#path(input.key);
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, input.bytes, { flag: "wx" });
      input.signal?.throwIfAborted();
      await rename(temporary, path);
    } finally {
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }

  async get(
    key: string,
    _context: ArtifactStoreContext,
    options: ArtifactStoreReadOptions = {},
  ): Promise<Uint8Array | null> {
    options.signal?.throwIfAborted();
    try {
      const bytes = await readFile(this.#path(key));
      options.signal?.throwIfAborted();
      return Uint8Array.from(bytes);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async delete(
    key: string,
    _context: ArtifactStoreContext,
    options: ArtifactStoreReadOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await unlink(this.#path(key)).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }

  #path(key: string): string {
    const normalized = normalizeArtifactKey(key);
    const path = resolve(this.#directory, ...normalized.split("/"));
    if (path !== this.#directory && !path.startsWith(`${this.#directory}${sep}`)) {
      throw new ConfigurationError("Artifact key escapes the filesystem store directory.");
    }
    return path;
  }
}

export function fileSystemArtifactStore(
  options: FileSystemArtifactStoreOptions,
): FileSystemArtifactStore {
  return new FileSystemArtifactStore(options);
}
