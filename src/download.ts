import { strToU8, zipSync } from "fflate";
import { slugify } from "./utils.js";

export interface DownloadFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

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
  files: readonly DownloadFile[],
): DownloadArtifact {
  const archiveInput: Record<string, Uint8Array> = {};
  for (const file of files) {
    archiveInput[file.path] = typeof file.content === "string"
      ? strToU8(file.content)
      : Uint8Array.from(file.content);
  }
  const bytes = zipSync(archiveInput, { level: 6 });
  return new DownloadArtifact(`${slugify(title)}.zip`, bytes);
}
