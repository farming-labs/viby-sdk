import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import { GenerationError } from "../src/errors.js";
import type { GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import {
  sandboxCapabilities,
  type SandboxAdapter,
  type SandboxCommand,
  type SandboxCreateInput,
  type SandboxFile,
  type SandboxInstance,
} from "../src/sandbox.js";
import { SkillResolver } from "../src/skills.js";
import type { GenerationQualityConfig, VersionFile } from "../src/types.js";
import { sha256 } from "../src/utils.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const usage: LanguageModelUsage = {
  inputTokens: 5,
  inputTokenDetails: { noCacheTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 8,
  outputTokenDetails: { textTokens: 8, reasoningTokens: 0 },
  totalTokens: 13,
};

class QualityGenerator implements ProjectGenerator<"farmjs"> {
  async generate(): Promise<GeneratorOutput> {
    return {
      kind: "project",
      title: "Quality project",
      summary: "Generated source passed configured checks.",
      files: [
        file("package.json", '{"scripts":{"typecheck":"tsc --noEmit","build":"farm build"}}\n', true),
        file("src/index.ts", "export  const ready=true;\n"),
      ],
      usage,
      finishReason: "stop",
    };
  }
}

class QualitySandboxInstance implements SandboxInstance {
  readonly id = "quality-sandbox";
  readonly files = new Map<string, string | Uint8Array>();
  readonly commands: SandboxCommand[] = [];
  stopCalls = 0;

  constructor(readonly failScript: string | null) {}

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    for (const entry of files) this.files.set(entry.path, entry.content);
  }

  async run(command: SandboxCommand) {
    this.commands.push(command);
    if (command.command === "formatter") {
      this.files.set("src/index.ts", "export const ready = true;\n");
      this.files.set("package.json", '{"scripts":{}}\n');
    }
    const script = command.args?.at(-1) ?? "";
    const failed = script === this.failScript;
    return {
      exitCode: failed ? 1 : 0,
      stdout: failed ? "API_TOKEN=must-not-be-durable\n" : "ok\n",
      stderr: failed ? "build failed\n" : "",
      durationMs: 12,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (content === undefined) throw new Error("missing file");
    return typeof content === "string" ? new TextEncoder().encode(content) : content;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

class QualitySandboxAdapter implements SandboxAdapter {
  readonly provider = "quality-test";
  readonly capabilities = sandboxCapabilities({ files: true, commands: true });
  readonly creates: SandboxCreateInput[] = [];
  readonly instances: QualitySandboxInstance[] = [];

  constructor(readonly failScript: string | null = null) {}

  async create(input: SandboxCreateInput): Promise<SandboxInstance> {
    this.creates.push(input);
    const instance = new QualitySandboxInstance(this.failScript);
    this.instances.push(instance);
    return instance;
  }
}

class OneTimeFailureSandboxAdapter extends QualitySandboxAdapter {
  override async create(input: SandboxCreateInput): Promise<SandboxInstance> {
    this.creates.push(input);
    const instance = new QualitySandboxInstance(this.instances.length === 0 ? "build" : null);
    this.instances.push(instance);
    return instance;
  }
}

function setup(
  adapter: QualitySandboxAdapter,
  formatFailure?: GenerationQualityConfig["formatFailure"],
  captureSourceChanges = false,
  repairAttempts = 0,
  generator: ProjectGenerator<"farmjs"> = new QualityGenerator(),
) {
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/quality" as LanguageModel,
      sandbox: adapter,
      generation: {
        quality: {
          prepare: [{
            id: "install",
            command: "npm",
            args: ["install", "--ignore-scripts"],
          }, ...(captureSourceChanges ? [{ id: "format", command: "formatter" }] : [])],
          checks: [
            { id: "typecheck", command: "npm", args: ["run", "typecheck"] },
            { id: "build", command: "npm", args: ["run", "build"] },
          ],
          captureSourceChanges,
          repairAttempts,
          ...(formatFailure ? { formatFailure } : {}),
        },
      },
    },
    {
      repository,
      generator,
      skillResolver: new SkillResolver({}),
    },
  );
  return { repository, viby };
}

test("commits an immutable version only after every sandbox quality command passes", async () => {
  const adapter = new QualitySandboxAdapter();
  const { viby } = setup(adapter);
  try {
    const user = viby.forUser({ tenantId: "quality-tenant", userId: "quality-user" });
    const chat = await user.chats.create({ title: "Quality" });
    const generation = await chat.start({ prompt: "Build a checked project" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "succeeded");
    assert.deepEqual(
      adapter.instances[0]?.commands.map((command) => [command.command, command.args]),
      [
        ["npm", ["install", "--ignore-scripts"]],
        ["npm", ["run", "typecheck"]],
        ["npm", ["run", "build"]],
      ],
    );
    assert.equal(adapter.instances[0]?.files.has("src/index.ts"), true);
    assert.equal(adapter.instances[0]?.stopCalls, 1);
    assert.equal((await chat.listVersions()).items.length, 1);
    const assistant = (await chat.listMessages()).items.find((message) => (
      message.role === "assistant"
    ));
    const usagePart = assistant?.parts.find((part) => part.type === "usage");
    assert.equal(typeof usagePart?.data.durationMs, "number");
    assert.equal((usagePart?.data.durationMs ?? -1) >= 0, true);
    assert.deepEqual(
      (await generation.events({ limit: 100 })).events
        .filter((event) => event.type.startsWith("quality."))
        .map((event) => event.type),
      [
        "quality.started", "quality.completed",
        "quality.started", "quality.completed",
        "quality.started", "quality.completed",
      ],
    );
  } finally {
    await viby.close();
  }
});

test("atomically repairs one failed quality attempt with its durable diagnostic", async () => {
  const adapter = new OneTimeFailureSandboxAdapter();
  const instructions: Array<string | null | undefined> = [];
  const generator: ProjectGenerator<"farmjs"> = {
    async generate(input) {
      instructions.push(input.instructions);
      return new QualityGenerator().generate();
    },
  };
  const { viby } = setup(adapter, undefined, false, 1, generator);
  try {
    const user = viby.forUser({ tenantId: "quality-repair-tenant", userId: "quality-repair-user" });
    const chat = await user.chats.create({ title: "Quality repair" });
    const generation = await chat.start({ prompt: "Build and repair a checked project" });
    assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");
    assert.equal(adapter.instances.length, 2);
    assert.match(
      instructions[1] ?? "",
      /previous attempt failed with: Generation quality check build failed with exit code 1/i,
    );
    assert.deepEqual(
      (await generation.attempts()).map(({ number, reason, status }) => ({ number, reason, status })),
      [
        { number: 1, reason: "initial", status: "failed" },
        { number: 2, reason: "retry", status: "succeeded" },
      ],
    );
    assert.equal(
      (await generation.events({ limit: 100 })).events.some((event) => (
        event.type === "generation.failed"
      )),
      false,
    );
  } finally {
    await viby.close();
  }
});

test("fails the attempt without committing source when a quality check fails", async () => {
  const adapter = new QualitySandboxAdapter("build");
  const { viby } = setup(adapter);
  try {
    const user = viby.forUser({ tenantId: "quality-fail-tenant", userId: "quality-fail-user" });
    const chat = await user.chats.create({ title: "Quality failure" });
    const generation = await chat.start({ prompt: "Build a broken project" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("Expected quality failure");
    assert.match(outcome.error, /quality check build failed with exit code 1/i);
    assert.equal((await chat.listVersions()).items.length, 0);
    assert.equal(adapter.instances[0]?.stopCalls, 1);
    const events = await generation.events({ limit: 100 });
    const completed = events.events.filter((event) => event.type === "quality.completed");
    assert.equal(completed.at(-1)?.data.status, "failed");
    assert.doesNotMatch(JSON.stringify(events.events), /must-not-be-durable/);
    await assert.rejects(() => chat.generate({ prompt: "Fail again" }), GenerationError);
  } finally {
    await viby.close();
  }
});

test("persists sandbox-formatted candidate source when capture is enabled", async () => {
  const adapter = new QualitySandboxAdapter();
  const { viby } = setup(adapter, undefined, true);
  try {
    const user = viby.forUser({ tenantId: "quality-format-tenant", userId: "quality-format-user" });
    const chat = await user.chats.create({ title: "Formatted quality" });
    const generation = await chat.start({ prompt: "Build readable source" });
    assert.equal((await generation.wait({ pollIntervalMs: 10 })).status, "succeeded");

    const version = (await chat.listVersions()).items[0];
    assert.ok(version);
    const formatted = (await version.entries()).find((entry) => entry.path === "src/index.ts");
    assert.equal(
      formatted?.type === "text" ? formatted.content : null,
      "export const ready = true;\n",
    );
    const locked = (await version.entries()).find((entry) => entry.path === "package.json");
    assert.equal(
      locked?.type === "text" ? locked.content : null,
      '{"scripts":{"typecheck":"tsc --noEmit","build":"farm build"}}\n',
    );
  } finally {
    await viby.close();
  }
});

test("persists only host-sanitized quality diagnostics", async () => {
  const adapter = new QualitySandboxAdapter("build");
  const { viby } = setup(
    adapter,
    ({ checkId, stderr }) => `${checkId}: ${stderr.trim()} (credentials redacted)`,
  );
  try {
    const user = viby.forUser({ tenantId: "quality-detail-tenant", userId: "quality-detail-user" });
    const chat = await user.chats.create({ title: "Quality diagnostics" });
    const generation = await chat.start({ prompt: "Build a broken project" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assert.equal(outcome.status, "failed");
    if (outcome.status !== "failed") throw new Error("Expected quality failure");
    assert.match(outcome.error, /build: build failed \(credentials redacted\)/);

    const events = await generation.events({ limit: 100 });
    const completed = events.events.filter((event) => event.type === "quality.completed");
    assert.equal(completed.at(-1)?.data.detail, "build: build failed (credentials redacted)");
    assert.doesNotMatch(JSON.stringify(events.events), /must-not-be-durable/);
  } finally {
    await viby.close();
  }
});

test("requires a sandbox and validates declarative quality commands at configuration time", () => {
  const dependencies = {
    repository: new MemoryRepository(),
    generator: new QualityGenerator(),
    skillResolver: new SkillResolver({}),
  };
  assert.throws(() => createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/quality" as LanguageModel,
      generation: { quality: { checks: [{ id: "build", command: "npm" }] } },
    },
    dependencies,
  ), /requires a sandbox adapter/);
  assert.throws(() => createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/quality" as LanguageModel,
      sandbox: new QualitySandboxAdapter(),
      generation: { quality: { checks: [] } },
    },
    dependencies,
  ), /checks must contain at least one command/);
  assert.throws(() => createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/quality" as LanguageModel,
      sandbox: new QualitySandboxAdapter(),
      generation: {
        quality: {
          checks: [{ id: "build", command: "npm" }],
          captureSourceChanges: "yes" as unknown as boolean,
        },
      },
    },
    dependencies,
  ), /captureSourceChanges must be a boolean/);
  assert.throws(() => createVibyWithDependencies(
    {
      framework: "farmjs",
      model: "test/quality" as LanguageModel,
      sandbox: new QualitySandboxAdapter(),
      generation: {
        quality: {
          checks: [{ id: "build", command: "npm" }],
          repairAttempts: 4,
        },
      },
    },
    dependencies,
  ), /repairAttempts must be an integer between 0 and 3/);
});

function file(path: string, content: string, locked = false): VersionFile {
  return {
    path,
    content,
    mediaType: path.endsWith(".json") ? "application/json" : "text/typescript",
    size: new TextEncoder().encode(content).byteLength,
    checksum: sha256(content),
    locked,
  };
}
