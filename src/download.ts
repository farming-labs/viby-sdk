import { strToU8, zipSync } from "fflate";
import type { VersionFile } from "./types.js";
import { slugify } from "./utils.js";

export class DownloadArtifact {
  readonly filename: string;
  readonly contentType = "application/zip";
  readonly bytes: Uint8Array;

  constructor(filename: string, bytes: Uint8Array) {
    this.filename = filename;
    this.bytes = bytes;
  }

  toResponse(init: ResponseInit = {}): Response {
    const headers = new Headers(init.headers);
    headers.set("Content-Type", this.contentType);
    headers.set("Content-Disposition", `attachment; filename="${this.filename}"`);
    headers.set("Content-Length", String(this.bytes.byteLength));
    return new Response(this.bytes.slice().buffer, { ...init, headers });
  }
}

export function createSourceDownload(
  title: string,
  files: readonly VersionFile[],
): DownloadArtifact {
  const archiveInput: Record<string, Uint8Array> = {};
  for (const file of files) {
    archiveInput[file.path] = strToU8(file.content);
  }
  const bytes = zipSync(archiveInput, { level: 6 });
  return new DownloadArtifact(`${slugify(title)}.zip`, bytes);
}
