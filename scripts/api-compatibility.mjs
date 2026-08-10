import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const fixture = JSON.parse(await readFile(
  join(root, "test", "fixtures", "api", "runtime-exports-v0.2.4.json"),
  "utf8",
));
const packageJson = JSON.parse(await readFile(join(root, "package.json"), "utf8"));

for (const [subpath, expectedExports] of Object.entries(fixture)) {
  const descriptor = packageJson.exports[subpath];
  assert.ok(descriptor, `Published subpath ${subpath} was removed.`);
  const importPath = typeof descriptor === "string" ? descriptor : descriptor.import;
  assert.equal(typeof importPath, "string", `Published subpath ${subpath} has no import target.`);
  const module = await import(pathToFileURL(join(root, importPath)).href);
  const actual = new Set(Object.keys(module));
  for (const name of expectedExports) {
    assert.ok(actual.has(name), `${subpath} no longer exports ${name}.`);
  }
}

console.log(`Verified ${Object.keys(fixture).length} published runtime entry points.`);
