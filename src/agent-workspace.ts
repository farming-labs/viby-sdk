import { ConfigurationError } from "./errors.js";
import { applySourceChanges, normalizeSourceChanges } from "./source-changes.js";
import type { SourceChange, VersionFile } from "./types.js";
import { normalizeProjectPath } from "./utils.js";

const DEFAULT_SEARCH_LIMIT = 50;
const MAX_SEARCH_LIMIT = 200;
const MAX_SEARCH_QUERY_LENGTH = 500;

export interface AgentWorkspaceFile {
  readonly path: string;
  readonly mediaType: string;
  readonly size: number;
  readonly checksum: string;
  readonly locked: boolean;
}

export interface AgentWorkspaceSearchResult {
  readonly path: string;
  readonly line: number;
  readonly column: number;
  readonly preview: string;
}

export interface AgentWorkspaceCommitInput {
  readonly title?: string;
  readonly summary?: string;
}

export interface AgentWorkspaceTools {
  readonly listFiles: (input?: { readonly prefix?: string }) => Promise<readonly AgentWorkspaceFile[]>;
  readonly readFile: (input: { readonly path: string }) => Promise<VersionFile>;
  readonly search: (input: {
    readonly query: string;
    readonly prefix?: string;
    readonly caseSensitive?: boolean;
    readonly limit?: number;
  }) => Promise<readonly AgentWorkspaceSearchResult[]>;
  readonly writeFile: (input: {
    readonly path: string;
    readonly content: string;
    readonly mediaType?: string;
  }) => Promise<SourceChange>;
  readonly deleteFile: (input: { readonly path: string }) => Promise<SourceChange>;
  readonly moveFile: (input: {
    readonly from: string;
    readonly to: string;
  }) => Promise<SourceChange>;
}

export class AgentWorkspace<Result = unknown> {
  readonly tools: AgentWorkspaceTools;
  readonly #baseFiles: readonly VersionFile[];
  readonly #commit: (
    changes: readonly SourceChange[],
    input: AgentWorkspaceCommitInput,
  ) => Promise<Result>;
  #files: readonly VersionFile[];
  #changes: SourceChange[] = [];
  #committed = false;
  #commitPromise: Promise<Result> | null = null;

  constructor(
    files: readonly VersionFile[],
    commit: (
      changes: readonly SourceChange[],
      input: AgentWorkspaceCommitInput,
    ) => Promise<Result>,
  ) {
    this.#baseFiles = cloneFiles(files);
    this.#files = cloneFiles(files);
    this.#commit = commit;
    const tools: AgentWorkspaceTools = {
      listFiles: (input) => this.list(input),
      readFile: (input) => this.read(input),
      search: (input) => this.search(input),
      writeFile: (input) => this.write(input),
      deleteFile: (input) => this.delete(input),
      moveFile: (input) => this.move(input),
    };
    this.tools = Object.freeze(tools);
  }

  get committed(): boolean {
    return this.#committed;
  }

  async list(input: { readonly prefix?: string } = {}): Promise<readonly AgentWorkspaceFile[]> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Workspace list requires an input object when provided.");
    }
    const prefix = normalizePrefix(input.prefix);
    return this.#files
      .filter((file) => !prefix || file.path === prefix || file.path.startsWith(`${prefix}/`))
      .map(({ path, mediaType, size, checksum, locked }) => ({
        path,
        mediaType,
        size,
        checksum,
        locked,
      }));
  }

  async read(input: { readonly path: string }): Promise<VersionFile> {
    const path = normalizeWorkspacePath(input?.path, "read path");
    const file = this.#files.find((candidate) => candidate.path === path);
    if (!file) throw new ConfigurationError(`Workspace source file was not found: ${path}`);
    return { ...file };
  }

  async search(input: {
    readonly query: string;
    readonly prefix?: string;
    readonly caseSensitive?: boolean;
    readonly limit?: number;
  }): Promise<readonly AgentWorkspaceSearchResult[]> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Workspace search requires an input object.");
    }
    if (typeof input.query !== "string") {
      throw new ConfigurationError("Workspace search query must be a string.");
    }
    if (input.caseSensitive !== undefined && typeof input.caseSensitive !== "boolean") {
      throw new ConfigurationError("Workspace search caseSensitive must be a boolean.");
    }
    const query = input.query.trim();
    if (!query || query.length > MAX_SEARCH_QUERY_LENGTH) {
      throw new ConfigurationError(
        `Workspace search query must contain between 1 and ${MAX_SEARCH_QUERY_LENGTH} characters.`,
      );
    }
    const prefix = normalizePrefix(input.prefix);
    const limit = input.limit ?? DEFAULT_SEARCH_LIMIT;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new ConfigurationError(
        `Workspace search limit must be an integer between 1 and ${MAX_SEARCH_LIMIT}.`,
      );
    }
    const needle = input.caseSensitive ? query : query.toLocaleLowerCase();
    const results: AgentWorkspaceSearchResult[] = [];
    for (const file of this.#files) {
      if (prefix && file.path !== prefix && !file.path.startsWith(`${prefix}/`)) continue;
      for (const [index, line] of file.content.split("\n").entries()) {
        const haystack = input.caseSensitive ? line : line.toLocaleLowerCase();
        const column = haystack.indexOf(needle);
        if (column === -1) continue;
        results.push({
          path: file.path,
          line: index + 1,
          column: column + 1,
          preview: line.length <= 240 ? line : `${line.slice(0, 237)}...`,
        });
        if (results.length === limit) return results;
      }
    }
    return results;
  }

  async write(input: {
    readonly path: string;
    readonly content: string;
    readonly mediaType?: string;
  }): Promise<SourceChange> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Workspace write requires an input object.");
    }
    const mediaType = normalizeMediaType(input.mediaType);
    const change: SourceChange = {
      type: "write",
      path: normalizeWorkspacePath(input.path, "write path"),
      content: normalizeWorkspaceContent(input.content),
      ...(mediaType ? { mediaType } : {}),
    };
    return this.#stage(change);
  }

  async delete(input: { readonly path: string }): Promise<SourceChange> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Workspace delete requires an input object.");
    }
    return this.#stage({
      type: "delete",
      path: normalizeWorkspacePath(input.path, "delete path"),
    });
  }

  async move(input: { readonly from: string; readonly to: string }): Promise<SourceChange> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Workspace move requires an input object.");
    }
    return this.#stage({
      type: "move",
      from: normalizeWorkspacePath(input.from, "move source path"),
      to: normalizeWorkspacePath(input.to, "move target path"),
    });
  }

  changes(): readonly SourceChange[] {
    return this.#changes.map((change) => ({ ...change }));
  }

  files(): readonly VersionFile[] {
    return cloneFiles(this.#files);
  }

  async commit(input: AgentWorkspaceCommitInput = {}): Promise<Result> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("Workspace commit options must be an object when provided.");
    }
    if (this.#committed) throw new ConfigurationError("The agent workspace is already committed.");
    if (this.#changes.length === 0) {
      throw new ConfigurationError("The agent workspace has no source changes to commit.");
    }
    if (this.#commitPromise) return this.#commitPromise;
    const changes = this.changes();
    this.#commitPromise = this.#commit(changes, input)
      .then((result) => {
        this.#committed = true;
        return result;
      })
      .catch((error) => {
        this.#commitPromise = null;
        throw error;
      });
    return this.#commitPromise;
  }

  #stage(change: SourceChange): SourceChange {
    if (this.#committed || this.#commitPromise) {
      throw new ConfigurationError("The agent workspace cannot change while or after it commits.");
    }
    const changes = normalizeSourceChanges([...this.#changes, change]);
    this.#files = applySourceChanges(this.#baseFiles, changes);
    this.#changes = changes;
    return { ...changes[changes.length - 1]! };
  }
}

function normalizePrefix(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") {
    throw new ConfigurationError("Workspace path prefix must be a string.");
  }
  if (value.trim() === "") return "";
  return normalizeWorkspacePath(value.replace(/\/$/, ""), "path prefix");
}

function normalizeWorkspacePath(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`Workspace ${label} must be a string.`);
  }
  return normalizeProjectPath(value);
}

function normalizeWorkspaceContent(value: unknown): string {
  if (typeof value !== "string") {
    throw new ConfigurationError("Workspace write content must be a string.");
  }
  return value;
}

function normalizeMediaType(value: unknown): string | undefined {
  if (value === undefined || value === "") return undefined;
  if (typeof value !== "string") {
    throw new ConfigurationError("Workspace write mediaType must be a string when provided.");
  }
  return value.trim() || undefined;
}

function cloneFiles(files: readonly VersionFile[]): VersionFile[] {
  return files.map((file) => ({ ...file })).sort((left, right) => left.path.localeCompare(right.path));
}
