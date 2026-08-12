import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
  type S3ClientConfig,
} from "@aws-sdk/client-s3";
import {
  normalizeArtifactKey,
  normalizeArtifactStoreId,
  type ArtifactStore,
  type ArtifactStoreContext,
  type ArtifactStorePutInput,
  type ArtifactStoreReadOptions,
} from "./artifact-store.js";
import { ConfigurationError } from "./errors.js";

export interface S3ArtifactClient {
  send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown>;
}

export interface S3ArtifactStoreOptions {
  readonly bucket: string;
  /** Object-key prefix. Defaults to `viby`. */
  readonly prefix?: string;
  readonly id?: string;
  readonly region?: string;
  readonly endpoint?: string;
  readonly forcePathStyle?: boolean;
  readonly credentials?: S3ClientConfig["credentials"];
  readonly serverSideEncryption?: "AES256" | "aws:kms";
  readonly sseKmsKeyId?: string;
  /** Inject a compatible client for custom transports, testing, or provider wrappers. */
  readonly client?: S3ArtifactClient;
}

/** S3-compatible storage for AWS S3, Cloudflare R2, MinIO, and compatible providers. */
export class S3ArtifactStore implements ArtifactStore {
  readonly id: string;
  readonly #bucket: string;
  readonly #prefix: string;
  readonly #client: S3ArtifactClient;
  readonly #serverSideEncryption: S3ArtifactStoreOptions["serverSideEncryption"];
  readonly #sseKmsKeyId: string | undefined;

  constructor(options: S3ArtifactStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("S3 artifact store options are required.");
    }
    this.#bucket = normalizeRequired(options.bucket, "S3 artifact bucket", 255);
    this.#prefix = options.prefix === undefined
      ? "viby"
      : options.prefix.trim().replace(/^\/+|\/+$/g, "");
    if (this.#prefix) normalizeArtifactKey(this.#prefix);
    this.id = normalizeArtifactStoreId(options.id ?? "s3");
    if (options.endpoint !== undefined) {
      let endpoint: URL;
      try {
        endpoint = new URL(options.endpoint);
      } catch (error) {
        throw new ConfigurationError("S3 artifact endpoint must be an absolute URL.", { cause: error });
      }
      if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") {
        throw new ConfigurationError("S3 artifact endpoint must use HTTP or HTTPS.");
      }
    }
    if (options.sseKmsKeyId && options.serverSideEncryption !== "aws:kms") {
      throw new ConfigurationError("S3 sseKmsKeyId requires serverSideEncryption to be aws:kms.");
    }
    if (options.sseKmsKeyId !== undefined) {
      normalizeRequired(options.sseKmsKeyId, "S3 KMS key ID", 2_048);
    }
    this.#serverSideEncryption = options.serverSideEncryption;
    this.#sseKmsKeyId = options.sseKmsKeyId;
    this.#client = options.client ?? new S3Client({
      region: options.region ?? "us-east-1",
      ...(options.endpoint === undefined ? {} : { endpoint: options.endpoint }),
      ...(options.forcePathStyle === undefined ? {} : { forcePathStyle: options.forcePathStyle }),
      ...(options.credentials === undefined ? {} : { credentials: options.credentials }),
    });
  }

  async put(input: ArtifactStorePutInput, context: ArtifactStoreContext): Promise<void> {
    input.signal?.throwIfAborted();
    if (!(input.bytes instanceof Uint8Array)) {
      throw new ConfigurationError("Artifact bytes must be a Uint8Array.");
    }
    if (!/^[a-f0-9]{64}$/.test(input.checksum)) {
      throw new ConfigurationError("Artifact checksum must be a lowercase SHA-256 hex value.");
    }
    const actualChecksum = bytesToHex(sha256(input.bytes));
    if (actualChecksum !== input.checksum) {
      throw new ConfigurationError("Artifact checksum does not match its bytes.");
    }
    const key = this.#objectKey(input.key, context);
    if (await this.#matchesExisting(key, input.bytes.byteLength, input.checksum, input.signal)) return;

    try {
      await this.#send(new PutObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        Body: input.bytes.slice(),
        ContentLength: input.bytes.byteLength,
        ContentType: normalizeRequired(input.mediaType, "Artifact media type", 500),
        IfNoneMatch: "*",
        Metadata: {
          "viby-checksum": input.checksum,
          "viby-kind": encodeURIComponent(context.kind),
          "viby-owner": encodeURIComponent(context.ownerId),
        },
        ...(this.#serverSideEncryption === undefined
          ? {}
          : { ServerSideEncryption: this.#serverSideEncryption }),
        ...(this.#sseKmsKeyId === undefined ? {} : { SSEKMSKeyId: this.#sseKmsKeyId }),
      }), input.signal);
    } catch (error) {
      if (
        isPreconditionFailed(error)
        && await this.#matchesExisting(key, input.bytes.byteLength, input.checksum, input.signal)
      ) return;
      throw error;
    }
  }

  async get(
    key: string,
    context: ArtifactStoreContext,
    options: ArtifactStoreReadOptions = {},
  ): Promise<Uint8Array | null> {
    options.signal?.throwIfAborted();
    try {
      const result = await this.#send(new GetObjectCommand({
        Bucket: this.#bucket,
        Key: this.#objectKey(key, context),
      }), options.signal) as { Body?: unknown };
      const bytes = await bodyBytes(result.Body, options.signal);
      options.signal?.throwIfAborted();
      return bytes;
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }

  async delete(
    key: string,
    context: ArtifactStoreContext,
    options: ArtifactStoreReadOptions = {},
  ): Promise<void> {
    options.signal?.throwIfAborted();
    await this.#send(new DeleteObjectCommand({
      Bucket: this.#bucket,
      Key: this.#objectKey(key, context),
    }), options.signal);
  }

  async #matchesExisting(
    key: string,
    size: number,
    checksum: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    try {
      const result = await this.#send(new HeadObjectCommand({
        Bucket: this.#bucket,
        Key: key,
      }), signal) as { ContentLength?: number; Metadata?: Record<string, string> };
      if (result.ContentLength === size && result.Metadata?.["viby-checksum"] === checksum) {
        return true;
      }
      throw new ConfigurationError("An immutable S3 artifact key already contains different bytes.");
    } catch (error) {
      if (isMissingObject(error)) return false;
      throw error;
    }
  }

  #objectKey(key: string, context: ArtifactStoreContext): string {
    const normalized = normalizeArtifactKey(key);
    const scoped = [
      "tenants",
      encodeURIComponent(normalizeRequired(context.tenantId, "Artifact tenant ID", 500)),
      "users",
      encodeURIComponent(normalizeRequired(context.userId, "Artifact user ID", 500)),
      normalized,
    ].join("/");
    return this.#prefix ? `${this.#prefix}/${scoped}` : scoped;
  }

  #send(command: unknown, signal?: AbortSignal): Promise<unknown> {
    signal?.throwIfAborted();
    return this.#client.send(command, signal ? { abortSignal: signal } : undefined);
  }
}

export function s3(options: S3ArtifactStoreOptions): S3ArtifactStore {
  return new S3ArtifactStore(options);
}

export const s3ArtifactStore = s3;

function normalizeRequired(value: string, label: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.length > maxLength) {
    throw new ConfigurationError(`${label} must contain 1-${maxLength} characters.`);
  }
  return normalized;
}

async function bodyBytes(body: unknown, signal?: AbortSignal): Promise<Uint8Array> {
  if (!body) throw new Error("S3 returned an object without a response body.");
  if (body instanceof Uint8Array) return body.slice();
  if (body instanceof Blob) return new Uint8Array(await body.arrayBuffer());
  if (typeof body === "object" && "transformToByteArray" in body) {
    const transform = body.transformToByteArray;
    if (typeof transform === "function") return Uint8Array.from(await transform.call(body));
  }
  if (typeof body === "object" && Symbol.asyncIterator in body) {
    const chunks: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of body as AsyncIterable<Uint8Array | string>) {
      signal?.throwIfAborted();
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : Uint8Array.from(chunk);
      chunks.push(bytes);
      size += bytes.byteLength;
    }
    const result = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;
  }
  throw new Error("S3 returned an unsupported object body.");
}

function isMissingObject(error: unknown): boolean {
  return providerError(error, ["NoSuchKey", "NotFound"], 404);
}

function isPreconditionFailed(error: unknown): boolean {
  return providerError(error, ["PreconditionFailed", "ConditionalRequestConflict"], 412);
}

function providerError(error: unknown, names: readonly string[], status: number): boolean {
  if (!error || typeof error !== "object") return false;
  const record = error as { name?: unknown; $metadata?: { httpStatusCode?: unknown } };
  return names.includes(String(record.name)) || record.$metadata?.httpStatusCode === status;
}
