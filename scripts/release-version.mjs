import assert from "node:assert/strict";

const semverPattern = /^\d+\.\d+\.\d+(?:-([0-9A-Za-z-]+)(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

export function getReleaseVersion(version) {
  const match = version.match(semverPattern);
  assert.ok(match, "package version must be valid SemVer");
  const prereleaseId = match[1] ?? null;
  const npmTag = prereleaseId === null
    ? "latest"
    : prereleaseId === "beta" || prereleaseId === "canary"
      ? prereleaseId
      : "next";

  return {
    version,
    tag: `v${version}`,
    npmTag,
    prerelease: prereleaseId !== null,
  };
}
