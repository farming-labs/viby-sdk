import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import {
  sandboxCapabilities,
  type SandboxAdapter,
  type SandboxCommand,
  type SandboxCreateInput,
  type SandboxFile,
  type SandboxInstance,
  type SandboxProcessInstance,
  type SandboxReconnectInput,
} from "../src/sandbox.js";
import { SkillResolver } from "../src/skills.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 4,
  inputTokenDetails: { noCacheTokens: 4, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 8,
  outputTokenDetails: { textTokens: 8, reasoningTokens: 0 },
  totalTokens: 12,
};

class WorkspaceSandbox implements SandboxInstance {
  readonly id = "generation-workspace";
  readonly files = new Map<string, string | Uint8Array>();
  readonly commands: string[] = [];
  starts = 0;
  stops = 0;
  activeChecks = 0;
  maxActiveChecks = 0;
  failFirstInstall = false;

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    for (const file of files) this.files.set(file.path, file.content);
  }

  async run(command: SandboxCommand) {
    const name = [command.command, ...(command.args ?? [])].join(" ");
    this.commands.push(name);
    if (
      this.failFirstInstall &&
      name === "pnpm install" &&
      this.commands.filter((candidate) => candidate === name).length === 1
    ) {
      return { exitCode: 1, stdout: "", stderr: "preview install failed", durationMs: 10 };
    }
    const check = name === "pnpm typecheck" || name === "pnpm build";
    if (check) {
      this.activeChecks += 1;
      this.maxActiveChecks = Math.max(this.maxActiveChecks, this.activeChecks);
      await new Promise((resolve) => setTimeout(resolve, 10));
      this.activeChecks -= 1;
    }
    return { exitCode: 0, stdout: "", stderr: "", durationMs: 10 };
  }

  async start(): Promise<SandboxProcessInstance> {
    this.starts += 1;
    return {
      id: "farm-dev",
      wait: () => new Promise(() => {}),
      kill: async () => undefined,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`Missing ${path}`);
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  }

  getUrl(port: number): string {
    return `https://generation.preview.test:${port}/`;
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }
}

class WorkspaceSandboxAdapter implements SandboxAdapter {
  readonly provider = "workspace-test";
  readonly capabilities = sandboxCapabilities({
    files: true,
    commands: true,
    portUrls: true,
    backgroundProcesses: true,
    reconnect: true,
  });
  readonly instance = new WorkspaceSandbox();
  readonly creates: SandboxCreateInput[] = [];

  async create(input: SandboxCreateInput): Promise<SandboxInstance> {
    this.creates.push(input);
    return this.instance;
  }

  async reconnect(_input: SandboxReconnectInput): Promise<SandboxInstance> {
    return this.instance;
  }
}

class WorkspaceGenerator implements ProjectGenerator<"farmjs"> {
  async generate(): Promise<GeneratorOutput> {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return {
      kind: "project",
      title: "Live workspace",
      summary: "Updated the scaffold in its running preview.",
      files: [
        generatedFile(
          "src/app/page.tsx",
          "export default function Page() { return <main>Ready</main>; }\n",
        ),
      ],
      usage,
      finishReason: "stop",
    };
  }
}

test("starts one eager preview workspace and reuses it for generation quality", async () => {
  const repository = new MemoryRepository();
  const adapter = new WorkspaceSandboxAdapter();
  const viby = createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/workspace" as LanguageModel,
      sandbox: adapter,
      preview: {
        env: { PREVIEW_HOST: ".preview.test" },
        prepare: [{ command: "pnpm", args: ["install"] }],
        start: { command: "pnpm", args: ["dev", "--port", "4173"] },
        port: 4173,
        readiness: { check: async () => true },
      },
      generation: {
        workspace: { preview: "eager" },
        quality: {
          prepare: [{ id: "install", command: "pnpm", args: ["install"] }],
          checks: [
            { id: "typecheck", command: "pnpm", args: ["typecheck"] },
            { id: "build", command: "pnpm", args: ["build"] },
          ],
          checkConcurrency: 2,
        },
      },
    },
    {
      repository,
      generator: new WorkspaceGenerator(),
      skillResolver: new SkillResolver({}),
    },
  );

  try {
    const user = viby.forUser({ tenantId: "workspace-tenant", userId: "workspace-user" });
    const chat = await user.chats.import({
      title: "Scaffold",
      source: {
        type: "files",
        files: [
          { path: "package.json", content: '{"scripts":{"dev":"farm dev"}}\n' },
          {
            path: "src/app/page.tsx",
            content: "export default function Page() { return null; }\n",
          },
        ],
      },
    });
    const scaffold = await chat.latestVersion();
    assert.ok(scaffold);
    const generation = await scaffold.startIteration({ prompt: "Create a contact form" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    if (outcome.status !== "succeeded") throw new Error("Expected a generated version");

    assert.equal(adapter.creates.length, 1);
    assert.deepEqual(adapter.creates[0]?.ports, [4173]);
    assert.deepEqual(adapter.creates[0]?.env, { PREVIEW_HOST: ".preview.test" });
    assert.equal(adapter.instance.starts, 1);
    assert.deepEqual(adapter.instance.commands, [
      "pnpm install",
      "pnpm install",
      "pnpm typecheck",
      "pnpm build",
    ]);
    assert.equal(adapter.instance.maxActiveChecks, 2);
    assert.equal(adapter.instance.stops, 0);

    const currentPreviews = await user.previews.list({ versionId: outcome.version.id });
    const scaffoldPreviews = await user.previews.list({ versionId: scaffold.id });
    assert.equal(currentPreviews.length, 1);
    assert.equal(currentPreviews[0]?.status, "ready");
    assert.equal(scaffoldPreviews.length, 0);

    const eventTypes = (await generation.events({ limit: 100 })).events.map((event) => event.type);
    assert.ok(eventTypes.indexOf("preview.ready") < eventTypes.indexOf("quality.started"));
    assert.ok(eventTypes.includes("workspace.started"));
    assert.ok(eventTypes.includes("workspace.prepared"));
  } finally {
    await viby.close();
  }
  assert.equal(adapter.instance.stops, 1);
});

test("keeps generation alive when eager preview preparation fails", async () => {
  const repository = new MemoryRepository();
  const adapter = new WorkspaceSandboxAdapter();
  adapter.instance.failFirstInstall = true;
  const viby = createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/workspace" as LanguageModel,
      sandbox: adapter,
      preview: {
        prepare: [{ command: "pnpm", args: ["install"] }],
        start: { command: "pnpm", args: ["dev"] },
        port: 4173,
        readiness: { check: async () => true },
      },
      generation: {
        workspace: { preview: "eager" },
        quality: {
          prepare: [{ id: "install", command: "pnpm", args: ["install"] }],
          checks: [{ id: "build", command: "pnpm", args: ["build"] }],
        },
      },
    },
    {
      repository,
      generator: new WorkspaceGenerator(),
      skillResolver: new SkillResolver({}),
    },
  );

  const user = viby.forUser({ tenantId: "workspace-tenant", userId: "workspace-user" });
  const chat = await user.chats.import({
    title: "Recoverable preview",
    source: {
      type: "files",
      files: [{ path: "package.json", content: '{"scripts":{"dev":"farm dev"}}\n' }],
    },
  });
  const base = await chat.latestVersion();
  assert.ok(base);
  const generation = await base.startIteration({ prompt: "Finish even if preview is unavailable" });
  const outcome = await generation.wait({ pollIntervalMs: 10 });

  assert.equal(outcome.status, "succeeded");
  assert.deepEqual(adapter.instance.commands, ["pnpm install", "pnpm install", "pnpm build"]);
  const events = (await generation.events({ limit: 100 })).events;
  assert.ok(events.some((event) => event.type === "preview.failed"));
  assert.ok(events.some((event) => event.type === "quality.started"));
  assert.equal((await user.previews.list({ status: "failed" })).length, 1);
  assert.equal(adapter.instance.stops, 1);
  await viby.close();
});

function generatedFile(path: string, content: string) {
  return {
    path,
    content,
    mediaType: "text/typescript",
    size: new TextEncoder().encode(content).byteLength,
    checksum: sha256(content),
    locked: false,
  };
}
