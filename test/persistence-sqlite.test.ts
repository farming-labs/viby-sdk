import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { verifyPersistenceAdapter } from "../src/persistence-conformance.js";

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsSqlite = (nodeMajor ?? 0) > 22 || ((nodeMajor ?? 0) === 22 && (nodeMinor ?? 0) >= 5);

test("passes the complete persistence conformance suite with embedded SQLite", {
  skip: !supportsSqlite && "node:sqlite requires Node.js 22.5 or newer",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "viby-sqlite-conformance-"));
  try {
    const { sqlitePersistence } = await import("../src/persistence-sqlite.js");
    const report = await verifyPersistenceAdapter({
      create: () => sqlitePersistence({ path: join(directory, "viby.sqlite") }),
    });
    assert.equal(report.checks.at(-1), "close");
    assert.ok(report.checks.includes("tenant-isolation"));
    assert.ok(report.checks.includes("message-feedback"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists state across restarts and refreshes concurrent handles", {
  skip: !supportsSqlite && "node:sqlite requires Node.js 22.5 or newer",
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), "viby-sqlite-restart-"));
  const path = join(directory, "nested", "viby.sqlite");
  const scope = { tenantId: "tenant", userId: "owner" };
  try {
    const { sqlitePersistence } = await import("../src/persistence-sqlite.js");
    const first = sqlitePersistence({ path });
    await first.createChat(scope, {
      id: "chat-one",
      title: "First chat",
      metadata: { source: "first" },
      framework: "farmjs",
    });

    const second = sqlitePersistence({ path });
    assert.equal((await second.getChat(scope, "chat-one"))?.title, "First chat");
    await second.createChat(scope, {
      id: "chat-two",
      title: "Second chat",
      metadata: { source: "second" },
      framework: "farmjs",
    });
    assert.deepEqual((await first.listChats(scope, 100)).map((chat) => chat.id).sort(), [
      "chat-one",
      "chat-two",
    ]);
    await Promise.all([first.close(), second.close()]);

    const reopened = sqlitePersistence({ path });
    assert.equal((await reopened.getChat(scope, "chat-two"))?.metadata.source, "second");
    await reopened.close();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exposes a categorized SQLite database factory and validates local-only boundaries", {
  skip: !supportsSqlite && "node:sqlite requires Node.js 22.5 or newer",
}, async () => {
  const { sqlite, sqliteDatabase, sqlitePersistence } = await import("../src/persistence-sqlite.js");
  assert.equal(sqliteDatabase, sqlite);
  assert.equal(sqlite({ path: ":memory:" }).id, "sqlite");
  const database = sqlite({ path: ":memory:" }).open({});
  await database.assertReady();
  await database.close();
  assert.throws(
    () => sqlite({ path: ":memory:" }).open({
      artifacts: { id: "external", async put() {}, async get() { return null; }, async delete() {} },
    }),
    /cannot be combined with storage\.artifacts/,
  );
  assert.throws(() => sqlitePersistence({ path: "" }), /non-empty filename/);
  assert.throws(
    () => sqlitePersistence({ path: ":memory:", busyTimeoutMs: 60_001 }),
    /busyTimeoutMs/,
  );
});
