import assert from "node:assert/strict";
import { test } from "node:test";
import { getReleaseVersion } from "../scripts/release-version.mjs";

test("maps stable versions to the latest npm tag", () => {
  assert.deepEqual(getReleaseVersion("1.2.3"), {
    version: "1.2.3",
    tag: "v1.2.3",
    npmTag: "latest",
    prerelease: false,
  });
});

test("preserves beta and canary npm tags", () => {
  assert.equal(getReleaseVersion("1.2.3-beta.4").npmTag, "beta");
  assert.equal(getReleaseVersion("1.2.3-canary.9").npmTag, "canary");
});

test("maps other prereleases to the next npm tag", () => {
  assert.deepEqual(getReleaseVersion("1.2.3-rc.1"), {
    version: "1.2.3-rc.1",
    tag: "v1.2.3-rc.1",
    npmTag: "next",
    prerelease: true,
  });
});

test("rejects invalid release versions", () => {
  assert.throws(() => getReleaseVersion("1.2"), /valid SemVer/);
});
