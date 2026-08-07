import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { getReleaseVersion } from "./release-version.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const packageLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));

assert.equal(packageLock.version, packageJson.version, "package-lock.json version is out of sync");
assert.equal(
  packageLock.packages?.[""]?.version,
  packageJson.version,
  "package-lock.json root package version is out of sync",
);
getReleaseVersion(packageJson.version);

console.log(`Release manifests agree on ${packageJson.version}.`);
