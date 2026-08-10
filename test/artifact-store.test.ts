import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileSystemArtifactStore } from "../src/artifact-filesystem.js";
import { verifyArtifactStore } from "../src/artifact-store-conformance.js";
import { ConfigurationError } from "../src/errors.js";
import { sha256 } from "../src/utils.js";

const context = {
  tenantId: "tenant",
  userId: "user",
  kind: "attachment",
  ownerId: "attachment",
} as const;

test("stores artifact bytes in a traversal-safe filesystem directory", async () => {
  const directory = await mkdtemp(join(tmpdir(), "viby-artifacts-"));
  try {
    const store = fileSystemArtifactStore({ directory, id: "local-volume" });
    const bytes = new TextEncoder().encode("durable artifact");
    await store.put({
      key: "attachments/generation/attachment.txt",
      bytes,
      mediaType: "text/plain",
      checksum: sha256(bytes),
    }, context);

    bytes.fill(0);
    const stored = await store.get("attachments/generation/attachment.txt", context);
    assert.ok(stored);
    assert.equal(new TextDecoder().decode(stored), "durable artifact");
    assert.equal(
      new TextDecoder().decode(await readFile(join(
        directory,
        "attachments/generation/attachment.txt",
      ))),
      "durable artifact",
    );
    await assert.rejects(
      () => store.get("../outside", context),
      ConfigurationError,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes the provider-neutral artifact store conformance suite", async () => {
  const directory = await mkdtemp(join(tmpdir(), "viby-artifacts-conformance-"));
  try {
    const report = await verifyArtifactStore({
      store: fileSystemArtifactStore({ directory }),
      context,
    });
    assert.deepEqual(report.checks, [
      "identity",
      "missing-read",
      "byte-roundtrip",
      "defensive-read",
      "idempotent-delete",
    ]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
