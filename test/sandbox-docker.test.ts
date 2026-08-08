import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import type { SandboxOutputEvent } from "../src/sandbox.js";
import {
  dockerSandbox,
  type DockerProcessInput,
  type DockerProcessResult,
  type DockerProcessRunner,
} from "../src/sandbox-docker.js";

class FakeDockerRunner implements DockerProcessRunner {
  readonly calls: DockerProcessInput[] = [];
  commandExitCode = 3;
  commandStderr = "test failure\n";
  removed = 0;

  async run(input: DockerProcessInput): Promise<DockerProcessResult> {
    this.calls.push(input);
    const operation = input.args[0];
    if (operation === "run") return result(0, "container_test\n");
    if (operation === "port") return result(0, "127.0.0.1:49152\n");
    if (operation === "rm") {
      this.removed += 1;
      return result(0, "container_test\n");
    }
    if (operation === "exec" && input.args.includes("cat")) {
      return result(0, new Uint8Array([0, 1, 2]));
    }
    if (operation === "exec" && input.args.includes("viby-write")) {
      return result(0, "");
    }
    await input.onStdout?.("out\n");
    await input.onStderr?.(this.commandStderr);
    return result(this.commandExitCode, "out\n", this.commandStderr);
  }
}

const createInput = {
  context: {
    tenantId: "tenant-a",
    userId: "user-a",
    chatId: "chat-a",
    versionId: "version-a",
    framework: "farm",
  },
  timeoutMs: 60_000,
  env: { NODE_ENV: "test" },
  ports: [3000],
} as const;

test("runs the common sandbox contract through a hardened Docker container", async () => {
  const runner = new FakeDockerRunner();
  const adapter = dockerSandbox({
    image: "node:24-bookworm-slim",
    pull: "never",
    network: "viby-network",
    platform: "linux/amd64",
    user: "1000:1000",
    cpus: 2,
    memoryMb: 2_048,
    pidsLimit: 128,
    workspaceSizeMb: 4_096,
  }, runner);
  const instance = await adapter.create(createInput);
  assert.equal(instance.id, "container_test");

  const create = runner.calls[0]!;
  assert.equal(create.executable, "docker");
  assert.deepEqual(create.args.slice(0, 8), [
    "run",
    "--detach",
    "--rm",
    "--init",
    "--pull",
    "never",
    "--label",
    "com.viby.sandbox=true",
  ]);
  for (const required of [
    "--read-only",
    "--cap-drop",
    "no-new-privileges",
    "--pids-limit",
    "--memory",
    "--cpus",
    "--tmpfs",
    "--network",
    "--publish",
  ]) {
    assert.ok(create.args.includes(required), `missing Docker hardening argument ${required}`);
  }
  assert.equal(create.args.includes("--volume"), false);
  assert.equal(create.args.includes("--mount"), false);
  assert.ok(create.args.includes("127.0.0.1::3000"));
  assert.ok(create.args.includes("NODE_ENV=test"));

  const source = Buffer.from("console.log('safe')\n");
  await instance.writeFiles([{ path: "src/index.js", content: source }]);
  const write = runner.calls[1]!;
  assert.deepEqual(write.stdin, source);
  assert.equal(write.args.at(-1), "/workspace/src/index.js");
  assert.equal(write.args.includes("console.log('safe')"), false);

  const output: SandboxOutputEvent[] = [];
  const command = await instance.run({
    command: "node",
    args: ["src/index.js", "$(not-executed)", "a b"],
    cwd: ".",
    env: { FEATURE: "enabled" },
    timeoutMs: 5_000,
    onOutput: (event) => {
      output.push(event);
    },
  });
  const exec = runner.calls[2]!;
  assert.deepEqual(exec.args.slice(-5), [
    "container_test",
    "node",
    "src/index.js",
    "$(not-executed)",
    "a b",
  ]);
  assert.ok(exec.args.includes("FEATURE=enabled"));
  assert.deepEqual(command, {
    exitCode: 3,
    stdout: "out\n",
    stderr: "test failure\n",
    durationMs: 4,
  });
  assert.deepEqual(output, [
    { stream: "stdout", data: "out\n" },
    { stream: "stderr", data: "test failure\n" },
  ]);

  assert.deepEqual(await instance.readFile("dist/output.bin"), new Uint8Array([0, 1, 2]));
  assert.equal(await instance.getUrl?.(3000), "http://127.0.0.1:49152");
  await instance.stop();
  await instance.stop();
  assert.equal(runner.removed, 1);
});

test("validates Docker limits and distinguishes daemon failures", async () => {
  assert.throws(() => dockerSandbox({ image: " " }), ConfigurationError);
  assert.throws(() => dockerSandbox({ cpus: 0 }), /Docker CPUs/);
  assert.throws(() => dockerSandbox({ memoryMb: 64 }), /Docker memory/);
  assert.throws(() => dockerSandbox({ idleCommand: [] }), /idleCommand/);

  const runner = new FakeDockerRunner();
  runner.commandExitCode = 125;
  runner.commandStderr = "daemon unavailable";
  const instance = await dockerSandbox({}, runner).create(createInput);
  await assert.rejects(
    () => instance.run({ command: "node", args: [], cwd: ".", env: {}, timeoutMs: 1_000 }),
    /daemon unavailable/,
  );
  await instance.stop();
});

function result(
  exitCode: number,
  stdout: string | Uint8Array,
  stderr: string | Uint8Array = "",
): DockerProcessResult {
  return {
    exitCode,
    stdout: typeof stdout === "string" ? Buffer.from(stdout) : stdout,
    stderr: typeof stderr === "string" ? Buffer.from(stderr) : stderr,
    durationMs: 4,
  };
}
