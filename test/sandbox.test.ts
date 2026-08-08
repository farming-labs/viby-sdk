import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { createVibyWithDependencies } from "../src/client.js";
import { SandboxError, SandboxUnavailableError } from "../src/errors.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
  SandboxOperationOptions,
  SandboxOutputEvent,
  SandboxProcessInstance,
  SandboxReconnectInput,
} from "../src/sandbox.js";
import { sandboxCapabilities } from "../src/sandbox.js";
import { SkillResolver } from "../src/skills.js";
import type { FrameworkId } from "../src/types.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

class UnusedGenerator<Framework extends FrameworkId> implements ProjectGenerator<Framework> {
  async generate(_input: GeneratorInput<Framework>): Promise<GeneratorOutput> {
    throw new Error("The sandbox tests do not invoke the model.");
  }
}

class FakeSandboxInstance implements SandboxInstance {
  readonly id = "sandbox_test";
  readonly files = new Map<string, Uint8Array>();
  readonly commands: SandboxCommand[] = [];
  readonly backgroundCommands: SandboxCommand[] = [];
  backgroundKillCalls = 0;
  stopCalls = 0;
  failWrites = false;

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    if (this.failWrites) throw new Error("disk unavailable");
    for (const file of files) {
      this.files.set(
        file.path,
        typeof file.content === "string" ? Buffer.from(file.content) : file.content,
      );
    }
  }

  async run(command: SandboxCommand) {
    this.commands.push(command);
    await command.onOutput?.({ stream: "stdout", data: "ready\n" });
    await command.onOutput?.({ stream: "stderr", data: "warning\n" });
    return {
      exitCode: 0,
      stdout: "ready\n",
      stderr: "warning\n",
      durationMs: 12,
    };
  }

  async start(command: SandboxCommand): Promise<SandboxProcessInstance> {
    this.backgroundCommands.push(command);
    await command.onOutput?.({ stream: "stdout", data: "server-started\n" });
    return {
      id: "process_test",
      wait: async () => ({
        exitCode: 0,
        stdout: "server-started\n",
        stderr: "",
        durationMs: 20,
      }),
      kill: async () => {
        this.backgroundKillCalls += 1;
      },
    };
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (!content) throw new Error("missing file");
    return content;
  }

  getUrl(port: number): string {
    return `https://sandbox.example/${port}`;
  }

  async stop(_options?: SandboxOperationOptions): Promise<void> {
    this.stopCalls += 1;
  }
}

class FakeSandboxAdapter implements SandboxAdapter {
  readonly provider = "fake";
  readonly capabilities = sandboxCapabilities({
    files: true,
    commands: true,
    commandStreaming: true,
    portUrls: true,
    backgroundProcesses: true,
    reconnect: true,
  });
  readonly creates: SandboxCreateInput[] = [];
  readonly reconnects: SandboxReconnectInput[] = [];
  readonly instances: FakeSandboxInstance[] = [];
  failWrites = false;

  async create(input: SandboxCreateInput): Promise<SandboxInstance> {
    this.creates.push(input);
    const instance = new FakeSandboxInstance();
    instance.failWrites = this.failWrites;
    this.instances.push(instance);
    return instance;
  }

  async reconnect(input: SandboxReconnectInput): Promise<SandboxInstance> {
    this.reconnects.push(input);
    const instance = new FakeSandboxInstance();
    this.instances.push(instance);
    return instance;
  }
}

function setup(sandbox?: SandboxAdapter) {
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      skills: {},
      ...(sandbox ? { sandbox } : {}),
    },
    {
      repository,
      generator: new UnusedGenerator<"farm">(),
      skillResolver: new SkillResolver({}),
    },
  );
  return { repository, viby };
}

async function importedVersion(sandbox?: SandboxAdapter) {
  const setupResult = setup(sandbox);
  const chat = await setupResult.viby
    .forUser({ tenantId: "tenant-a", userId: "user-a" })
    .chats.import({
      title: "Sandbox app",
      source: {
        type: "files",
        files: [
          { path: "package.json", content: '{"scripts":{"test":"node test.js"}}\n' },
          { path: "test.js", content: 'console.log("ready")\n' },
        ],
      },
    });
  const version = await chat.latestVersion();
  assert.ok(version);
  return { ...setupResult, version };
}

test("materializes an immutable version through a provider-agnostic sandbox adapter", async () => {
  const adapter = new FakeSandboxAdapter();
  const { version, viby } = await importedVersion(adapter);
  const session = await version.sandbox({
    timeoutMs: 60_000,
    env: { NODE_ENV: "test" },
    ports: [3000],
  });

  assert.equal(session.id, "sandbox_test");
  assert.equal(session.provider, "fake");
  assert.equal(session.supports("commandStreaming"), true);
  assert.equal(session.supports("backgroundProcesses"), true);
  assert.deepEqual(session.capabilities, adapter.capabilities);
  assert.deepEqual(adapter.creates[0], {
    context: {
      tenantId: "tenant-a",
      userId: "user-a",
      chatId: version.chatId,
      versionId: version.id,
      framework: "farm",
    },
    timeoutMs: 60_000,
    env: { NODE_ENV: "test" },
    ports: [3000],
  });
  assert.deepEqual([...adapter.instances[0]!.files.keys()], ["package.json", "test.js"]);

  const output: SandboxOutputEvent[] = [];
  const result = await session.run({
    command: "npm",
    args: ["test"],
    onOutput: (event) => {
      output.push(event);
    },
  });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(output, [
    { stream: "stdout", data: "ready\n" },
    { stream: "stderr", data: "warning\n" },
  ]);
  assert.deepEqual(adapter.instances[0]!.commands[0], {
    command: "npm",
    args: ["test"],
    cwd: ".",
    env: {},
    timeoutMs: 300_000,
    onOutput: adapter.instances[0]!.commands[0]!.onOutput,
  });
  assert.equal(Buffer.from(await session.readFile("test.js")).toString(), 'console.log("ready")\n');
  assert.equal(await session.url(3000), "https://sandbox.example/3000");

  const backgroundOutput: SandboxOutputEvent[] = [];
  const process = await session.start({
    command: "npm",
    args: ["run", "dev"],
    onOutput: (event) => {
      backgroundOutput.push(event);
    },
  });
  assert.equal(process.id, "process_test");
  assert.deepEqual(backgroundOutput, [{ stream: "stdout", data: "server-started\n" }]);
  assert.equal((await process.wait()).exitCode, 0);
  await process.kill();
  await process.kill();
  assert.equal(adapter.instances[0]!.backgroundKillCalls, 1);

  let readinessChecks = 0;
  assert.equal(await session.waitForPort(3000, {
    path: "/health",
    intervalMs: 10,
    check: async (url) => {
      readinessChecks += 1;
      assert.equal(url, "https://sandbox.example/health");
      return readinessChecks === 2;
    },
  }), "https://sandbox.example/health");
  await assert.rejects(
    () => session.waitForPort(3000, { path: "//untrusted.example/health" }),
    /absolute URL path/,
  );

  await session.stop();
  await session.stop();
  assert.equal(session.stopped, true);
  assert.equal(adapter.instances[0]!.stopCalls, 1);
  await assert.rejects(() => session.run({ command: "npm" }), SandboxError);
  await viby.close();
});

test("validates sandbox input and requires an adapter", async () => {
  const withoutAdapter = await importedVersion();
  await assert.rejects(() => withoutAdapter.version.sandbox(), SandboxUnavailableError);
  await withoutAdapter.viby.close();

  const adapter = new FakeSandboxAdapter();
  const { version, viby } = await importedVersion(adapter);
  await assert.rejects(
    () => version.sandbox({ env: { "INVALID-NAME": "value" } }),
    /environment variable is invalid/,
  );
  await assert.rejects(
    () => version.sandbox({ ports: [3000, 3000] }),
    /cannot contain duplicates/,
  );
  const session = await version.sandbox();
  await assert.rejects(
    () => session.run({ command: "npm", cwd: "../outside" }),
    /unsafe/,
  );
  await session.stop();
  await viby.close();

  const incomplete = await importedVersion({
    provider: "incomplete",
    capabilities: sandboxCapabilities({ commands: true }),
    create: (input) => adapter.create(input),
  });
  await assert.rejects(
    () => incomplete.version.sandbox(),
    /must support files and commands/,
  );
  await incomplete.viby.close();

  const foregroundOnly = await importedVersion({
    provider: "foreground-only",
    capabilities: sandboxCapabilities({ files: true, commands: true }),
    create: (input) => adapter.create(input),
  });
  const foregroundSession = await foregroundOnly.version.sandbox();
  await assert.rejects(
    () => foregroundSession.start({ command: "server" }),
    SandboxUnavailableError,
  );
  await assert.rejects(
    () => foregroundSession.waitForPort(3000),
    SandboxUnavailableError,
  );
  await assert.rejects(
    () => foregroundOnly.viby
      .forUser({ tenantId: "tenant-a", userId: "user-a" })
      .sandboxes.reconnect(foregroundSession.leaseId!),
    /does not support reconnecting by id/,
  );
  await foregroundOnly.viby.close();
});

test("persists tenant-scoped leases and reconnects through the configured adapter", async () => {
  const adapter = new FakeSandboxAdapter();
  const { version, viby, repository } = await importedVersion(adapter);
  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  const session = await version.sandbox({ timeoutMs: 60_000, ports: [3000] });
  assert.ok(session.leaseId);

  const lease = await user.sandboxes.get(session.leaseId);
  assert.equal(lease.sandboxId, session.id);
  assert.equal(lease.provider, "fake");
  assert.equal(lease.status, "active");
  assert.equal(lease.context.versionId, version.id);
  assert.deepEqual(lease.ports, [3000]);
  assert.equal("env" in lease, false);

  await assert.rejects(
    () => viby.forUser({ tenantId: "tenant-a", userId: "user-b" }).sandboxes.get(session.leaseId!),
    /Sandbox lease was not found/,
  );
  const reconnected = await user.sandboxes.reconnect(session.leaseId);
  assert.equal(reconnected.id, session.id);
  assert.equal(reconnected.leaseId, session.leaseId);
  assert.deepEqual(adapter.reconnects[0], {
    sandboxId: "sandbox_test",
    context: lease.context,
    ports: [3000],
    expiresAt: lease.expiresAt,
  });
  assert.equal(adapter.instances[1]!.files.size, 0);

  await reconnected.stop();
  assert.equal((await user.sandboxes.get(session.leaseId)).status, "stopped");
  await assert.rejects(
    () => user.sandboxes.reconnect(session.leaseId!),
    /lease is stopped/,
  );
  assert.equal(repository.sandboxLeases.size, 1);
  await viby.close();
});

test("expires stale leases before an adapter can reconnect", async () => {
  const adapter = new FakeSandboxAdapter();
  const { version, viby, repository } = await importedVersion(adapter);
  const session = await version.sandbox();
  const persisted = repository.sandboxLeases.get(session.leaseId!);
  assert.ok(persisted);
  repository.sandboxLeases.set(session.leaseId!, {
    ...persisted,
    expiresAt: new Date(Date.now() - 1),
  });

  const user = viby.forUser({ tenantId: "tenant-a", userId: "user-a" });
  await assert.rejects(() => user.sandboxes.reconnect(session.leaseId!), /lease has expired/);
  assert.equal((await user.sandboxes.get(session.leaseId!)).status, "expired");
  assert.equal(adapter.reconnects.length, 0);
  await viby.close();
});

test("normalizes immutable provider-agnostic capability records", () => {
  const capabilities = sandboxCapabilities({ files: true, commands: true });
  assert.deepEqual(capabilities, {
    files: true,
    commands: true,
    commandStreaming: false,
    portUrls: false,
    backgroundProcesses: false,
    reconnect: false,
    snapshots: false,
  });
  assert.equal(Object.isFrozen(capabilities), true);
  assert.throws(
    () => sandboxCapabilities({ vendorFeature: true } as never),
    /Unknown sandbox capability/,
  );
});

test("cleans up failed materialization and active sessions on client close", async () => {
  const failing = new FakeSandboxAdapter();
  failing.failWrites = true;
  const failed = await importedVersion(failing);
  await assert.rejects(() => failed.version.sandbox(), /disk unavailable/);
  assert.equal(failing.instances[0]!.stopCalls, 1);
  await failed.viby.close();

  const adapter = new FakeSandboxAdapter();
  const active = await importedVersion(adapter);
  const session = await active.version.sandbox();
  assert.equal(session.stopped, false);
  await active.viby.close();
  assert.equal(session.stopped, true);
  assert.equal(adapter.instances[0]!.stopCalls, 1);
});
