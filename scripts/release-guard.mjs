import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const expectedTag = `v${packageJson.version}`;

if (process.env.GITHUB_EVENT_NAME === "release") {
  assert.equal(
    process.env.GITHUB_REF_NAME,
    expectedTag,
    `GitHub release tag must be ${expectedTag}`,
  );
}

const packagePath = packageJson.name.replace("/", "%2f");
const response = await fetch(
  `https://registry.npmjs.org/${packagePath}/${encodeURIComponent(packageJson.version)}`,
  { headers: { accept: "application/json" } },
);

if (response.ok) {
  throw new Error(`${packageJson.name}@${packageJson.version} is already published.`);
}
if (response.status !== 404) {
  throw new Error(`npm registry returned ${response.status} while checking the release version.`);
}

console.log(`${packageJson.name}@${packageJson.version} is available for ${expectedTag}.`);
