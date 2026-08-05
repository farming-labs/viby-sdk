import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SkillResolver, selectCategories, skillRead } from "../src/skills.js";

test("selects core and frontend skills plus prompt-relevant categories", () => {
  assert.deepEqual(
    selectCategories("Add secure authentication and database sessions", [
      "core",
      "frontend",
      "design",
      "backend",
      "data",
      "security",
    ]),
    ["core", "frontend", "backend", "data", "security"],
  );
});

test("reads and snapshots a local skill directory", async () => {
  const root = await mkdtemp(join(tmpdir(), "viby-skills-"));
  const directory = join(root, "brand");
  await mkdir(join(directory, "references"), { recursive: true });
  await writeFile(
    join(directory, "SKILL.md"),
    "---\nname: brand-design\ndescription: Apply the product brand.\n---\n\nRead references/tokens.md.",
  );
  await writeFile(join(directory, "references", "tokens.md"), "# Tokens\n\nUse blue.");

  const resolver = new SkillResolver({
    core: [skillRead("./brand")],
  }, root);
  const [skill] = await resolver.resolveForPrompt("Build a page");

  assert.equal(skill?.name, "brand-design");
  assert.equal(skill?.source, "file");
  assert.equal(skill?.files.length, 2);
  assert.equal(skill?.contentHash.length, 64);
});
