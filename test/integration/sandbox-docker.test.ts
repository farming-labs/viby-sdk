import assert from "node:assert/strict";
import { test } from "node:test";
import { dockerSandbox } from "../../src/sandbox-docker.js";

test("materializes, executes, reads, and removes a real Docker sandbox", async () => {
  const adapter = dockerSandbox({
    image: "node:24-bookworm-slim",
    network: "none",
    cpus: 1,
    memoryMb: 512,
    workspaceSizeMb: 256,
  });
  const instance = await adapter.create({
    context: {
      tenantId: "integration",
      userId: "integration",
      chatId: "chat",
      versionId: "version",
      framework: "farm",
    },
    timeoutMs: 120_000,
    env: {},
    ports: [],
  });

  try {
    await instance.writeFiles([{
      path: "run.mjs",
      content: [
        'import { mkdir, writeFile } from "node:fs/promises";',
        'await mkdir("dist", { recursive: true });',
        'await writeFile("dist/result.txt", "docker-ok\\n");',
        'console.log("sandbox-ready");',
      ].join("\n"),
    }]);
    const output = await instance.run({
      command: "node",
      args: ["run.mjs"],
      cwd: ".",
      env: {},
      timeoutMs: 30_000,
    });
    assert.equal(output.exitCode, 0, output.stderr);
    assert.equal(output.stdout, "sandbox-ready\n");
    assert.equal(
      Buffer.from(await instance.readFile("dist/result.txt")).toString(),
      "docker-ok\n",
    );
  } finally {
    await instance.stop();
  }
});
