import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const migrationDirectory = join(root, "migrations");
const fixturePath = join(root, "test", "fixtures", "schema", "checksums.json");
const expected = JSON.parse(await readFile(fixturePath, "utf8"));
const names = (await readdir(migrationDirectory))
  .filter((name) => /^\d{4}_[a-z0-9_-]+\.sql$/.test(name))
  .sort();

assert.deepEqual(
  Object.keys(expected),
  names,
  "Migration checksum fixture must list every migration in filename order.",
);

for (const [index, name] of names.entries()) {
  const prefix = String(index + 1).padStart(4, "0");
  assert.equal(name.slice(0, 4), prefix, `Migration sequence is not contiguous at ${name}.`);
  const contents = await readFile(join(migrationDirectory, name));
  const actual = createHash("sha256").update(contents).digest("hex");
  assert.equal(
    actual,
    expected[name],
    `${name} changed after publication. Add a new migration instead of editing history.`,
  );
}

console.log(`Verified ${names.length} immutable migration fixtures.`);
