import assert from "node:assert/strict";
import { appendFile, readFile } from "node:fs/promises";
import { getReleaseVersion } from "./release-version.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const release = getReleaseVersion(packageJson.version);
const allowPublished = process.argv.includes("--allow-published");

if (process.env.GITHUB_EVENT_NAME === "release" || process.env.GITHUB_REF_TYPE === "tag") {
  assert.equal(
    process.env.GITHUB_REF_NAME,
    release.tag,
    `Git tag must be ${release.tag}`,
  );
}

const packagePath = packageJson.name.replace("/", "%2f");
const response = await fetch(
  `https://registry.npmjs.org/${packagePath}/${encodeURIComponent(packageJson.version)}`,
  { headers: { accept: "application/json" } },
);

const published = response.ok;
if (published && !allowPublished) {
  throw new Error(`${packageJson.name}@${packageJson.version} is already published.`);
}
if (response.status !== 404) {
  if (!response.ok) {
    throw new Error(`npm registry returned ${response.status} while checking the release version.`);
  }
}

if (process.env.GITHUB_OUTPUT) {
  await appendFile(
    process.env.GITHUB_OUTPUT,
    [
      `version=${packageJson.version}`,
      `tag=${release.tag}`,
      `npm_tag=${release.npmTag}`,
      `prerelease=${release.prerelease ? "true" : "false"}`,
      `published=${published ? "true" : "false"}`,
      "",
    ].join("\n"),
  );
}

const availability = published ? "is already published" : "is available";
console.log(
  `${packageJson.name}@${packageJson.version} ${availability} for ${release.tag} (${release.npmTag}).`,
);
