import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import type { SandboxOutputEvent } from "../src/sandbox.js";
import {
  cloudflareSandbox,
  type CloudflareSandboxClient,
  type CloudflareSandboxFactoryInput,
} from "../src/sandbox-cloudflare.js";

class FakeCloudflareSandbox implements CloudflareSandboxClient {
  readonly directories: string[] = [];
  readonly writes: { path: string; content: string | Uint8Array }[] = [];
  readonly reads: string[] = [];
  readonly executions: {
    command: string;
    options: Record<string, unknown>;
  }[] = [];
  exposed: { port: number; options: Record<string, unknown> } | undefined;
  tunneledPort: number | undefined;
  destroyed = 0;
  failDirectory = false;

  readonly tunnels = {
    get: async (port: number) => {
      this.tunneledPort = port;
      return { url: `https://${port}-quick.trycloudflare.com` };
    },
  };

  async exec(
    command: string,
    options: {
      cwd: string;
      env: Record<string, string>;
      timeout: number;
      stream: boolean;
      signal?: AbortSignal;
      onOutput?: (stream: "stdout" | "stderr", data: string) => void;
    },
  ) {
    this.executions.push({ command, options });
    options.onOutput?.("stdout", "out\n");
    options.onOutput?.("stderr", "err\n");
    return {
      exitCode: 2,
      stdout: "out\n",
      stderr: "err\n",
      duration: 17,
    };
  }

  async mkdir(path: string): Promise<{ success: boolean }> {
    this.directories.push(path);
    return { success: !this.failDirectory };
  }

  async writeFile(
    path: string,
    content: string | ReadableStream<Uint8Array>,
  ): Promise<{ success: boolean }> {
    this.writes.push({
      path,
      content: typeof content === "string" ? content : await collect(content),
    });
    return { success: true };
  }

  async readFile(path: string): Promise<{ success: boolean; content: string }> {
    this.reads.push(path);
    return { success: true, content: Buffer.from([0, 1, 255]).toString("base64") };
  }

  async exposePort(
    port: number,
    options: { hostname: string; name?: string; token?: string },
  ): Promise<{ url: string }> {
    this.exposed = { port, options };
    return { url: `https://${port}-stable.${options.hostname}` };
  }

  async destroy(): Promise<void> {
    this.destroyed += 1;
  }
}

const binding = { kind: "durable-object-namespace" };
const createInput = {
  context: {
    tenantId: "tenant-a",
    userId: "user-a",
    chatId: "chat-a",
    versionId: "Version-A",
    framework: "farm",
  },
  timeoutMs: 120_001,
  env: { NODE_ENV: "test" },
  ports: [5173],
} as const;

test("maps the common sandbox contract to a Cloudflare quick-tunnel sandbox", async () => {
  const client = new FakeCloudflareSandbox();
  let factoryInput: CloudflareSandboxFactoryInput<typeof binding> | undefined;
  const adapter = cloudflareSandbox({
    binding,
    id: (context) => `VIBY-${context.versionId}`,
    preview: "tunnel",
    transport: "rpc",
    labels: { product: "viby" },
    containerTimeouts: {
      instanceGetTimeoutMS: 30_000,
      portReadyTimeoutMS: 90_000,
      waitIntervalMS: 250,
    },
  }, async (input) => {
    factoryInput = input;
    return client;
  });

  assert.equal(adapter.provider, "cloudflare");
  const instance = await adapter.create(createInput);
  assert.equal(instance.id, "viby-version-a");
  assert.deepEqual(factoryInput, {
    binding,
    id: "viby-version-a",
    options: {
      sleepAfter: 121,
      keepAlive: false,
      enableDefaultSession: false,
      normalizeId: true,
      transport: "rpc",
      labels: { product: "viby" },
      containerTimeouts: {
        instanceGetTimeoutMS: 30_000,
        portReadyTimeoutMS: 90_000,
        waitIntervalMS: 250,
      },
    },
  });
  assert.deepEqual(client.directories, ["/workspace"]);

  await instance.writeFiles([
    { path: "src/index.js", content: "console.log('safe')\n" },
    { path: "asset.bin", content: new Uint8Array([1, 2, 255]) },
  ]);
  assert.deepEqual(client.writes, [
    { path: "/workspace/src/index.js", content: "console.log('safe')\n" },
    { path: "/workspace/asset.bin", content: new Uint8Array([1, 2, 255]) },
  ]);

  const output: SandboxOutputEvent[] = [];
  const result = await instance.run({
    command: "node",
    args: ["src/index.js", "$(not-executed)", "it's safe"],
    cwd: "src",
    env: { FEATURE: "enabled" },
    timeoutMs: 5_000,
    onOutput: async (event) => {
      output.push(event);
    },
  });
  const execution = client.executions[0]!;
  assert.equal(
    execution.command,
    `'node' 'src/index.js' '$(not-executed)' 'it'"'"'s safe'`,
  );
  assert.deepEqual({
    cwd: execution.options.cwd,
    env: execution.options.env,
    timeout: execution.options.timeout,
    stream: execution.options.stream,
  }, {
    cwd: "/workspace/src",
    env: { FEATURE: "enabled" },
    timeout: 5_000,
    stream: true,
  });
  assert.deepEqual(result, {
    exitCode: 2,
    stdout: "out\n",
    stderr: "err\n",
    durationMs: 17,
  });
  assert.deepEqual(output, [
    { stream: "stdout", data: "out\n" },
    { stream: "stderr", data: "err\n" },
  ]);

  assert.deepEqual([...await instance.readFile("dist/output.bin")], [0, 1, 255]);
  assert.deepEqual(client.reads, ["/workspace/dist/output.bin"]);
  assert.equal(await instance.getUrl?.(5173), "https://5173-quick.trycloudflare.com");
  assert.equal(client.tunneledPort, 5173);
  await assert.rejects(async () => instance.getUrl!(4173), /was not declared/);

  await instance.stop();
  assert.equal(client.destroyed, 1);
});

test("supports stable hostname previews", async () => {
  const client = new FakeCloudflareSandbox();
  const adapter = cloudflareSandbox({
    binding,
    id: "stable-preview",
    preview: {
      hostname: "preview.example.com",
      name: "dev-server",
      token: "viby_preview_1",
    },
    transport: "http",
    sleepAfter: "5m",
    keepAlive: true,
  }, async () => client);
  const instance = await adapter.create(createInput);
  assert.equal(await instance.getUrl?.(5173), "https://5173-stable.preview.example.com");
  assert.deepEqual(client.exposed, {
    port: 5173,
    options: {
      hostname: "preview.example.com",
      name: "dev-server",
      token: "viby_preview_1",
    },
  });
});

test("validates Cloudflare bindings, preview modes, and timeouts", async () => {
  assert.throws(
    () => cloudflareSandbox({ binding: null } as never),
    /requires a Durable Object binding/,
  );
  assert.throws(
    () => cloudflareSandbox({ binding, preview: "tunnel", transport: "http" }),
    /quick tunnels require the RPC transport/,
  );
  assert.throws(
    () => cloudflareSandbox({ binding, preview: { hostname: "https://example.com" } }),
    /must not include a URL scheme/,
  );
  assert.throws(
    () => cloudflareSandbox({ binding, preview: { hostname: "example.com", token: "UPPER" } }),
    /preview token/,
  );
  assert.throws(() => cloudflareSandbox({ binding, sleepAfter: "later" }), /sleepAfter/);
  assert.throws(
    () => cloudflareSandbox({ binding, containerTimeouts: { waitIntervalMS: 0 } }),
    /poll interval/,
  );

  const adapter = cloudflareSandbox({
    binding,
    preview: { hostname: "example.com" },
  }, async () => new FakeCloudflareSandbox());
  await assert.rejects(
    () => adapter.create({ ...createInput, ports: [80] }),
    /ports between 1024 and 65535/,
  );
  await assert.rejects(
    () => adapter.create({ ...createInput, ports: [3_000] }),
    /reserves port 3000/,
  );
});

test("destroys Cloudflare sandbox when initialization fails", async () => {
  const client = new FakeCloudflareSandbox();
  client.failDirectory = true;
  const adapter = cloudflareSandbox({ binding }, async () => client);
  await assert.rejects(() => adapter.create(createInput), /project workspace/);
  assert.equal(client.destroyed, 1);
});

async function collect(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    chunks.push(result.value);
    size += result.value.byteLength;
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}
