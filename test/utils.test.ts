import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeProjectPath, slugify } from "../src/utils.js";

test("normalizes safe project paths", () => {
  assert.equal(normalizeProjectPath("./src\\index.ts"), "src/index.ts");
});

test("rejects paths that escape the generated project", () => {
  assert.throws(() => normalizeProjectPath("../../.env"));
  assert.throws(() => normalizeProjectPath("/etc/passwd"));
});

test("creates stable download filenames", () => {
  assert.equal(slugify("  SaaS Analytics — Dashboard  "), "saas-analytics-dashboard");
});
