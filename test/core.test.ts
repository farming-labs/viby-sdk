import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MESSAGE_PART_TYPES,
  defineGenerationEngine,
  defineSkillResolver,
  generationEventCursor,
  normalizeArtifactKey,
  skillFrom,
  skillInline,
} from "../src/core.js";

test("exposes Web-standard contracts and helpers through the portable core", () => {
  assert.equal(generationEventCursor(new Request("https://example.test", {
    headers: { "Last-Event-ID": "12" },
  })), "12");
  assert.equal(normalizeArtifactKey("tenant/artifact.bin"), "tenant/artifact.bin");
  assert.ok(MESSAGE_PART_TYPES.includes("tool-call"));
  assert.equal(skillFrom("company/catalog", "design").source, "resolver");
  assert.equal(skillInline({
    name: "rules",
    files: [{ path: "SKILL.md", content: "# Rules" }],
  }).source, "inline");
  assert.equal(defineSkillResolver({ id: "catalog", async resolve() { return null; } }).id, "catalog");
  assert.equal(defineGenerationEngine({
    identity: { provider: "custom", model: "agent" },
    async generate() { throw new Error("unused"); },
  }).identity.provider, "custom");
});
