import assert from "node:assert/strict";
import { test } from "node:test";
import type { Writable } from "node:stream";
import { ConfigurationError } from "../src/errors.js";
import type { SandboxOutputEvent } from "../src/sandbox.js";
import {
  vercelSandbox,
  type VercelSandboxClient,
  type VercelCommandHandle,
  type VercelSandboxConnectorInput,
  type VercelSandboxFactoryInput,
} from "../src/sandbox-vercel.js";

class FakeVercelClient implements VercelSandboxClient {
  readonly name = "viby-test";
  readonly cwd = "/vercel/sandbox";
  readonly writes: Array<{ path: string; content: string | Uint8Array }> = [];
  readonly reads: string[] = [];
  readonly commands: Array<Record<string, unknown>> = [];
  stopped = false;
  missingFile = false;
  backgroundKilled = 0;

  async writeFiles(files: { path: string; content: string | Uint8Array }[]): Promise<void> {
    this.writes.push(...files);
  }

  async readFileToBuffer(file: { path: string }): Promise<Buffer | null> {
    this.reads.push(file.path);
    return this.missingFile ? null : Buffer.from("built output");
  }

  async runCommand(input: {
    cmd: string;
    args: string[];
    cwd: string;
    env: Record<string, string>;
    timeoutMs: number;
    detached?: boolean;
    signal?: AbortSignal;
    stdout?: Writable;
    stderr?: Writable;
  }) {
    this.commands.push(input);
    await writeStream(input.stdout, "out\n");
    await writeStream(input.stderr, "err\n");
    if (input.detached) {
      const client = this;
      return {
        cmdId: "cmd_background",
        async wait() {
          return {
            exitCode: 0,
            durationMs: 25,
            async stdout() { return "server-ready\n"; },
            async stderr() { return ""; },
          };
        },
        async kill() {
          client.backgroundKilled += 1;
        },
        async stdout() { return "server-ready\n"; },
        async stderr() { return ""; },
      } satisfies VercelCommandHandle;
    }
    return {
      exitCode: 2,
      durationMs: 18,
      async stdout() { return "out\n"; },
      async stderr() { return "err\n"; },
    };
  }

  domain(port: number): string {
    return `https://${port}-viby.vercel.run`;
  }

  async stop(): Promise<void> {
    this.stopped = true;
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
  timeoutMs: 120_000,
  env: { NODE_ENV: "test" },
  ports: [3000, 4173],
} as const;

test("maps the common sandbox contract to Vercel Sandbox", async () => {
  const client = new FakeVercelClient();
  let factoryInput: VercelSandboxFactoryInput | undefined;
  let connectorInput: VercelSandboxConnectorInput | undefined;
  const adapter = vercelSandbox(
    {
      token: "token",
      teamId: "team",
      projectId: "project",
      image: "vercel/sandbox/universal:latest",
      resources: { vcpus: 2 },
      tags: { product: "viby" },
      name: (context) => `version-${context.versionId}`,
    },
    async (input) => {
      factoryInput = input;
      return client;
    },
    async (input) => {
      connectorInput = input;
      return client;
    },
  );

  const instance = await adapter.create(createInput);
  assert.equal(instance.id, "viby-test");
  assert.deepEqual(factoryInput, {
    token: "token",
    teamId: "team",
    projectId: "project",
    name: "version-version-a",
    image: "vercel/sandbox/universal:latest",
    resources: { vcpus: 2 },
    tags: { product: "viby" },
    ports: [3000, 4173],
    timeout: 120_000,
    env: { NODE_ENV: "test" },
    persistent: false,
  });
  const reconnected = await adapter.reconnect!({
    sandboxId: "viby-test",
    context: createInput.context,
    ports: createInput.ports,
    expiresAt: new Date(Date.now() + 30_000),
  });
  assert.equal(reconnected.id, "viby-test");
  assert.equal(adapter.capabilities.reconnect, true);
  assert.deepEqual(connectorInput, {
    name: "viby-test",
    resume: true,
    token: "token",
    teamId: "team",
    projectId: "project",
  });

  await instance.writeFiles([
    { path: "src/index.ts", content: "export {};\n" },
    { path: "asset.bin", content: new Uint8Array([1, 2]) },
  ]);
  assert.deepEqual(client.writes.map((file) => file.path), [
    "/vercel/sandbox/src/index.ts",
    "/vercel/sandbox/asset.bin",
  ]);

  const output: SandboxOutputEvent[] = [];
  const result = await instance.run({
    command: "pnpm",
    args: ["build"],
    cwd: ".",
    env: { CI: "true" },
    timeoutMs: 30_000,
    onOutput: (event) => {
      output.push(event);
    },
  });
  const command = client.commands[0]!;
  assert.deepEqual({
    cmd: command.cmd,
    args: command.args,
    cwd: command.cwd,
    env: command.env,
    timeoutMs: command.timeoutMs,
  }, {
    cmd: "pnpm",
    args: ["build"],
    cwd: "/vercel/sandbox",
    env: { CI: "true" },
    timeoutMs: 30_000,
  });
  assert.deepEqual(output, [
    { stream: "stdout", data: "out\n" },
    { stream: "stderr", data: "err\n" },
  ]);

  const background = await instance.start!({ command: "pnpm", args: ["dev"] });
  assert.equal(background.id, "cmd_background");
  assert.equal((await background.wait()).stdout, "server-ready\n");
  await background.kill();
  assert.equal(client.backgroundKilled, 1);
  assert.equal(client.commands[1]?.detached, true);
  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "out\n",
    stderr: "err\n",
    durationMs: 18,
  });

  assert.equal(Buffer.from(await instance.readFile("dist/app.js")).toString(), "built output");
  assert.deepEqual(client.reads, ["/vercel/sandbox/dist/app.js"]);
  assert.equal(await instance.getUrl?.(3000), "https://3000-viby.vercel.run");
  await instance.stop();
  assert.equal(client.stopped, true);
});

test("validates Vercel-specific limits and missing files", async () => {
  assert.throws(
    () => vercelSandbox({ image: "image", runtime: "node24" } as never),
    ConfigurationError,
  );
  assert.throws(
    () => vercelSandbox({ token: "token" } as never),
    /requires token, teamId, and projectId together/,
  );

  const client = new FakeVercelClient();
  const adapter = vercelSandbox({}, async () => client);
  await assert.rejects(
    () => adapter.create({ ...createInput, ports: [1, 2, 3, 4, 5] }),
    /at most 4 exposed ports/,
  );

  const instance = await adapter.create(createInput);
  client.missingFile = true;
  await assert.rejects(() => instance.readFile("missing.txt"), /was not found/);
});

async function writeStream(stream: Writable | undefined, content: string): Promise<void> {
  if (!stream) return;
  await new Promise<void>((resolve, reject) => {
    stream.write(content, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
