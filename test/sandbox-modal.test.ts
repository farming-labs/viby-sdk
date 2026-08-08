import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import type { SandboxOutputEvent } from "../src/sandbox.js";
import {
  modalSandbox,
  type ModalProcessClient,
  type ModalSandboxClient,
  type ModalSandboxFactoryInput,
} from "../src/sandbox-modal.js";

class FakeModalSandbox implements ModalSandboxClient {
  readonly id = "sb-modal-test";
  readonly directories: string[] = [];
  readonly writes: { path: string; content: Uint8Array }[] = [];
  readonly reads: string[] = [];
  readonly executions: {
    command: readonly string[];
    options: { workdir: string; timeoutMs: number; env: Record<string, string> };
  }[] = [];
  tunnelTimeout: number | undefined;
  terminated = 0;
  closed = 0;
  failDirectory = false;

  readonly filesystem = {
    makeDirectory: async (path: string) => {
      if (this.failDirectory) throw new Error("workspace failed");
      this.directories.push(path);
    },
    writeBytes: async (content: Uint8Array, path: string) => {
      this.writes.push({ path, content });
    },
    readBytes: async (path: string) => {
      this.reads.push(path);
      return new Uint8Array([0, 1, 255]);
    },
  };

  async exec(
    command: readonly string[],
    options: { workdir: string; timeoutMs: number; env: Record<string, string> },
  ): Promise<ModalProcessClient> {
    this.executions.push({ command, options });
    return {
      stdout: chunks("out 1\n", "out 2\n"),
      stderr: chunks("err\n"),
      async wait() { return 4; },
    };
  }

  async tunnels(timeoutMs?: number) {
    this.tunnelTimeout = timeoutMs;
    return { 3000: { url: "https://modal-preview.example" } };
  }

  async terminate(): Promise<void> {
    this.terminated += 1;
  }

  close(): void {
    this.closed += 1;
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
  ports: [3000],
} as const;

test("maps the common sandbox contract to Modal", async () => {
  const client = new FakeModalSandbox();
  let factoryInput: ModalSandboxFactoryInput | undefined;
  const adapter = modalSandbox({
    tokenId: "modal-token-id",
    tokenSecret: "modal-token-secret",
    environment: "main",
    endpoint: "https://modal.example",
    requestTimeoutMs: 20_000,
    maxRetries: 5,
    appName: "viby-sandboxes",
    image: "node:24",
    imageSource: "registry",
    secretNames: ["npm-token"],
    cpu: 2,
    cpuLimit: 4,
    memoryMiB: 2_048,
    memoryLimitMiB: 4_096,
    gpu: "T4",
    idleTimeoutMs: 60_000,
    outboundDomainAllowlist: ["registry.npmjs.org"],
    regions: ["us-east-1"],
    cloud: "aws",
    includeOidcIdentityToken: true,
    tags: { product: "viby" },
    name: (context) => `version-${context.versionId}`,
    tunnelTimeoutMs: 10_000,
  }, async (input) => {
    factoryInput = input;
    return client;
  });

  assert.equal(adapter.provider, "modal");
  const instance = await adapter.create(createInput);
  assert.equal(instance.id, "sb-modal-test");
  assert.deepEqual(factoryInput, {
    client: {
      tokenId: "modal-token-id",
      tokenSecret: "modal-token-secret",
      environment: "main",
      endpoint: "https://modal.example",
      timeoutMs: 20_000,
      maxRetries: 5,
    },
    appName: "viby-sandboxes",
    image: "node:24",
    imageSource: "registry",
    secretNames: ["npm-token"],
    create: {
      timeoutMs: 120_000,
      workdir: "/workspace",
      env: { NODE_ENV: "test" },
      encryptedPorts: [3000],
      name: "version-version-a",
      cpu: 2,
      cpuLimit: 4,
      memoryMiB: 2_048,
      memoryLimitMiB: 4_096,
      gpu: "T4",
      idleTimeoutMs: 60_000,
      outboundDomainAllowlist: ["registry.npmjs.org"],
      cloud: "aws",
      regions: ["us-east-1"],
      includeOidcIdentityToken: true,
      tags: { product: "viby" },
    },
  });
  assert.deepEqual(client.directories, ["/workspace"]);

  const source = Buffer.from("console.log('safe')\n");
  await instance.writeFiles([{ path: "src/index.js", content: source }]);
  assert.equal(client.writes[0]!.path, "/workspace/src/index.js");
  assert.deepEqual(client.writes[0]!.content, source);

  const output: SandboxOutputEvent[] = [];
  const result = await instance.run({
    command: "node",
    args: ["src/index.js", "$(not-executed)", "a b"],
    cwd: "src",
    env: { FEATURE: "enabled" },
    timeoutMs: 5_000,
    onOutput: async (event) => {
      output.push(event);
    },
  });
  assert.deepEqual(client.executions[0], {
    command: ["node", "src/index.js", "$(not-executed)", "a b"],
    options: {
      workdir: "/workspace/src",
      timeoutMs: 5_000,
      env: { FEATURE: "enabled" },
    },
  });
  assert.equal(result.exitCode, 4);
  assert.equal(result.stdout, "out 1\nout 2\n");
  assert.equal(result.stderr, "err\n");
  assert.ok(result.durationMs >= 0);
  assert.deepEqual(output, [
    { stream: "stdout", data: "out 1\n" },
    { stream: "stderr", data: "err\n" },
    { stream: "stdout", data: "out 2\n" },
  ]);

  assert.deepEqual([...await instance.readFile("dist/output.bin")], [0, 1, 255]);
  assert.deepEqual(client.reads, ["/workspace/dist/output.bin"]);
  assert.equal(await instance.getUrl?.(3000), "https://modal-preview.example");
  assert.equal(client.tunnelTimeout, 10_000);
  await assert.rejects(async () => instance.getUrl!(4173), /was not declared/);

  await instance.stop();
  assert.equal(client.terminated, 1);
  assert.equal(client.closed, 1);
});

test("validates Modal credentials, networking, and resource options", () => {
  assert.throws(
    () => modalSandbox({ tokenId: "id" } as never),
    /requires tokenId and tokenSecret together/,
  );
  assert.throws(
    () => modalSandbox({ blockNetwork: true, outboundDomainAllowlist: ["example.com"] }),
    /cannot be combined/,
  );
  assert.throws(() => modalSandbox({ cpu: 0 }), /Modal CPU/);
  assert.throws(() => modalSandbox({ memoryMiB: 1.5 }), /Modal memory/);
  assert.throws(() => modalSandbox({ maxRetries: 21 }), /maximum retries/);
  assert.throws(() => modalSandbox({ secretNames: [""] }), /secret name/);
});

test("terminates and closes Modal when workspace initialization fails", async () => {
  const client = new FakeModalSandbox();
  client.failDirectory = true;
  const adapter = modalSandbox({}, async () => client);
  await assert.rejects(() => adapter.create(createInput), /workspace failed/);
  assert.equal(client.terminated, 1);
  assert.equal(client.closed, 1);
});

function chunks(...values: string[]): ReadableStream<string> {
  return new ReadableStream<string>({
    start(controller) {
      for (const value of values) controller.enqueue(value);
      controller.close();
    },
  });
}
