import { ConfigurationError } from "./errors.js";
import { normalizeSourceFiles } from "./project-import.js";
import type {
  SourceChange,
  VersionArtifact,
  VersionEntry,
  VersionFile,
  VersionTextEntry,
} from "./types.js";
import { assertIdentifier, normalizeProjectPath } from "./utils.js";

const MAX_SOURCE_CHANGES = 250;

export function applySourceChanges(
  baseFiles: readonly VersionFile[],
  changes: readonly SourceChange[],
): VersionFile[] {
  return applyVersionEntryChanges(
    baseFiles.map((file): VersionTextEntry => ({ ...file, type: "text" })),
    changes,
  ).map((entry) => {
    if (entry.type === "artifact") {
      throw new ConfigurationError("Text source changes produced an unexpected artifact entry.");
    }
    const { type: _type, ...file } = entry;
    return file;
  });
}

export function applyVersionEntryChanges(
  baseFiles: readonly VersionEntry[],
  changes: readonly SourceChange[],
): VersionEntry[] {
  const normalizedChanges = normalizeSourceChanges(changes);
  const files = new Map(baseFiles.map((file) => [file.path, file]));
  for (const change of normalizedChanges) {
    switch (change.type) {
      case "write": {
        const current = files.get(change.path);
        assertUnlocked(current, change.path);
        files.set(change.path, {
          type: "text",
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

  return normalizeVersionEntries([...files.values()], "Edited");
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

export function preserveLockedEntries(
  baseEntries: readonly VersionEntry[],
  nextEntries: readonly VersionEntry[],
): VersionEntry[] {
  const locked = baseEntries.filter((entry) => entry.locked);
  const nextByPath = new Map(nextEntries.map((entry) => [entry.path, entry]));
  for (const entry of locked) {
    const next = nextByPath.get(entry.path);
    if (!next || !sameEntryContent(entry, next)) {
      throw new ConfigurationError(`Source file is locked: ${entry.path}`);
    }
    nextByPath.set(entry.path, { ...next, locked: true });
  }
  return normalizeVersionEntries([...nextByPath.values()], "Generated");
}

export function mergeGeneratedFilesWithArtifacts(
  previousEntries: readonly VersionEntry[],
  generatedFiles: readonly VersionFile[],
): VersionEntry[] {
  const generatedPaths = new Set(generatedFiles.map((file) => file.path));
  const assets = previousEntries.filter((entry): entry is VersionArtifact => (
    isVersionArtifact(entry) && !generatedPaths.has(entry.path)
  ));
  return preserveLockedEntries(previousEntries, [
    ...generatedFiles.map((file): VersionTextEntry => ({ ...file, type: "text" })),
    ...assets,
  ]);
}

export function normalizeVersionEntries(
  entries: readonly VersionEntry[],
  label: string,
): VersionEntry[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ConfigurationError(`${label} project must contain at least one source entry.`);
  }
  const artifacts: VersionArtifact[] = [];
  const text: VersionTextEntry[] = [];
  const paths = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") {
      throw new ConfigurationError(`${label} project entries must be objects.`);
    }
    const path = normalizeProjectPath(entry.path);
    if (paths.has(path)) throw new ConfigurationError(`${label} project has duplicate path: ${path}`);
    paths.add(path);
    if (isVersionArtifact(entry)) {
      if (
        typeof entry.mediaType !== "string"
        || entry.mediaType.trim().length < 3
        || entry.mediaType.length > 200
        || !Number.isInteger(entry.size)
        || entry.size < 1
        || entry.size > 25_000_000
        || !/^[a-f0-9]{64}$/.test(entry.checksum)
        || typeof entry.locked !== "boolean"
      ) {
        throw new ConfigurationError(`Artifact-backed source entry is invalid: ${path}`);
      }
      artifacts.push({
        type: "artifact",
        path,
        artifactId: assertIdentifier(entry.artifactId, "project artifact id"),
        mediaType: entry.mediaType.trim(),
        size: entry.size,
        checksum: entry.checksum,
        locked: entry.locked,
      });
    } else {
      text.push({ ...entry, type: "text", path });
    }
  }
  const normalizedText = text.length === 0
    ? []
    : normalizeSourceFiles(text, label).map((file): VersionTextEntry => ({ ...file, type: "text" }));
  return [...normalizedText, ...artifacts]
    .sort((left, right) => left.path.localeCompare(right.path));
}

function assertUnlocked(file: VersionEntry | undefined, path: string): void {
  if (file?.locked) throw new ConfigurationError(`Source file is locked: ${path}`);
}

export function isVersionArtifact(entry: VersionEntry): entry is VersionArtifact {
  return entry.type === "artifact";
}

function sameEntryContent(left: VersionEntry, right: VersionEntry): boolean {
  if (isVersionArtifact(left) || isVersionArtifact(right)) {
    return isVersionArtifact(left)
      && isVersionArtifact(right)
      && left.artifactId === right.artifactId
      && left.mediaType === right.mediaType
      && left.size === right.size
      && left.checksum === right.checksum;
  }
  return left.content === right.content && left.mediaType === right.mediaType;
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
