import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SandboxConformanceError,
  verifySandboxAdapter,
} from "../src/sandbox-conformance.js";
import {
  sandboxCapabilities,
  type SandboxAdapter,
  type SandboxCommand,
  type SandboxFile,
  type SandboxInstance,
} from "../src/sandbox.js";

class ConformingInstance implements SandboxInstance {
  readonly id = "conformance-fixture";
  readonly files = new Map<string, Uint8Array>();
  stopCalls = 0;

  async writeFiles(files: readonly SandboxFile[]): Promise<void> {
    for (const file of files) {
      this.files.set(
        file.path,
        typeof file.content === "string"
          ? new TextEncoder().encode(file.content)
          : new Uint8Array(file.content),
      );
    }
  }

  async readFile(path: string): Promise<Uint8Array> {
    const content = this.files.get(path);
    if (!content) throw new Error(`Missing fixture file: ${path}`);
    return new Uint8Array(content);
  }

  async run(command: SandboxCommand) {
    await command.onOutput?.({ stream: "stdout", data: "conformance-ready\n" });
    return {
      exitCode: 0,
      stdout: "conformance-ready\n",
      stderr: "",
      durationMs: 1,
    };
  }

  getUrl(port: number): string {
    return `https://sandbox.example/${port}`;
  }

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

function fixtureAdapter(instance = new ConformingInstance()): SandboxAdapter {
  return {
    provider: "fixture",
    capabilities: sandboxCapabilities({
      files: true,
      commands: true,
      commandStreaming: true,
      portUrls: true,
    }),
    async create() {
      return instance;
    },
  };
}

const createInput = {
  context: {
    tenantId: "tenant",
    userId: "user",
    chatId: "chat",
    versionId: "version",
    framework: "custom-framework",
  },
  timeoutMs: 60_000,
  env: {},
  ports: [4173],
} as const;

test("runs the shared adapter conformance contract without provider assumptions", async () => {
  const instance = new ConformingInstance();
  const report = await verifySandboxAdapter({
    adapter: fixtureAdapter(instance),
    create: createInput,
    command: { command: "runtime-specific-probe" },
    port: 4173,
    validateCommand(result, events) {
      assert.equal(result.exitCode, 0);
      assert.deepEqual(events, [{ stream: "stdout", data: "conformance-ready\n" }]);
    },
  });

  assert.equal(report.provider, "fixture");
  assert.equal(report.sandboxId, "conformance-fixture");
  assert.deepEqual(report.checks, [
    "capabilities",
    "create",
    "text-file-roundtrip",
    "binary-file-roundtrip",
    "command",
    "command-streaming",
    "port-url",
    "idempotent-stop",
  ]);
  assert.equal(instance.stopCalls, 1);
});

test("reports byte corruption and still cleans up the sandbox", async () => {
  const instance = new ConformingInstance();
  instance.readFile = async () => new Uint8Array([99]);

  await assert.rejects(
    () => verifySandboxAdapter({
      adapter: fixtureAdapter(instance),
      create: createInput,
      command: { command: "runtime-specific-probe" },
      port: 4173,
    }),
    SandboxConformanceError,
  );
  assert.equal(instance.stopCalls, 1);
});

test("requires caller-owned probes for optional capabilities", async () => {
  await assert.rejects(
    () => verifySandboxAdapter({
      adapter: fixtureAdapter(),
      create: createInput,
      command: { command: "runtime-specific-probe" },
    }),
    /requires a declared port/,
  );
});
