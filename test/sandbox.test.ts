import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import { AgentProjectGenerator } from "../src/agent-runner.js";
import { createVibyWithDependencies } from "../src/client.js";
import {
  SandboxCommandApprovalRequiredError,
  SandboxCommandDeniedError,
  SandboxError,
  SandboxUnavailableError,
} from "../src/errors.js";
import type { GeneratorInput, GeneratorOutput, ProjectGenerator } from "../src/generator.js";
import type {
  SandboxAdapter,
  SandboxCommand,
  SandboxCommandPolicy,
  SandboxCommandPolicyRequest,
  SandboxCreateInput,
  SandboxFile,
  SandboxInstance,
  SandboxOperationOptions,
  SandboxOutputEvent,
  SandboxProcessInstance,
  SandboxReconnectInput,
} from "../src/sandbox.js";
import { SandboxSession, sandboxCapabilities, sandboxCommandPolicy } from "../src/sandbox.js";
import { SkillResolver } from "../src/skills.js";
import type { FrameworkId } from "../src/types.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const modelUsage = {
  inputTokens: { total: 10, noCache: 10, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 20, text: 20, reasoning: undefined },
};

function modelToolCall(toolCallId: string, toolName: string, input: unknown) {
  return {
    content: [{
      type: "tool-call" as const,
      toolCallId,
      toolName,
      input: JSON.stringify(input),
    }],
    finishReason: { unified: "tool-calls" as const, raw: undefined },
    usage: modelUsage,
    warnings: [],
  };
}

function modelCompletion(title: string, summary: string) {
  return {
    content: [{
      type: "text" as const,
      text: JSON.stringify({ outcome: "complete", title, summary, task: null }),
    }],
    finishReason: { unified: "stop" as const, raw: undefined },
    usage: modelUsage,
    warnings: [],
  };
}

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

function setup(sandbox?: SandboxAdapter, sandboxPolicy?: SandboxCommandPolicy) {
  const repository = new MemoryRepository();
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      skills: {},
      ...(sandbox ? { sandbox } : {}),
      ...(sandboxPolicy ? { sandboxPolicy } : {}),
    },
    {
      repository,
      generator: new UnusedGenerator<"farm">(),
      skillResolver: new SkillResolver({}),
    },
  );
  return { repository, viby };
}

async function importedVersion(sandbox?: SandboxAdapter, sandboxPolicy?: SandboxCommandPolicy) {
  const setupResult = setup(sandbox, sandboxPolicy);
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

test("does not treat failed HTTP preview responses as ready", async () => {
  let status = 410;
  const server = createServer((_request, response) => {
    response.writeHead(status, status === 302 ? { location: "/ready" } : undefined);
    response.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no port.");

  const instance = new FakeSandboxInstance();
  instance.getUrl = () => `http://127.0.0.1:${address.port}/`;
  const session = new SandboxSession(
    "fake",
    sandboxCapabilities({ files: true, commands: true, portUrls: true }),
    instance,
  );

  try {
    await assert.rejects(
      () => session.waitForPort(3000, { timeoutMs: 30, intervalMs: 10 }),
      (error: unknown) => error instanceof DOMException && error.name === "TimeoutError",
    );

    status = 302;
    assert.equal(
      await session.waitForPort(3000, { timeoutMs: 100, intervalMs: 10 }),
      `http://127.0.0.1:${address.port}/`,
    );
  } finally {
    await session.stop();
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
});

test("connects a capability-discovered sandbox to a generation agent and cleans it up", async () => {
  const adapter = new FakeSandboxAdapter();
  const repository = new MemoryRepository();
  let observedSandbox = false;
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model: "test/mock" as LanguageModel,
      skills: {},
      sandbox: adapter,
      agent: { maxDurationMs: 10_000, sandboxPorts: [3000] },
    },
    {
      repository,
      generator: {
        async generate(input): Promise<GeneratorOutput> {
          assert.ok(input.sandbox);
          observedSandbox = true;
          assert.equal(input.sandbox.supports("commands"), true);
          assert.equal(Buffer.from(await input.sandbox.readFile("test.js")).toString(), 'console.log("ready")\n');
          assert.equal((await input.sandbox.run({ command: "npm", args: ["test"] })).exitCode, 0);
          return {
            kind: "changes",
            title: "Sandbox verified",
            summary: "Verified the base version before editing.",
            changes: [{
              type: "write",
              path: "test.js",
              content: 'console.log("updated")\n',
              mediaType: "text/javascript",
            }],
            usage: {
              inputTokens: 1,
              inputTokenDetails: {
                noCacheTokens: 1,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
              },
              outputTokens: 1,
              outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
              totalTokens: 2,
            },
            finishReason: "stop",
          };
        },
      },
      skillResolver: new SkillResolver({}),
    },
  );
  const chat = await viby.forUser({ tenantId: "tenant-a", userId: "user-a" }).chats.import({
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
  const updated = await version.iterate({ prompt: "Verify and update the test" });

  assert.equal(observedSandbox, true);
  assert.equal(adapter.creates.length, 1);
  assert.deepEqual(adapter.creates[0]?.ports, [3000]);
  assert.equal(adapter.instances[0]?.stopCalls, 1);
  assert.equal((await updated.files()).find((file) => file.path === "test.js")?.content, 'console.log("updated")\n');
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

test("enforces custom command policy before every adapter execution", async () => {
  const adapter = new FakeSandboxAdapter();
  const requests: SandboxCommandPolicyRequest[] = [];
  const { version, viby } = await importedVersion(adapter, async (request) => {
    requests.push(request);
    if (request.action === "start") return { allow: false, reason: "Background services require approval." };
    if (request.command.command === "rm") return { allow: false, reason: "Destructive commands are disabled." };
    return { allow: true };
  });
  const session = await version.sandbox();

  await session.run({
    command: "node",
    args: ["script.js"],
    cwd: "src",
    env: { TOKEN: "secret-value", CI: "true" },
    timeoutMs: 5_000,
  });
  assert.deepEqual(requests[0], {
    action: "run",
    provider: "fake",
    context: {
      tenantId: "tenant-a",
      userId: "user-a",
      chatId: version.chatId,
      versionId: version.id,
      framework: "farm",
    },
    command: {
      command: "node",
      args: ["script.js"],
      cwd: "src",
      environment: ["CI", "TOKEN"],
      timeoutMs: 5_000,
    },
  });
  assert.equal(JSON.stringify(requests).includes("secret-value"), false);

  await assert.rejects(
    () => session.run({ command: "rm", args: ["-rf", "dist"] }),
    (error: unknown) => error instanceof SandboxCommandDeniedError
      && error.code === "sandbox_command_denied"
      && error.action === "run",
  );
  await assert.rejects(
    () => session.start({ command: "pnpm", args: ["dev"] }),
    /Background services require approval/,
  );
  assert.equal(adapter.instances[0]!.commands.length, 1);
  assert.equal(adapter.instances[0]!.backgroundCommands.length, 0);
  await viby.close();
});

test("binds approval grants to one exact sandbox action without exposing secrets", async () => {
  const adapter = new FakeSandboxAdapter();
  const policy: SandboxCommandPolicy = () => ({
    decision: "approval-required",
    reason: "Commands require a user decision.",
  });
  const { version, viby } = await importedVersion(adapter, policy);
  const session = await version.sandbox();
  const command = {
    command: "pnpm",
    args: ["test"],
    env: { API_TOKEN: "never-persist-this" },
    timeoutMs: 5_000,
  };
  let approval: SandboxCommandApprovalRequiredError | undefined;

  await assert.rejects(
    () => session.authorizeCommand(command),
    (error: unknown) => {
      assert.ok(error instanceof SandboxCommandApprovalRequiredError);
      approval = error;
      return true;
    },
  );
  assert.ok(approval);
  assert.deepEqual(approval.proposedAction.command.environment, ["API_TOKEN"]);
  assert.equal(JSON.stringify(approval.proposedAction).includes("never-persist-this"), false);
  assert.equal(adapter.instances[0]!.commands.length, 0);

  const approvedInstance = new FakeSandboxInstance();
  const approvedSession = new SandboxSession(
    adapter.provider,
    adapter.capabilities,
    approvedInstance,
    undefined,
    undefined,
    {
      policy,
      context: approval.proposedAction.context!,
      approvedActionKeys: new Set([approval.proposedAction.idempotencyKey]),
    },
  );
  const grant = await approvedSession.authorizeCommand(command);
  await assert.rejects(
    () => approvedSession.run({ ...command, args: ["build"] }, grant),
    /approval grant is invalid/,
  );
  await approvedSession.run(command, grant);
  await assert.rejects(() => approvedSession.run(command, grant), /approval grant is invalid/);
  assert.equal(approvedInstance.commands.length, 1);

  const deniedInstance = new FakeSandboxInstance();
  const deniedSession = new SandboxSession(
    adapter.provider,
    adapter.capabilities,
    deniedInstance,
    undefined,
    undefined,
    {
      policy,
      context: approval.proposedAction.context!,
      deniedActionKeys: new Set([approval.proposedAction.idempotencyKey]),
    },
  );
  await assert.rejects(
    () => deniedSession.authorizeCommand(command),
    (error: unknown) => error instanceof SandboxCommandDeniedError
      && error.reason === "The proposed action was denied.",
  );
  assert.equal(deniedInstance.commands.length, 0);

  const background = { command: "pnpm", args: ["dev"] };
  let backgroundApproval: SandboxCommandApprovalRequiredError | undefined;
  await assert.rejects(
    () => approvedSession.authorizeCommand(background, "start"),
    (error: unknown) => {
      assert.ok(error instanceof SandboxCommandApprovalRequiredError);
      backgroundApproval = error;
      return true;
    },
  );
  assert.ok(backgroundApproval);
  const backgroundSession = new SandboxSession(
    adapter.provider,
    adapter.capabilities,
    approvedInstance,
    undefined,
    undefined,
    {
      policy,
      context: backgroundApproval.proposedAction.context!,
      approvedActionKeys: new Set([backgroundApproval.proposedAction.idempotencyKey]),
    },
  );
  const backgroundGrant = await backgroundSession.authorizeCommand(background, "start");
  await backgroundSession.start(background, backgroundGrant);
  assert.equal(approvedInstance.backgroundCommands.length, 1);
  await session.stop();
  await approvedSession.stop();
  await deniedSession.stop();
  await backgroundSession.stop();
  await viby.close();
});

test("pauses an agent command for approval and resumes it idempotently", async () => {
  const adapter = new FakeSandboxAdapter();
  const repository = new MemoryRepository();
  const commandInput = {
    command: "pnpm",
    args: ["test"],
    cwd: null,
    timeoutMs: null,
  };
  const model = new MockLanguageModelV4({
    doGenerate: [
      modelToolCall("approval-command", "sandbox_run_command", commandInput),
      modelToolCall("approved-command", "sandbox_run_command", commandInput),
      modelToolCall("replayed-command", "sandbox_run_command", commandInput),
      modelToolCall("write-after-approval", "workspace_write_file", {
        path: "test.js",
        content: 'console.log("approved")\n',
        mediaType: "text/javascript",
      }),
      modelCompletion("Approved iteration", "Ran the approved command and updated the project."),
    ],
  });
  const viby = createVibyWithDependencies(
    {
      framework: "farm",
      model,
      skills: {},
      sandbox: adapter,
      sandboxPolicy: () => ({
        decision: "approval-required",
        reason: "A user must approve package scripts.",
      }),
      agent: {
        maxSteps: 10,
        maxDurationMs: 10_000,
        maxTokens: 10_000,
        maxCommands: 4,
      },
    },
    {
      repository,
      generator: new AgentProjectGenerator(model, {
        maxSteps: 10,
        maxDurationMs: 10_000,
        maxTokens: 10_000,
        maxCommands: 4,
      }),
      skillResolver: new SkillResolver({}),
    },
  );
  const chat = await viby.forUser({ tenantId: "tenant-a", userId: "user-a" }).chats.import({
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
  const generation = await version.startIteration({ prompt: "Test, then update the project" });

  let outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "waiting");
  if (outcome.status !== "waiting") throw new Error("Expected an approval task");
  const [task] = outcome.tasks;
  assert.equal(task?.kind, "permission");
  if (!task || task.kind !== "permission") throw new Error("Expected a permission task");
  assert.equal(task.proposedAction?.type, "sandbox-command");
  assert.equal(task.proposedAction?.command.command, "pnpm");
  assert.equal(adapter.instances[0]!.commands.length, 0);

  await generation.resolve({
    taskId: task.id,
    resolution: { kind: "permission", decision: "allow" },
  });
  outcome = await generation.wait({ pollIntervalMs: 10 });
  assert.equal(outcome.status, "succeeded");
  assert.equal(adapter.instances[1]!.commands.length, 1);
  assert.equal(adapter.instances.reduce((total, instance) => total + instance.commands.length, 0), 1);

  const calls = await generation.toolCalls();
  const commandCall = calls.find((call) => call.name === "sandbox.run-command");
  assert.ok(commandCall);
  assert.equal(commandCall.effect, "external");
  assert.equal(commandCall.idempotencyKey, task.proposedAction?.idempotencyKey);
  assert.equal(commandCall.status, "succeeded");
  assert.equal(calls.filter((call) => call.name === "sandbox.run-command").length, 1);
  const events = (await generation.events({ limit: 100 })).events;
  assert.equal(events.some((event) => event.type === "part.failed"), false);
  assert.equal(events.filter((event) => (
    event.type === "part.completed" && event.data.part.type === "command"
  )).length, 2);
  assert.equal((await generation.attempts()).length, 2);
  assert.equal((await generation.tasks())[0]?.status, "resolved");
  await viby.close();
});

test("builds a declarative fail-closed sandbox command policy", async () => {
  const adapter = new FakeSandboxAdapter();
  const policy = sandboxCommandPolicy({
    allowCommands: ["pnpm"],
    denyCommands: ["sudo"],
    actions: ["run"],
    environment: ["CI"],
    maxTimeoutMs: 1_000,
    maxArgs: 2,
  });
  const { version, viby } = await importedVersion(adapter, policy);
  const session = await version.sandbox();
  await session.run({ command: "pnpm", args: ["test"], env: { CI: "true" }, timeoutMs: 1_000 });
  await assert.rejects(() => session.run({ command: "node" }), /command allowlist/);
  await assert.rejects(
    () => session.run({ command: "pnpm", env: { TOKEN: "hidden" }, timeoutMs: 1_000 }),
    /Environment variable TOKEN/,
  );
  await assert.rejects(
    () => session.run({ command: "pnpm", timeoutMs: 1_001 }),
    /timeout exceeds/,
  );
  await assert.rejects(() => session.start({ command: "pnpm" }), /start commands are not allowed/);
  assert.equal(adapter.instances[0]!.commands.length, 1);
  assert.throws(
    () => sandboxCommandPolicy({ allowCommands: ["node"], denyCommands: ["node"] }),
    /both allow and deny/,
  );
  await viby.close();

  const failing = new FakeSandboxAdapter();
  const failed = await importedVersion(failing, async () => {
    throw new Error("policy backend unavailable");
  });
  const failedSession = await failed.version.sandbox();
  await assert.rejects(
    () => failedSession.run({ command: "node" }),
    /command policy failed: policy backend unavailable/,
  );
  assert.equal(failing.instances[0]!.commands.length, 0);
  await failed.viby.close();
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
