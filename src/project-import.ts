import { unzipSync } from "fflate";
import { ConfigurationError } from "./errors.js";
import type { ImportProjectSource, SourceFileInput, VersionFile } from "./types.js";
import { normalizeProjectPath, sha256 } from "./utils.js";

const MAX_ARCHIVE_BYTES = 12_000_000;
const MAX_PROJECT_FILES = 250;
const MAX_FILE_BYTES = 1_500_000;
const MAX_PROJECT_BYTES = 12_000_000;
const MAX_PATH_LENGTH = 500;
const ZIP_CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const ZIP_END_SIGNATURE = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;
const UNIX_FILE_TYPE_MASK = 0o170000;
const UNIX_SYMLINK = 0o120000;

export function importProjectFiles(source: ImportProjectSource): VersionFile[] {
  if (source.type === "files") return normalizeSourceFiles(source.files, "Imported");
  if (!(source.bytes instanceof Uint8Array)) {
    throw new ConfigurationError("ZIP source bytes must be a Uint8Array.");
  }
  return importZipFiles(source.bytes);
}

function importZipFiles(bytes: Uint8Array): VersionFile[] {
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

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const files: SourceFileInput[] = [];
  for (const [path, content] of Object.entries(entries)) {
    if (path.endsWith("/")) continue;
    try {
      files.push({ path, content: decoder.decode(content) });
    } catch (error) {
      throw new ConfigurationError(`Imported ZIP file is not UTF-8 source text: ${path}`, {
        cause: error,
      });
    }
  }
  return normalizeSourceFiles(files, "Imported");
}

function normalizeSourceFiles(
  files: readonly SourceFileInput[],
  label: string,
): VersionFile[] {
  if (!Array.isArray(files) || files.length === 0) {
    throw new ConfigurationError("An imported project must contain at least one source file.");
  }
  if (files.length > MAX_PROJECT_FILES) {
    throw new ConfigurationError(`An imported project cannot exceed ${MAX_PROJECT_FILES} files.`);
  }

  const paths = new Set<string>();
  const normalized: VersionFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    if (!file || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new ConfigurationError("Imported files require string path and content values.");
    }
    const path = normalizeProjectPath(file.path);
    if (path.length > MAX_PATH_LENGTH) {
      throw new ConfigurationError(`Imported file path exceeds ${MAX_PATH_LENGTH} characters: ${path}`);
    }
    if (paths.has(path)) throw new ConfigurationError(`${label} project has duplicate path: ${path}`);
    paths.add(path);

    const size = Buffer.byteLength(file.content);
    if (size > MAX_FILE_BYTES) {
      throw new ConfigurationError(`Imported file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    }
    totalBytes += size;
    if (totalBytes > MAX_PROJECT_BYTES) {
      throw new ConfigurationError(`An imported project cannot exceed ${MAX_PROJECT_BYTES} bytes.`);
    }

    const mediaType = file.mediaType?.trim() || inferMediaType(path);
    if (mediaType.length > 200) {
      throw new ConfigurationError(`Imported file media type exceeds 200 characters: ${path}`);
    }
    normalized.push({
      path,
      content: file.content,
      mediaType,
      size,
      checksum: sha256(file.content),
    });
  }

  return normalized.sort((left, right) => left.path.localeCompare(right.path));
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
    if (uncompressedSize > MAX_FILE_BYTES) {
      throw new ConfigurationError(`An imported ZIP entry cannot exceed ${MAX_FILE_BYTES} bytes.`);
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
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(path)) return "text/javascript";
  if (/\.(?:md|mdx|txt|yaml|yml|toml)$/.test(path)) return "text/plain";
  return "application/octet-stream";
}
