import assert from "node:assert/strict";
import { test } from "node:test";
import {
  e2bSandbox,
  type E2BSandboxClient,
  type E2BSandboxFactoryInput,
} from "../src/sandbox-e2b.js";
import type { SandboxOutputEvent } from "../src/sandbox.js";

class FakeE2BClient implements E2BSandboxClient {
  readonly sandboxId = "e2b_test";
  readonly writes: Array<{ path: string; data: string | ArrayBuffer }> = [];
  readonly reads: string[] = [];
  readonly commandsRun: Array<{ command: string; options: Record<string, unknown> }> = [];
  killed = false;
  commandFailure: unknown = null;

  readonly files = {
    write: async (
      files: { path: string; data: string | ArrayBuffer }[],
    ): Promise<void> => {
      this.writes.push(...files);
    },
    read: async (path: string): Promise<Uint8Array> => {
      this.reads.push(path);
      return Buffer.from("artifact");
    },
  };

  readonly commands = {
    run: async (command: string, options: {
      cwd: string;
      envs: Record<string, string>;
      timeoutMs: number;
      signal?: AbortSignal;
      onStdout?: (data: string) => void | Promise<void>;
      onStderr?: (data: string) => void | Promise<void>;
    }) => {
      this.commandsRun.push({ command, options });
      await options.onStdout?.("out\n");
      await options.onStderr?.("err\n");
      if (this.commandFailure) throw this.commandFailure;
      return { exitCode: 0, stdout: "out\n", stderr: "err\n" };
    },
  };

  getHost(port: number): string {
    return `${port}-e2b.example`;
  }

  async kill(): Promise<void> {
    this.killed = true;
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

test("maps the common sandbox contract to E2B", async () => {
  const client = new FakeE2BClient();
  let factoryInput: E2BSandboxFactoryInput | undefined;
  const adapter = e2bSandbox(
    {
      apiKey: "e2b_test_key",
      template: "custom-template",
      domain: "example.internal",
      requestTimeoutMs: 10_000,
      secure: true,
      metadata: { product: "viby" },
    },
    async (input) => {
      factoryInput = input;
      return client;
    },
  );

  const instance = await adapter.create(createInput);
  assert.equal(instance.id, "e2b_test");
  assert.deepEqual(factoryInput, {
    template: "custom-template",
    options: {
      apiKey: "e2b_test_key",
      domain: "example.internal",
      requestTimeoutMs: 10_000,
      secure: true,
      metadata: { product: "viby" },
      envs: { NODE_ENV: "test" },
      timeoutMs: 60_000,
    },
  });

  await instance.writeFiles([
    { path: "src/index.ts", content: "export {};\n" },
    { path: "asset.bin", content: new Uint8Array([1, 2, 3]) },
  ]);
  assert.equal(client.writes[0]?.path, "/home/user/viby/src/index.ts");
  assert.equal(client.writes[0]?.data, "export {};\n");
  assert.equal(client.writes[1]?.path, "/home/user/viby/asset.bin");
  assert.deepEqual(new Uint8Array(client.writes[1]?.data as ArrayBuffer), new Uint8Array([1, 2, 3]));

  const events: SandboxOutputEvent[] = [];
  const result = await instance.run({
    command: "node",
    args: ["-e", "console.log('safe')", "a b", "$(not-executed)"],
    cwd: "src",
    env: { FEATURE: "on" },
    timeoutMs: 5_000,
    onOutput: (event) => {
      events.push(event);
    },
  });
  assert.equal(
    client.commandsRun[0]?.command,
    `'node' '-e' 'console.log('"'"'safe'"'"')' 'a b' '$(not-executed)'`,
  );
  assert.deepEqual(client.commandsRun[0]?.options, {
    cwd: "/home/user/viby/src",
    envs: { FEATURE: "on" },
    timeoutMs: 5_000,
    onStdout: (client.commandsRun[0]?.options as { onStdout: unknown }).onStdout,
    onStderr: (client.commandsRun[0]?.options as { onStderr: unknown }).onStderr,
  });
  assert.equal(result.exitCode, 0);
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(events, [
    { stream: "stdout", data: "out\n" },
    { stream: "stderr", data: "err\n" },
  ]);

  assert.equal(Buffer.from(await instance.readFile("dist/app.js")).toString(), "artifact");
  assert.deepEqual(client.reads, ["/home/user/viby/dist/app.js"]);
  assert.equal(await instance.getUrl?.(3000), "https://3000-e2b.example");
  await instance.stop();
  assert.equal(client.killed, true);
});

test("normalizes E2B non-zero exits without swallowing transport failures", async () => {
  const client = new FakeE2BClient();
  const adapter = e2bSandbox({}, async () => client);
  const instance = await adapter.create(createInput);

  client.commandFailure = Object.assign(new Error("command failed"), {
    exitCode: 7,
    stdout: "partial",
    stderr: "failure",
  });
  const result = await instance.run({ command: "false", args: [], cwd: ".", env: {}, timeoutMs: 1_000 });
  assert.deepEqual(
    { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr },
    { exitCode: 7, stdout: "partial", stderr: "failure" },
  );

  client.commandFailure = new Error("network unavailable");
  await assert.rejects(
    () => instance.run({ command: "true", args: [], cwd: ".", env: {}, timeoutMs: 1_000 }),
    /network unavailable/,
  );
});
