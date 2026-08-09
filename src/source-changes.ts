import { ConfigurationError } from "./errors.js";
import { normalizeSourceFiles } from "./project-import.js";
import type { SourceChange, VersionFile } from "./types.js";
import { normalizeProjectPath } from "./utils.js";

const MAX_SOURCE_CHANGES = 250;

export function applySourceChanges(
  baseFiles: readonly VersionFile[],
  changes: readonly SourceChange[],
): VersionFile[] {
  const normalizedChanges = normalizeSourceChanges(changes);
  const files = new Map(baseFiles.map((file) => [file.path, file]));
  for (const change of normalizedChanges) {
    switch (change.type) {
      case "write": {
        const current = files.get(change.path);
        assertUnlocked(current, change.path);
        files.set(change.path, {
          path: change.path,
          content: change.content,
          mediaType: change.mediaType || current?.mediaType || "",
          size: 0,
          checksum: "",
          locked: false,
        });
        break;
      }
      case "delete": {
        assertUnlocked(files.get(change.path), change.path);
        if (!files.delete(change.path)) {
          throw new ConfigurationError(`Cannot delete missing source file: ${change.path}`);
        }
        break;
      }
      case "move": {
        if (change.from === change.to) {
          throw new ConfigurationError(`Cannot move a source file onto itself: ${change.from}`);
        }
        const source = files.get(change.from);
        if (!source) throw new ConfigurationError(`Cannot move missing source file: ${change.from}`);
        assertUnlocked(source, change.from);
        if (files.has(change.to)) {
          throw new ConfigurationError(`Cannot overwrite source file during move: ${change.to}`);
        }
        files.delete(change.from);
        files.set(change.to, { ...source, path: change.to });
        break;
      }
    }
  }

  return normalizeSourceFiles([...files.values()], "Edited");
}

export function preserveLockedFiles(
  baseFiles: readonly VersionFile[],
  nextFiles: readonly VersionFile[],
): VersionFile[] {
  const locked = baseFiles.filter((file) => file.locked);
  if (locked.length === 0) return nextFiles.map((file) => ({ ...file }));
  const nextByPath = new Map(nextFiles.map((file) => [file.path, file]));
  for (const file of locked) {
    const next = nextByPath.get(file.path);
    if (!next || next.content !== file.content || next.mediaType !== file.mediaType) {
      throw new ConfigurationError(`Source file is locked: ${file.path}`);
    }
    nextByPath.set(file.path, { ...next, locked: true });
  }
  return [...nextByPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function assertUnlocked(file: VersionFile | undefined, path: string): void {
  if (file?.locked) throw new ConfigurationError(`Source file is locked: ${path}`);
}

export function normalizeSourceChanges(changes: readonly SourceChange[]): SourceChange[] {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ConfigurationError("A source change set must contain at least one change.");
  }
  if (changes.length > MAX_SOURCE_CHANGES) {
    throw new ConfigurationError(`A source change set cannot exceed ${MAX_SOURCE_CHANGES} changes.`);
  }

  return changes.map((change) => {
    if (!change || typeof change !== "object") {
      throw new ConfigurationError("Every source change must be a typed change object.");
    }
    switch (change.type) {
      case "write": {
        if (typeof change.content !== "string") {
          throw new ConfigurationError("A write change requires string content.");
        }
        return {
          type: "write",
          path: normalizeProjectPath(change.path),
          content: change.content,
          ...(change.mediaType?.trim() ? { mediaType: change.mediaType.trim() } : {}),
        };
      }
      case "delete": {
        return { type: "delete", path: normalizeProjectPath(change.path) };
      }
      case "move": {
        const from = normalizeProjectPath(change.from);
        const to = normalizeProjectPath(change.to);
        if (from === to) throw new ConfigurationError(`Cannot move a source file onto itself: ${from}`);
        return { type: "move", from, to };
      }
      default:
        throw new ConfigurationError("Source change type must be write, delete, or move.");
    }
  });
}
