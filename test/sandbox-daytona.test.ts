import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import { ConfigurationError } from "../src/errors.js";
import type { SandboxOutputEvent } from "../src/sandbox.js";
import {
  daytonaSandbox,
  type DaytonaSandboxClient,
  type DaytonaSandboxFactoryInput,
} from "../src/sandbox-daytona.js";

class FakeDaytonaSandbox implements DaytonaSandboxClient {
  readonly id = "daytona-test";
  readonly commands: {
    command: string;
    cwd?: string;
    env?: Record<string, string>;
    timeout?: number;
  }[] = [];
  readonly uploads: { source: Uint8Array; path: string; signal?: AbortSignal }[] = [];
  readonly sessionRequests: {
    sessionId: string;
    request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean };
    timeout?: number;
  }[] = [];
  readonly deletedSessions: string[] = [];
  previewRequest: { port: number; expires?: number } | undefined;
  deleted = 0;

  readonly fs = {
    uploadFileStream: async (
      source: Uint8Array,
      remotePath: string,
      options?: { signal?: AbortSignal; timeout?: number },
    ) => {
      this.uploads.push({
        source,
        path: remotePath,
        ...(options?.signal ? { signal: options.signal } : {}),
      });
    },
    downloadFileStream: async () => Readable.from([
      Buffer.from([0, 1]),
      Buffer.from([2, 255]),
    ]),
  };

  readonly process = {
    executeCommand: async (
      command: string,
      cwd?: string,
      env?: Record<string, string>,
      timeout?: number,
    ) => {
      this.commands.push({
        command,
        ...(cwd ? { cwd } : {}),
        ...(env ? { env } : {}),
        ...(timeout !== undefined ? { timeout } : {}),
      });
      return { exitCode: 0, result: "" };
    },
    createSession: async () => {},
    executeSessionCommand: async (
      sessionId: string,
      request: { command: string; runAsync?: boolean; suppressInputEcho?: boolean },
      timeout?: number,
    ) => {
      this.sessionRequests.push({
        sessionId,
        request,
        ...(timeout !== undefined ? { timeout } : {}),
      });
      return request.runAsync
        ? { cmdId: "async-command" }
        : {
            cmdId: "sync-command",
            exitCode: 3,
            stdout: "sync out\n",
            stderr: "sync err\n",
          };
    },
    getSessionCommandLogs: async (
      _sessionId: string,
      _commandId: string,
      onStdout: (chunk: string) => void,
      onStderr: (chunk: string) => void,
    ) => {
      onStdout("stream out\n");
      onStderr("stream err\n");
    },
    getSessionCommand: async () => ({ exitCode: 7 }),
    deleteSession: async (sessionId: string) => {
      this.deletedSessions.push(sessionId);
    },
  };

  async getUserHomeDir(): Promise<string> {
    return "/home/daytona";
  }

  async getSignedPreviewUrl(port: number, expires?: number) {
    this.previewRequest = { port, ...(expires !== undefined ? { expires } : {}) };
    return { url: `https://${port}-signed.proxy.daytona.test`, token: "secret" };
  }

  async delete(): Promise<void> {
    this.deleted += 1;
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
  timeoutMs: 65_000,
  env: { NODE_ENV: "test" },
  ports: [3000],
} as const;

test("maps Daytona creation, files, commands, streams, previews, and cleanup", async () => {
  const client = new FakeDaytonaSandbox();
  let factoryInput: DaytonaSandboxFactoryInput | undefined;
  const adapter = daytonaSandbox({
    apiKey: "daytona-key",
    apiUrl: "https://daytona.example/api",
    target: "us",
    requestTimeoutMs: 20_000,
    image: "node:24",
    resources: { cpu: 2, memory: 4, disk: 20 },
    language: "typescript",
    user: "daytona",
    labels: { product: "viby" },
    secrets: { NPM_TOKEN: "npm-token" },
    public: false,
    networkBlockAll: false,
    domainAllowList: "registry.npmjs.org",
    name: (context) => `viby-${context.versionId}`,
    createTimeoutSeconds: 90,
    previewExpiresInSeconds: 7_200,
  }, async (input) => {
    factoryInput = input;
    return client;
  });

  assert.equal(adapter.provider, "daytona");
  const instance = await adapter.create(createInput);
  assert.equal(instance.id, "daytona-test");
  assert.deepEqual(factoryInput?.config, {
    apiKey: "daytona-key",
    apiUrl: "https://daytona.example/api",
    target: "us",
    requestTimeoutMs: 20_000,
  });
  assert.deepEqual(factoryInput?.params, {
    ephemeral: true,
    autoStopInterval: 0,
    ttlMinutes: 2,
    envVars: { NODE_ENV: "test" },
    name: "viby-version-a",
    language: "typescript",
    user: "daytona",
    labels: { product: "viby" },
    secrets: { NPM_TOKEN: "npm-token" },
    public: false,
    networkBlockAll: false,
    domainAllowList: "registry.npmjs.org",
    image: "node:24",
    resources: { cpu: 2, memory: 4, disk: 20 },
  });
  assert.deepEqual(factoryInput?.createOptions, { timeout: 90 });
  assert.match(client.commands[0]!.command, /mkdir -p -- '\/home\/daytona\/viby'/);

  const source = Buffer.from("console.log('safe')\n");
  await instance.writeFiles([{ path: "src/index.js", content: source }]);
  assert.match(client.commands[1]!.command, /'\/home\/daytona\/viby\/src'/);
  assert.deepEqual(client.uploads[0]!.source, source);
  assert.equal(client.uploads[0]!.path, "/home/daytona/viby/src/index.js");

  const sync = await instance.run({
    command: "node",
    args: ["src/index.js", "$(not-executed)", "it's safe"],
    cwd: "src",
    env: { FEATURE: "enabled" },
    timeoutMs: 5_001,
  });
  assert.deepEqual(sync, {
    exitCode: 3,
    stdout: "sync out\n",
    stderr: "sync err\n",
    durationMs: sync.durationMs,
  });
  const request = client.sessionRequests[0]!;
  assert.equal(request.timeout, 6);
  assert.equal(request.request.runAsync, false);
  assert.match(request.request.command, /^cd -- '\/home\/daytona\/viby\/src' && /);
  assert.match(request.request.command, /export 'FEATURE=enabled'/);
  assert.match(request.request.command, /'\$\(not-executed\)'/);
  assert.match(request.request.command, /'it'"'"'s safe'/);

  const output: SandboxOutputEvent[] = [];
  const streamed = await instance.run({
    command: "npm",
    args: ["run", "build"],
    onOutput: async (event) => {
      output.push(event);
    },
  });
  assert.equal(streamed.exitCode, 7);
  assert.equal(streamed.stdout, "stream out\n");
  assert.equal(streamed.stderr, "stream err\n");
  assert.deepEqual(output, [
    { stream: "stdout", data: "stream out\n" },
    { stream: "stderr", data: "stream err\n" },
  ]);
  assert.equal(client.sessionRequests[1]!.request.runAsync, true);
  assert.equal(client.deletedSessions.length, 2);

  assert.deepEqual(
    [...await instance.readFile("dist/output.bin")],
    [0, 1, 2, 255],
  );
  assert.equal(await instance.getUrl?.(3000), "https://3000-signed.proxy.daytona.test");
  assert.deepEqual(client.previewRequest, { port: 3000, expires: 7_200 });
  await instance.stop();
  assert.equal(client.deleted, 1);
});

test("supports snapshot creation and validates incompatible Daytona options", async () => {
  const client = new FakeDaytonaSandbox();
  let params: DaytonaSandboxFactoryInput["params"] | undefined;
  const adapter = daytonaSandbox({ snapshot: "viby-base" }, async (input) => {
    params = input.params;
    return client;
  });
  await adapter.create(createInput);
  assert.equal("snapshot" in params! && params.snapshot, "viby-base");

  assert.throws(
    () => daytonaSandbox({ image: "node:24", snapshot: "base" } as never),
    ConfigurationError,
  );
  assert.throws(
    () => daytonaSandbox({ resources: { cpu: 2 } } as never),
    /resources require an image/,
  );
  assert.throws(() => daytonaSandbox({ previewExpiresInSeconds: 0 }), /preview expiry/);
  assert.throws(() => daytonaSandbox({ createTimeoutSeconds: 3_601 }), /creation timeout/);
  assert.throws(() => daytonaSandbox({ requestTimeoutMs: 0 }), /request timeout/);
});

test("deletes a Daytona sandbox when initialization fails", async () => {
  const client = new FakeDaytonaSandbox();
  client.getUserHomeDir = async () => undefined as never;
  const adapter = daytonaSandbox({}, async () => client);
  await assert.rejects(() => adapter.create(createInput), /home directory/);
  assert.equal(client.deleted, 1);
});
