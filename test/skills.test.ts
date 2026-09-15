import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  SkillResolver,
  defineSkillResolver,
  selectCategories,
  skillFrom,
  skillInline,
  skillRead,
} from "../src/skills.js";

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

test("resolves an immutable inline skill without filesystem or network access", async () => {
  const resolver = new SkillResolver({
    core: [skillInline({
      name: "product-rules",
      description: "Apply the product rules.",
      files: [{ path: "SKILL.md", content: "# Product rules\n\nKeep the workflow compact." }],
    })],
  });

  const [skill] = await resolver.resolveForPrompt("Build a page");
  assert.equal(skill?.source, "inline");
  assert.equal(skill?.locator, "product-rules");
  assert.equal(skill?.contentHash.length, 64);
  assert.equal(skill?.files[0]?.path, "SKILL.md");
});

test("resolves opaque references through a provider-neutral adapter", async () => {
  const seen: string[] = [];
  const catalog = defineSkillResolver({
    id: "company/catalog",
    async resolve({ reference, category, prompt }) {
      if (typeof reference === "string" || reference.source !== "resolver") return null;
      if (reference.resolver !== "company/catalog") return null;
      seen.push(`${category}:${prompt}:${reference.locator}`);
      return {
        name: "company-design",
        description: "Apply the company design system.",
        files: [{ path: "SKILL.md", content: "# Company design\n\nUse the stored tokens." }],
      };
    },
  });
  const resolver = new SkillResolver({
    design: [skillFrom("company/catalog", "skills/design", { revision: 4 })],
  }, process.cwd(), [catalog]);

  const [skill] = await resolver.resolveForPrompt("Design a product dashboard");
  assert.deepEqual(seen, ["design:Design a product dashboard:skills/design"]);
  assert.equal(skill?.source, "company/catalog");
  assert.equal(skill?.locator, "skills/design");
  assert.equal(skill?.category, "design");
});

test("retries transient GitHub failures while resolving a remote skill", async () => {
  const originalFetch = globalThis.fetch;
  const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
  let repositoryRequests = 0;

  delete process.env.VERCEL_OIDC_TOKEN;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/skills") {
      repositoryRequests += 1;
      if (repositoryRequests === 1) return new Response(null, { status: 504 });
      return Response.json({ default_branch: "main" });
    }
    if (url.includes("/git/trees/main")) {
      return Response.json({
        tree: [{ type: "blob", path: "design/SKILL.md" }],
      });
    }
    if (url.includes("raw.githubusercontent.com/acme/skills/main/design/SKILL.md")) {
      return new Response("---\nname: design\ndescription: Design products.\n---\n\n# Design\n");
    }
    return new Response(null, { status: 404 });
  };

  try {
    const [skill] = await new SkillResolver({
      frontend: ["acme/skills/design"],
    }).resolveForPrompt("Build a page");

    assert.equal(repositoryRequests, 2);
    assert.equal(skill?.name, "design");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
  }
});

test("does not retain failed skill resolutions in the runtime cache", async () => {
  const originalFetch = globalThis.fetch;
  const originalOidcToken = process.env.VERCEL_OIDC_TOKEN;
  let available = false;

  delete process.env.VERCEL_OIDC_TOKEN;
  globalThis.fetch = async (input) => {
    const url = String(input);
    if (url === "https://api.github.com/repos/acme/skills") {
      return available
        ? Response.json({ default_branch: "main" })
        : new Response(null, { status: 404 });
    }
    if (url.includes("/git/trees/main")) {
      return Response.json({
        tree: [{ type: "blob", path: "design/SKILL.md" }],
      });
    }
    if (url.includes("raw.githubusercontent.com/acme/skills/main/design/SKILL.md")) {
      return new Response("# Design\n");
    }
    return new Response(null, { status: 404 });
  };

  try {
    const resolver = new SkillResolver({ frontend: ["acme/skills/design"] });
    await assert.rejects(
      resolver.resolveForPrompt("Build a page"),
      /GitHub returned 404/,
    );

    available = true;
    const [skill] = await resolver.resolveForPrompt("Build a page");
    assert.equal(skill?.name, "design");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalOidcToken === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = originalOidcToken;
  }
});
