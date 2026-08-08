import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const node = process.execPath;
const scratch = await mkdtemp(join(tmpdir(), "viby-package-"));

try {
  const { stdout } = await execute(
    npm,
    ["pack", "--json", "--ignore-scripts", "--pack-destination", scratch],
    { cwd: root, maxBuffer: 10 * 1024 * 1024 },
  );
  const [manifest] = JSON.parse(stdout);
  assert.ok(manifest, "npm pack did not return a package manifest");

  const paths = new Set(manifest.files.map((file) => file.path));
  for (const path of [
    "README.md",
    "LICENSE",
    "package.json",
    "dist/index.js",
    "dist/index.d.ts",
    "dist/cli.js",
    "dist/sandbox-e2b.js",
    "dist/sandbox-e2b.d.ts",
    "dist/sandbox-vercel.js",
    "dist/sandbox-vercel.d.ts",
    "dist/sandbox-docker.js",
    "dist/sandbox-docker.d.ts",
    "migrations/0001_initial.sql",
    "migrations/0002_durable_generations.sql",
  ]) {
    assert.ok(paths.has(path), `packed package is missing ${path}`);
  }
  assert.ok(
    manifest.files.every((file) => !file.path.startsWith("src/") && !file.path.startsWith("test/")),
    "packed package contains development source or tests",
  );

  const consumer = join(scratch, "consumer");
  await mkdir(consumer);
  await writeFile(
    join(consumer, "package.json"),
    JSON.stringify({ name: "viby-package-smoke", private: true, type: "module" }),
  );

  const tarball = join(scratch, manifest.filename);
  await execute(
    npm,
    ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--package-lock=false", tarball],
    { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { createViby, DownloadArtifact, SandboxSession, skillRead } from "@viby/sdk";',
        'if (typeof createViby !== "function") throw new Error("createViby export is missing");',
        'if (typeof DownloadArtifact !== "function") throw new Error("DownloadArtifact export is missing");',
        'if (typeof SandboxSession !== "function") throw new Error("SandboxSession export is missing");',
        'if (skillRead("./skills").source !== "file") throw new Error("skillRead export is invalid");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  const executable = join(consumer, "node_modules", ".bin", process.platform === "win32" ? "viby.cmd" : "viby");
  const { stdout: cliOutput } = await execute(executable, ["--help"], { cwd: consumer });
  assert.match(cliOutput, /viby db migrate/);

  console.log(`Verified ${manifest.name}@${manifest.version}: ${manifest.entryCount} files, import, and CLI.`);
} finally {
  await rm(scratch, { recursive: true, force: true });
}
