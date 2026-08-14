import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import { createViby } from "../src/client.js";
import { defineGenerationEngine } from "../src/generation-engine.js";
import type { GeneratorInput, GeneratorOutput } from "../src/generator.js";
import {
  builtInFrameworks,
  isBuiltInFramework,
} from "../src/frameworks.js";
import {
  frameworkSkill,
  withFrameworkSkill,
} from "../src/framework-skills.js";
import { SkillResolver } from "../src/skills.js";
import { skillInline } from "../src/skill-resolver.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const expectedFrameworks = [
  "farmjs",
  "nextjs",
  "svelte",
  "sveltekit",
  "vue",
  "nuxt",
  "solid",
  "solidstart",
  "tanstack-start",
  "react-router",
  "astro",
  "vite",
] as const;

test("publishes canonical built-in framework IDs and immutable skills", () => {
  assert.deepEqual(builtInFrameworks, expectedFrameworks);
  assert.equal(isBuiltInFramework("farmjs"), true);
  assert.equal(isBuiltInFramework("farm"), false);
  assert.equal(isBuiltInFramework("company-runtime"), false);

  for (const framework of builtInFrameworks) {
    const skill = frameworkSkill(framework);
    assert.equal(skill.source, "inline");
    assert.equal(skill.name, `viby-framework-${framework}`);
    assert.match(skill.files[0]?.content ?? "", new RegExp(`^---\\nname: ${framework}\\n`));
    assert.match(skill.files[0]?.content ?? "", /## Verification/);
  }
});

test("injects one framework skill before host core skills", async () => {
  const host = skillInline({
    name: "host-policy",
    files: [{ path: "SKILL.md", content: "# Host policy\n\nPreserve the product contract." }],
  });
  const groups = withFrameworkSkill("nextjs", { core: [host] });
  const skills = await new SkillResolver(groups).resolveForPrompt("Build an account page");

  assert.deepEqual(skills.map((skill) => skill.name), [
    "viby-framework-nextjs",
    "host-policy",
  ]);
  assert.ok(skills.every((skill) => skill.category === "core"));
});

test("keeps legacy aliases guided and custom framework strings untouched", async () => {
  const legacy = await new SkillResolver(withFrameworkSkill("farm")).resolveForPrompt("Build a page");
  assert.equal(legacy[0]?.name, "viby-framework-farmjs");

  const custom = { frontend: [skillInline({
    name: "custom-runtime",
    files: [{ path: "SKILL.md", content: "# Custom runtime" }],
  })] } as const;
  assert.equal(withFrameworkSkill("company-runtime", custom), custom);
});

test("resolves the built-in framework skill through createViby", async () => {
  const inputs: GeneratorInput<"farmjs">[] = [];
  const usage: LanguageModelUsage = {
    inputTokens: 1,
    inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
    outputTokens: 1,
    outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
    totalTokens: 2,
  };
  const content = "export const app = true;\n";
  const output: GeneratorOutput = {
    kind: "project",
    title: "Farm.js project",
    summary: "Generated with the bundled framework contract.",
    files: [{
      path: "src/index.ts",
      content,
      mediaType: "text/javascript",
      size: Buffer.byteLength(content),
      checksum: sha256(content),
      locked: false,
    }],
    usage,
    finishReason: "stop",
  };
  const viby = createViby({
    framework: "farmjs",
    persistence: new MemoryRepository(),
    engine: defineGenerationEngine<"farmjs">({
      identity: { provider: "test", model: "framework-skills" },
      async generate(input) {
        inputs.push(input);
        return output;
      },
    }),
  });
  const chat = await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.create();
  await chat.generate({ prompt: "Build a small dashboard" });

  assert.equal(inputs.length, 1);
  assert.equal(inputs[0]?.framework, "farmjs");
  assert.equal(inputs[0]?.skills[0]?.name, "viby-framework-farmjs");
  assert.equal(inputs[0]?.skills[0]?.category, "core");
  await viby.close();
});
