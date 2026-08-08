import { ConfigurationError } from "./errors.js";
import { normalizeSourceFiles } from "./project-import.js";
import type { SourceChange, VersionFile } from "./types.js";
import { normalizeProjectPath } from "./utils.js";

const MAX_SOURCE_CHANGES = 250;

export function applySourceChanges(
  baseFiles: readonly VersionFile[],
  changes: readonly SourceChange[],
): VersionFile[] {
  if (!Array.isArray(changes) || changes.length === 0) {
    throw new ConfigurationError("A source change set must contain at least one change.");
  }
  if (changes.length > MAX_SOURCE_CHANGES) {
    throw new ConfigurationError(`A source change set cannot exceed ${MAX_SOURCE_CHANGES} changes.`);
  }

  const files = new Map(baseFiles.map((file) => [file.path, file]));
  for (const change of changes) {
    if (!change || typeof change !== "object") {
      throw new ConfigurationError("Every source change must be a typed change object.");
    }
    switch (change.type) {
      case "write": {
        if (typeof change.content !== "string") {
          throw new ConfigurationError("A write change requires string content.");
        }
        const path = normalizeProjectPath(change.path);
        const current = files.get(path);
        files.set(path, {
          path,
          content: change.content,
          mediaType: change.mediaType?.trim() || current?.mediaType || "",
          size: 0,
          checksum: "",
        });
        break;
      }
      case "delete": {
        const path = normalizeProjectPath(change.path);
        if (!files.delete(path)) {
          throw new ConfigurationError(`Cannot delete missing source file: ${path}`);
        }
        break;
      }
      case "move": {
        const from = normalizeProjectPath(change.from);
        const to = normalizeProjectPath(change.to);
        if (from === to) throw new ConfigurationError(`Cannot move a source file onto itself: ${from}`);
        const source = files.get(from);
        if (!source) throw new ConfigurationError(`Cannot move missing source file: ${from}`);
        if (files.has(to)) throw new ConfigurationError(`Cannot overwrite source file during move: ${to}`);
        files.delete(from);
        files.set(to, { ...source, path: to });
        break;
      }
      default:
        throw new ConfigurationError("Source change type must be write, delete, or move.");
    }
  }

  return normalizeSourceFiles([...files.values()], "Edited");
}
