import { unzipSync } from "fflate";
import { ConfigurationError } from "./errors.js";
import type {
  ImportFilePolicy,
  ImportProjectSource,
  SourceArtifactInput,
  SourceEntryInput,
  SourceFileInput,
  VersionArtifact,
  VersionFile,
} from "./types.js";
import { createId, normalizeProjectPath, sha256 } from "./utils.js";

const MAX_ARCHIVE_BYTES = 50_000_000;
const MAX_PROJECT_FILES = 250;
const MAX_FILE_BYTES = 1_500_000;
const MAX_TEXT_PROJECT_BYTES = 12_000_000;
const MAX_ARTIFACT_BYTES = 25_000_000;
const MAX_PROJECT_BYTES = 100_000_000;
const MAX_PATH_LENGTH = 500;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;

export interface ImportedProjectArtifact extends VersionArtifact {
  readonly bytes: Uint8Array;
}

export interface ImportedProjectEntries {
  readonly files: readonly VersionFile[];
  readonly artifacts: readonly ImportedProjectArtifact[];
}

export function importProjectFiles(
  source: ImportProjectSource,
  policy: ImportFilePolicy | undefined = undefined,
): ImportedProjectEntries {
  const entries = source.type === "files"
    ? normalizeSourceEntries(source.files, "Imported")
    : importZipSource(source.bytes);
  return splitImportedEntries(applyImportFilePolicy(entries, policy));
}

function importZipSource(bytes: Uint8Array): Array<VersionFile | ImportedProjectArtifact> {
  if (!(bytes instanceof Uint8Array)) {
    throw new ConfigurationError("ZIP source bytes must be a Uint8Array.");
  }
  return importZipFiles(bytes);
}

function importZipFiles(bytes: Uint8Array): Array<VersionFile | ImportedProjectArtifact> {
  if (bytes.byteLength === 0) throw new ConfigurationError("An imported ZIP cannot be empty.");
  if (bytes.byteLength > MAX_ARCHIVE_BYTES) {
    throw new ConfigurationError(`An imported ZIP cannot exceed ${MAX_ARCHIVE_BYTES} bytes.`);
  }

  inspectZipDirectory(bytes);

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    throw new ConfigurationError("The imported ZIP is invalid or unsupported.", { cause: error });
  }

  const files: SourceEntryInput[] = [];
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    const mediaType = inferMediaType(path);
    const text = decodeSourceText(content, mediaType);
    files.push(text === null
      ? { type: "artifact", path, bytes: content, mediaType }
      : { path, content: text, mediaType });
  }
  return normalizeSourceEntries(files, "Imported");
}

export function normalizeSourceEntries(
  entries: readonly SourceEntryInput[],
  label: string,
): Array<VersionFile | ImportedProjectArtifact> {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new ConfigurationError(`${label} project must contain at least one source entry.`);
  }
  if (entries.length > MAX_PROJECT_FILES) {
    throw new ConfigurationError(`${label} project cannot exceed ${MAX_PROJECT_FILES} entries.`);
  }
  const paths = new Set<string>();
  const normalized: Array<VersionFile | ImportedProjectArtifact> = [];
  let textBytes = 0;
  let totalBytes = 0;
  for (const entry of entries) {
    if (!entry || typeof entry !== "object" || typeof entry.path !== "string") {
      throw new ConfigurationError("Imported entries require an object with a string path.");
    }
    if (entry.locked !== undefined && typeof entry.locked !== "boolean") {
      throw new ConfigurationError("Imported entry locked values must be booleans.");
    }
    const path = normalizeImportPath(entry.path, paths, label);
    const mediaType = normalizeMediaType(entry.mediaType, path);
    if (entry.type === "artifact") {
      normalized.push(normalizeArtifactInput(entry, path, mediaType));
      totalBytes += entry.bytes.byteLength;
    } else {
      if (entry.type !== undefined && entry.type !== "text") {
        throw new ConfigurationError(`Imported entry type is unsupported: ${String(entry.type)}`);
      }
      if (typeof entry.content !== "string") {
        throw new ConfigurationError("Imported text entries require string content values.");
      }
      const size = Buffer.byteLength(entry.content);
      if (size > MAX_FILE_BYTES) {
        throw new ConfigurationError(`Imported text file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
      }
      textBytes += size;
      totalBytes += size;
      normalized.push({
        path,
        content: entry.content,
        mediaType,
        size,
        checksum: sha256(entry.content),
        locked: entry.locked ?? false,
      });
    }
    if (textBytes > MAX_TEXT_PROJECT_BYTES) {
      throw new ConfigurationError(`${label} project text cannot exceed ${MAX_TEXT_PROJECT_BYTES} bytes.`);
    }
    if (totalBytes > MAX_PROJECT_BYTES) {
      throw new ConfigurationError(`${label} project cannot exceed ${MAX_PROJECT_BYTES} bytes.`);
    }
  }
  return normalized.sort((left, right) => left.path.localeCompare(right.path));
}

export function normalizeSourceFiles(
  files: readonly SourceFileInput[],
  label: string,
): VersionFile[] {
  return normalizeSourceEntries(files, label).map((entry) => {
    if ("type" in entry && entry.type === "artifact") {
      throw new ConfigurationError(`${label} source normalization produced an unexpected artifact.`);
    }
    return entry as VersionFile;
  });
}

function applyImportFilePolicy(
  files: readonly (VersionFile | ImportedProjectArtifact)[],
  policy: ImportFilePolicy | undefined,
): Array<VersionFile | ImportedProjectArtifact> {
  if (policy === undefined) return files.map((file) => ({ ...file }));
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new ConfigurationError("Import filePolicy must be an object when provided.");
  }
  if (policy.locked === undefined) return files.map((file) => ({ ...file }));
  if (policy.locked === "all") return files.map((file) => ({ ...file, locked: true }));
  if (!Array.isArray(policy.locked)) {
    throw new ConfigurationError('Import filePolicy.locked must be "all" or an array of paths.');
  }
  const locked = new Set<string>();
  for (const value of policy.locked) {
    if (typeof value !== "string") {
      throw new ConfigurationError("Every locked file path must be a string.");
    }
    const path = normalizeProjectPath(value);
    if (locked.has(path)) throw new ConfigurationError(`Locked file path is duplicated: ${path}`);
    locked.add(path);
  }
  const paths = new Set(files.map((file) => file.path));
  const missing = [...locked].find((path) => !paths.has(path));
  if (missing) throw new ConfigurationError(`Locked file was not found in the import: ${missing}`);
  return files.map((file) => ({ ...file, locked: file.locked || locked.has(file.path) }));
}

function inspectZipDirectory(bytes: Uint8Array): void {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const endOffset = findEndOfCentralDirectory(view);
  const disk = view.getUint16(endOffset + 4, true);
  const centralDisk = view.getUint16(endOffset + 6, true);
  const entriesOnDisk = view.getUint16(endOffset + 8, true);
  const entryCount = view.getUint16(endOffset + 10, true);
  const centralSize = view.getUint32(endOffset + 12, true);
  const centralOffset = view.getUint32(endOffset + 16, true);

  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    throw new ConfigurationError("Multi-disk ZIP archives are not supported.");
  }
  if (
    entryCount === ZIP64_SENTINEL_16
    || centralSize === ZIP64_SENTINEL_32
    || centralOffset === ZIP64_SENTINEL_32
  ) {
    throw new ConfigurationError("ZIP64 archives are not supported.");
  }
  if (entryCount > MAX_PROJECT_FILES) {
    throw new ConfigurationError(`An imported ZIP cannot exceed ${MAX_PROJECT_FILES} entries.`);
  }
  if (centralOffset + centralSize > endOffset || centralOffset > bytes.byteLength) {
    throw new ConfigurationError("The imported ZIP central directory is invalid.");
  }

  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.byteLength || view.getUint32(offset, true) !== ZIP_CENTRAL_DIRECTORY_SIGNATURE) {
      throw new ConfigurationError("The imported ZIP central directory is malformed.");
    }
    const flags = view.getUint16(offset + 8, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const externalAttributes = view.getUint32(offset + 38, true);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > bytes.byteLength) {
      throw new ConfigurationError("The imported ZIP contains a truncated entry.");
    }
    if ((flags & 1) !== 0) throw new ConfigurationError("Encrypted ZIP entries are not supported.");
    if (uncompressedSize === ZIP64_SENTINEL_32) {
      throw new ConfigurationError("ZIP64 entries are not supported.");
    }
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & UNIX_FILE_TYPE_MASK) === UNIX_SYMLINK) {
      throw new ConfigurationError("Symbolic links are not supported in imported ZIP archives.");
    }
    if (uncompressedSize > MAX_ARTIFACT_BYTES) {
      throw new ConfigurationError(`An imported ZIP entry cannot exceed ${MAX_ARTIFACT_BYTES} bytes.`);
    }
    totalBytes += uncompressedSize;
    if (totalBytes > MAX_PROJECT_BYTES) {
      throw new ConfigurationError(`An imported ZIP cannot expand beyond ${MAX_PROJECT_BYTES} bytes.`);
    }
    offset = end;
  }
}

function findEndOfCentralDirectory(view: DataView): number {
  const minimumOffset = Math.max(0, view.byteLength - 65_557);
  for (let offset = view.byteLength - 22; offset >= minimumOffset; offset -= 1) {
    if (view.getUint32(offset, true) === ZIP_END_SIGNATURE) return offset;
  }
  throw new ConfigurationError("The imported data is not a valid ZIP archive.");
}

function inferMediaType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (path.endsWith(".png")) return "image/png";
  if (/\.jpe?g$/.test(path)) return "image/jpeg";
  if (path.endsWith(".gif")) return "image/gif";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".ico")) return "image/x-icon";
  if (path.endsWith(".woff")) return "font/woff";
  if (path.endsWith(".woff2")) return "font/woff2";
  if (path.endsWith(".ttf")) return "font/ttf";
  if (path.endsWith(".otf")) return "font/otf";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".mp4")) return "video/mp4";
  if (path.endsWith(".webm")) return "video/webm";
  if (path.endsWith(".pdf")) return "application/pdf";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(path)) return "text/javascript";
  if (/\.(?:md|mdx|txt|yaml|yml|toml)$/.test(path)) return "text/plain";
  return "application/octet-stream";
}

function normalizeImportPath(pathValue: string, paths: Set<string>, label: string): string {
  const path = normalizeProjectPath(pathValue);
  if (path.length > MAX_PATH_LENGTH) {
    throw new ConfigurationError(`Imported entry path exceeds ${MAX_PATH_LENGTH} characters: ${path}`);
  }
  if (paths.has(path)) throw new ConfigurationError(`${label} project has duplicate path: ${path}`);
  paths.add(path);
  return path;
}

function normalizeMediaType(value: string | undefined, path: string): string {
  const mediaType = value?.trim() || inferMediaType(path);
  if (mediaType.length < 3 || mediaType.length > 200) {
    throw new ConfigurationError(`Imported entry media type must contain 3-200 characters: ${path}`);
  }
  return mediaType;
}

function normalizeArtifactInput(
  entry: SourceArtifactInput,
  path: string,
  mediaType: string,
): ImportedProjectArtifact {
  if (!(entry.bytes instanceof Uint8Array) || entry.bytes.byteLength === 0) {
    throw new ConfigurationError(`Imported artifact must contain Uint8Array bytes: ${path}`);
  }
  if (entry.bytes.byteLength > MAX_ARTIFACT_BYTES) {
    throw new ConfigurationError(`Imported artifact exceeds ${MAX_ARTIFACT_BYTES} bytes: ${path}`);
  }
  const bytes = Uint8Array.from(entry.bytes);
  return {
    type: "artifact",
    path,
    artifactId: createId(),
    mediaType,
    size: bytes.byteLength,
    checksum: sha256(bytes),
    locked: entry.locked ?? false,
    bytes,
  };
}

function decodeSourceText(bytes: Uint8Array, mediaType: string): string | null {
  if (!isTextMediaType(mediaType) && mediaType !== "application/octet-stream") return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (mediaType === "application/octet-stream" && /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) {
      return null;
    }
    return text;
  } catch (error) {
    if (mediaType !== "application/octet-stream") {
      throw new ConfigurationError("Imported ZIP contains invalid UTF-8 text content.", { cause: error });
    }
    return null;
  }
}

function isTextMediaType(mediaType: string): boolean {
  return mediaType.startsWith("text/")
    || mediaType === "application/json"
    || mediaType.includes("javascript")
    || mediaType.includes("xml")
    || mediaType === "image/svg+xml";
}

function splitImportedEntries(
  entries: readonly (VersionFile | ImportedProjectArtifact)[],
): ImportedProjectEntries {
  return {
    files: entries.filter((entry): entry is VersionFile => !("type" in entry)),
    artifacts: entries.filter((entry): entry is ImportedProjectArtifact => (
      "type" in entry && entry.type === "artifact"
    )),
  };
}
