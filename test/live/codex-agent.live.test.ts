import assert from "node:assert/strict";
import { test } from "node:test";
import { codex } from "../../src/agent-codex.js";
import { createVibyWithDependencies } from "../../src/client.js";
import { SkillResolver } from "../../src/skills.js";
import { MemoryRepository } from "../helpers/memory-repository.js";

const enabled = process.env.VIBY_LIVE_CODEX_AGENT === "1";
const model = process.env.VIBY_CODEX_MODEL?.trim();

test("[live:codex] inspects and changes one immutable project end to end", {
  skip: !enabled
    ? "set VIBY_LIVE_CODEX_AGENT=1 and VIBY_CODEX_MODEL to use local Codex authentication"
    : !model
      ? "VIBY_CODEX_MODEL is required"
      : false,
  timeout: 10 * 60_000,
}, async () => {
  assert.ok(model);
  const viby = createVibyWithDependencies(
    {
      framework: "farmjs",
      agent: codex({ model, reasoningEffort: "low" }),
      skills: {},
    },
    {
      repository: new MemoryRepository(),
      skillResolver: new SkillResolver({}),
    },
  );

  try {
    const chat = await viby
      .forUser({ tenantId: "live-codex", userId: "live-codex" })
      .chats.import({
        title: "Codex live verification",
        source: {
          type: "files",
          files: [{
            path: "src/index.ts",
            content: "export const answer = 1;\n",
            mediaType: "text/typescript",
          }],
        },
      });
    const imported = await chat.latestVersion();
    assert.ok(imported);

    const inspection = await imported.inspect({
      prompt: "Read src/index.ts. In one sentence, state the exported name and numeric value.",
    });
    assert.match(inspection.content, /answer/i);
    assert.match(inspection.content, /1/);
    assert.equal((await chat.listVersions()).items.length, 1);

    const changed = await imported.iterate({
      prompt: "Change only src/index.ts so the exported answer value is 2.",
    });
    const file = (await changed.files()).find((candidate) => candidate.path === "src/index.ts");
    assert.ok(file);
    assert.match(file.content, /answer\s*=\s*2/);
    assert.equal((await chat.listVersions()).items.length, 2);
  } finally {
    await viby.close();
  }
});
