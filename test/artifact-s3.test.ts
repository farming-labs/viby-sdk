import assert from "node:assert/strict";
import { test } from "node:test";
import { s3, type S3ArtifactClient } from "../src/artifact-s3.js";
import { verifyArtifactStore } from "../src/artifact-store-conformance.js";
import { ConfigurationError } from "../src/errors.js";
import { sha256 } from "../src/utils.js";

const context = {
  tenantId: "tenant/a",
  userId: "user@example.com",
  kind: "attachment",
  ownerId: "attachment",
} as const;

class MemoryS3Client implements S3ArtifactClient {
  readonly objects = new Map<string, { bytes: Uint8Array; metadata: Record<string, string> }>();
  readonly commands: string[] = [];

  async send(command: unknown, options?: { readonly abortSignal?: AbortSignal }): Promise<unknown> {
    options?.abortSignal?.throwIfAborted();
    const value = command as { constructor: { name: string }; input: Record<string, unknown> };
    this.commands.push(value.constructor.name);
    const key = String(value.input.Key);
    switch (value.constructor.name) {
      case "HeadObjectCommand": {
        const stored = this.objects.get(key);
        if (!stored) throw notFound();
        return { ContentLength: stored.bytes.byteLength, Metadata: { ...stored.metadata } };
      }
      case "PutObjectCommand": {
        if (this.objects.has(key)) {
          throw Object.assign(new Error("exists"), {
            name: "PreconditionFailed",
            $metadata: { httpStatusCode: 412 },
          });
        }
        this.objects.set(key, {
          bytes: Uint8Array.from(value.input.Body as Uint8Array),
          metadata: { ...(value.input.Metadata as Record<string, string>) },
        });
        return {};
      }
      case "GetObjectCommand": {
        const stored = this.objects.get(key);
        if (!stored) throw notFound();
        return { Body: { transformToByteArray: async () => stored.bytes.slice() } };
      }
      case "DeleteObjectCommand":
        this.objects.delete(key);
        return {};
      default:
        throw new Error(`Unexpected command: ${value.constructor.name}`);
    }
  }
}

test("stores immutable tenant-scoped artifacts through an S3-compatible client", async () => {
  const client = new MemoryS3Client();
  const store = s3({ bucket: "viby-test", prefix: "products/viby", client });
  const bytes = new TextEncoder().encode("durable artifact");
  await store.put({
    key: "attachments/file.txt",
    bytes,
    mediaType: "text/plain",
    checksum: sha256(bytes),
  }, context);

  const objectKey = "products/viby/tenants/tenant%2Fa/users/user%40example.com/attachments/file.txt";
  assert.equal(new TextDecoder().decode(client.objects.get(objectKey)?.bytes), "durable artifact");
  assert.equal(client.objects.get(objectKey)?.metadata["viby-kind"], "attachment");
  assert.equal(client.objects.get(objectKey)?.metadata["viby-checksum"], sha256(bytes));

  await store.put({
    key: "attachments/file.txt",
    bytes,
    mediaType: "text/plain",
    checksum: sha256(bytes),
  }, context);
  assert.equal(client.commands.filter((command) => command === "PutObjectCommand").length, 1);

  const changed = new TextEncoder().encode("different");
  await assert.rejects(() => store.put({
    key: "attachments/file.txt",
    bytes: changed,
    mediaType: "text/plain",
    checksum: sha256(changed),
  }, context), /already contains different bytes/);
});

test("passes the artifact conformance suite with an S3-compatible client", async () => {
  const report = await verifyArtifactStore({
    store: s3({ bucket: "viby-test", client: new MemoryS3Client() }),
    context,
  });
  assert.deepEqual(report.checks, [
    "identity",
    "missing-read",
    "byte-roundtrip",
    "defensive-read",
    "idempotent-delete",
  ]);
});

test("validates S3 configuration, checksums, paths, and abort signals", async () => {
  assert.throws(() => s3({ bucket: "", client: new MemoryS3Client() }), ConfigurationError);
  assert.throws(() => s3({
    bucket: "bucket",
    serverSideEncryption: "AES256",
    sseKmsKeyId: "key",
    client: new MemoryS3Client(),
  }), ConfigurationError);
  const store = s3({ bucket: "bucket", client: new MemoryS3Client() });
  const bytes = new Uint8Array([1, 2, 3]);
  await assert.rejects(() => store.put({
    key: "artifact.bin",
    bytes,
    mediaType: "application/octet-stream",
    checksum: "0".repeat(64),
  }, context), /checksum does not match/);
  await assert.rejects(() => store.get("../escape", context), ConfigurationError);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(() => store.get("artifact.bin", context, {
    signal: controller.signal,
  }), { name: "AbortError" });
});

function notFound(): Error {
  return Object.assign(new Error("missing"), {
    name: "NotFound",
    $metadata: { httpStatusCode: 404 },
  });
}
