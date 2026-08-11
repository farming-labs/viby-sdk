import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  disposableName,
  readTrackedResources,
  trackedCleanup,
  withCleanup,
} from "./live/helpers.js";

test("live provider cleanup runs in reverse registration order", async () => {
  const order: string[] = [];
  const result = await withCleanup(async (cleanup) => {
    cleanup(async () => { order.push("first"); });
    cleanup(async () => { order.push("second"); });
    return "verified";
  });
  assert.equal(result, "verified");
  assert.deepEqual(order, ["second", "first"]);
});

test("live provider cleanup still runs after a verification failure", async () => {
  let cleaned = false;
  await assert.rejects(
    () => withCleanup(async (cleanup) => {
      cleanup(async () => { cleaned = true; });
      throw new Error("verification failed");
    }),
    /verification failed/,
  );
  assert.equal(cleaned, true);
});

test("live provider cleanup reports both verification and cleanup failures", async () => {
  await assert.rejects(
    () => withCleanup(async (cleanup) => {
      cleanup(async () => { throw new Error("cleanup failed"); });
      throw new Error("verification failed");
    }),
    (error: unknown) => error instanceof AggregateError
      && error.errors.length === 2
      && error.errors.some((item) => String(item).includes("verification failed"))
      && error.errors.some((item) => String(item).includes("cleanup failed")),
  );
});

test("live provider resource names are generated and visibly disposable", () => {
  const first = disposableName("github");
  const second = disposableName("github");
  assert.match(first, /^viby-live-github-[a-z0-9-]+$/);
  assert.notEqual(first, second);
  assert.ok(first.length <= 52);
});

test("tracked cleanup persists recovery state and removes it only after success", async () => {
  const directory = mkdtempSync(join(tmpdir(), "viby-live-cleanup-"));
  const file = join(directory, "resources.json");
  const previous = process.env.VIBY_LIVE_CLEANUP_FILE;
  process.env.VIBY_LIVE_CLEANUP_FILE = file;
  const resource = {
    provider: "vercel" as const,
    kind: "deployment" as const,
    projectId: "project-1",
    idempotencyKey: "live:viby-live-vercel-fixture",
  };
  try {
    let cleaned = false;
    const cleanup = trackedCleanup(resource, async () => { cleaned = true; });
    assert.deepEqual(readTrackedResources(), [resource]);
    assert.equal(existsSync(file), true);
    await cleanup();
    assert.equal(cleaned, true);
    assert.deepEqual(readTrackedResources(), []);
    assert.equal(existsSync(file), false);
  } finally {
    if (previous === undefined) delete process.env.VIBY_LIVE_CLEANUP_FILE;
    else process.env.VIBY_LIVE_CLEANUP_FILE = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});
