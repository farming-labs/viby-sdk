import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { createVibyApi } from "../src/api-host.js";
import { createVibyWithDependencies } from "../src/client.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
  SandboxOperationOptions,
  SandboxProcessInstance,
  SandboxReconnectInput,
} from "../src/sandbox.js";
import { sandboxCapabilities } from "../src/sandbox.js";
import { SkillResolver } from "../src/skills.js";
import type { PreviewConfig } from "../src/preview.js";
import type { FrameworkId } from "../src/types.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

class UnusedGenerator<Framework extends FrameworkId> implements ProjectGenerator<Framework> {
  async generate(_input: GeneratorInput<Framework>): Promise<GeneratorOutput> {
    throw new Error("Preview tests import source and do not invoke generation.");
  }
}

class PreviewSandboxInstance implements SandboxInstance {
  readonly id: string;
  readonly files = new Map<string, Uint8Array>();
  readonly starts: SandboxCommand[] = [];
  readonly runs: SandboxCommand[] = [];
  runResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  stopCalls = 0;

  constructor(id: string) {
    this.id = id;
  }

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(
        file.path,
        typeof file.content === "string" ? Buffer.from(file.content) : file.content,
      );
    }
  }

  async run(command: SandboxCommand) {
    this.runs.push(command);
    await command.onOutput?.({ stream: "stdout", data: "dependencies installed\n" });
    return this.runResult;
  }

  async start(command: SandboxCommand): Promise<SandboxProcessInstance> {
    this.starts.push(command);
    await command.onOutput?.({ stream: "stdout", data: "development server started\n" });
    return {
      id: `${this.id}-process`,
      wait: () => new Promise(() => {}),
      kill: async () => undefined,
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const bytes = this.files.get(path);
    if (!bytes) throw new Error(`Missing ${path}`);
    return bytes;
  }

  getUrl(port: number): string {
    return `https://${this.id}.preview.example.test:${port}/`;
  }

  async stop(_options?: SandboxOperationOptions): Promise<void> {
    this.stopCalls += 1;
  }
}

class PreviewSandboxAdapter implements SandboxAdapter {
  readonly provider = "preview-fixture";
  readonly capabilities = sandboxCapabilities({
    files: true,
    commands: true,
    portUrls: true,
    backgroundProcesses: true,
    reconnect: true,
  });
  readonly creates: SandboxCreateInput[] = [];
  readonly reconnects: SandboxReconnectInput[] = [];
  readonly instances = new Map<string, PreviewSandboxInstance>();
  runResult = { exitCode: 0, stdout: "", stderr: "", durationMs: 0 };
  createDelayMs = 0;
  #next = 0;

  async create(input: SandboxCreateInput): Promise<SandboxInstance> {
    this.creates.push(input);
    if (this.createDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.createDelayMs));
    }
    const instance = new PreviewSandboxInstance(`preview-${++this.#next}`);
    instance.runResult = this.runResult;
    this.instances.set(instance.id, instance);
    return instance;
  }

  async reconnect(input: SandboxReconnectInput): Promise<SandboxInstance> {
    this.reconnects.push(input);
    const instance = this.instances.get(input.sandboxId);
    if (!instance) throw new Error("Preview sandbox no longer exists.");
    return instance;
  }
}

const scope = { tenantId: "preview-tenant", userId: "preview-user" };
const defaultPreviewConfig: PreviewConfig = {
  files: [{ path: "preview.config.ts", content: "export const preview = true;\n" }],
  prepare: [{ command: "pnpm", args: ["install", "--frozen-lockfile"] }],
  start: { command: "pnpm", args: ["dev", "--host", "0.0.0.0"] },
  port: 3000,
  path: "/health",
  readiness: {
    timeoutMs: 1_000,
    intervalMs: 10,
    check: async () => true,
  },
};

function createPreviewViby(
  repository: MemoryRepository,
  sandbox: SandboxAdapter,
  preview: PreviewConfig = defaultPreviewConfig,
) {
  return createVibyWithDependencies({
    framework: "farm",
    model: "test/mock" as LanguageModel,
    skills: {},
    sandbox,
    preview,
  }, {
    repository,
    generator: new UnusedGenerator<"farm">(),
    skillResolver: new SkillResolver({}),
  });
}

async function importVersion(repository: MemoryRepository, sandbox: SandboxAdapter) {
  const viby = createPreviewViby(repository, sandbox);
  const chat = await viby.forUser(scope).chats.import({
    title: "Preview fixture",
    source: {
      type: "files",
      files: [
        { path: "package.json", content: '{"scripts":{"dev":"farm start"}}\n' },
        { path: "src/index.ts", content: "export const ready = true;\n" },
      ],
    },
  });
  const version = await chat.latestVersion();
  assert.ok(version);
  return { viby, version };
}

test("starts, persists, reconnects, and stops a durable version preview", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  const { viby: first, version } = await importVersion(repository, adapter);

  const preview = await version.preview({ env: { PREVIEW_FIXTURE: "true" } });
  assert.equal(preview.status, "ready");
  assert.equal(preview.url, "https://preview-1.preview.example.test:3000/health");
  assert.deepEqual(adapter.creates[0]?.ports, [3000]);
  assert.deepEqual(adapter.creates[0]?.env, { PREVIEW_FIXTURE: "true" });
  const { onOutput: _startOutput, ...started } = adapter.instances.get("preview-1")!.starts[0]!;
  assert.deepEqual(started, {
    command: "pnpm",
    args: ["dev", "--host", "0.0.0.0"],
    cwd: ".",
    env: {},
    timeoutMs: 300_000,
  });
  const { onOutput: _runOutput, ...prepared } = adapter.instances.get("preview-1")!.runs[0]!;
  assert.deepEqual(prepared, {
    command: "pnpm",
    args: ["install", "--frozen-lockfile"],
    cwd: ".",
    env: {},
    timeoutMs: 300_000,
  });
  assert.equal(
    Buffer.from(adapter.instances.get("preview-1")!.files.get("src/index.ts")!).toString(),
    "export const ready = true;\n",
  );
  assert.equal(
    Buffer.from(adapter.instances.get("preview-1")!.files.get("preview.config.ts")!).toString(),
    "export const preview = true;\n",
  );

  const second = createPreviewViby(repository, adapter);
  const restored = await second.forUser(scope).previews.get(preview.id);
  await restored.reconnect();
  assert.equal(restored.status, "ready");
  assert.equal(adapter.reconnects[0]?.sandboxId, "preview-1");
  assert.equal((await second.forUser(scope).previews.list({ versionId: version.id })).length, 1);

  await restored.stop();
  assert.equal(restored.status, "stopped");
  assert.ok(restored.data().stoppedAt);
  assert.equal((await second.forUser(scope).sandboxes.get(restored.data().sandboxLeaseId)).status, "stopped");

  await second.close();
  await first.close();
});

test("streams provider-neutral preview phases and terminal output", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  const { viby, version } = await importVersion(repository, adapter);
  const events: Array<{ readonly type: string; readonly data?: string }> = [];

  const preview = await version.preview({
    onEvent(event) {
      events.push({
        type: event.type,
        ...(event.type === "command.output" ? { data: event.data } : {}),
      });
    },
  });

  assert.equal(preview.status, "ready");
  assert.deepEqual(events.map((event) => event.type), [
    "preview.created",
    "workspace.prepared",
    "command.started",
    "command.output",
    "command.completed",
    "command.started",
    "command.output",
    "readiness.started",
    "preview.ready",
  ]);
  assert.deepEqual(events.filter((event) => event.type === "command.output"), [
    { type: "command.output", data: "dependencies installed\n" },
    { type: "command.output", data: "development server started\n" },
  ]);
  await viby.close();
});

test("coalesces concurrent preview starts for the same immutable version", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  adapter.createDelayMs = 20;
  const { viby, version } = await importVersion(repository, adapter);
  const firstEvents: string[] = [];
  const secondEvents: string[] = [];

  const [first, second] = await Promise.all([
    version.preview({ onEvent: (event) => { firstEvents.push(event.type); } }),
    version.preview({ onEvent: (event) => { secondEvents.push(event.type); } }),
  ]);

  assert.equal(first.id, second.id);
  assert.equal(adapter.creates.length, 1);
  assert.ok(firstEvents.includes("command.output"));
  assert.ok(secondEvents.includes("command.output"));
  await viby.close();
});

test("hosts configured durable previews without a product lifecycle callback", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  const { viby, version } = await importVersion(repository, adapter);
  const api = createVibyApi({
    viby,
    authenticate: () => scope,
    preview: true,
  });
  const url = `https://app.example/api/viby/chats/${version.chatId}/versions/${version.id}/preview`;

  const firstResponse = await api.fetch(new Request(url, { method: "POST" }));
  assert.equal(firstResponse.status, 201);
  const first = await firstResponse.json() as Record<string, unknown>;
  assert.equal(first.url, "https://preview-1.preview.example.test:3000/health");
  assert.equal(first.cached, false);

  const secondResponse = await api.fetch(new Request(url, { method: "POST" }));
  assert.equal(secondResponse.status, 201);
  const second = await secondResponse.json() as Record<string, unknown>;
  assert.equal(second.url, first.url);
  assert.equal(second.cached, true);
  assert.equal(adapter.creates.length, 1);

  await viby.close();
});

test("streams configured preview progress through the standard Web API", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  const { viby, version } = await importVersion(repository, adapter);
  const api = createVibyApi({
    viby,
    authenticate: () => scope,
    preview: true,
  });
  const response = await api.fetch(new Request(
    `https://app.example/api/viby/chats/${version.chatId}/versions/${version.id}/preview`,
    { method: "POST", headers: { Accept: "text/event-stream" } },
  ));

  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  const body = await response.text();
  assert.match(body, /event: command\.output/);
  assert.match(body, /dependencies installed/);
  assert.match(body, /development server started/);
  assert.match(body, /event: preview\.result/);
  await viby.close();
});

test("requires a durable reconnect-capable sandbox for previews", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  Object.assign(adapter, {
    capabilities: sandboxCapabilities({
      files: true,
      commands: true,
      portUrls: true,
      backgroundProcesses: true,
    }),
  });
  const { viby, version } = await importVersion(repository, adapter);

  await assert.rejects(() => version.preview(), /sandbox capability reconnect/);
  assert.equal(adapter.instances.get("preview-1")?.stopCalls, 1);
  assert.equal(repository.previewSessions.size, 0);
  await viby.close();
});

test("records preparation failures without starting the preview server", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  const { viby, version } = await importVersion(repository, adapter);
  adapter.runResult = {
    exitCode: 1,
    stdout: "",
    stderr: "lockfile is stale",
    durationMs: 1,
  };

  await assert.rejects(() => version.preview(), /could not become ready/);
  const instance = adapter.instances.get("preview-1");
  assert.ok(instance);
  assert.equal(instance.starts.length, 0);
  assert.equal(instance.stopCalls, 1);
  const [failed] = await viby.forUser(scope).previews.list({ status: "failed" });
  assert.match(failed?.error ?? "", /lockfile is stale/);
  await viby.close();
});

test("records a failed preview and releases its sandbox", async () => {
  const repository = new MemoryRepository();
  const adapter = new PreviewSandboxAdapter();
  const { viby: imported, version } = await importVersion(repository, adapter);
  await imported.close();

  const viby = createPreviewViby(repository, adapter, {
    start: { command: "pnpm", args: ["dev"] },
    port: 3000,
    readiness: {
      timeoutMs: 20,
      intervalMs: 10,
      check: async () => false,
    },
  });
  const restoredVersion = await viby.forUser(scope).chats.get(version.chatId)
    .then((chat) => chat.getVersion(version.id));

  await assert.rejects(() => restoredVersion.preview(), /could not become ready/);
  const [failed] = await viby.forUser(scope).previews.list({ status: "failed" });
  assert.equal(failed?.status, "failed");
  assert.match(failed?.error ?? "", /did not become ready/);
  assert.ok(failed?.stoppedAt);
  assert.equal(adapter.instances.get("preview-1")?.stopCalls, 1);
  await viby.close();
});
