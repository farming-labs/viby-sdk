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
    "dist/mcp.js",
    "dist/mcp.d.ts",
    "dist/sandbox-e2b.js",
    "dist/sandbox-e2b.d.ts",
    "dist/sandbox-vercel.js",
    "dist/sandbox-vercel.d.ts",
    "dist/sandbox-docker.js",
    "dist/sandbox-docker.d.ts",
    "dist/sandbox-daytona.js",
    "dist/sandbox-daytona.d.ts",
    "dist/sandbox-modal.js",
    "dist/sandbox-modal.d.ts",
    "dist/sandbox-cloudflare.js",
    "dist/sandbox-cloudflare.d.ts",
    "dist/sandbox-conformance.js",
    "dist/sandbox-conformance.d.ts",
    "dist/generation-engine-conformance.js",
    "dist/generation-engine-conformance.d.ts",
    "dist/artifact-filesystem.js",
    "dist/artifact-filesystem.d.ts",
    "dist/artifact-store-conformance.js",
    "dist/artifact-store-conformance.d.ts",
    "dist/persistence-postgres.js",
    "dist/persistence-postgres.d.ts",
    "dist/persistence-conformance.js",
    "dist/persistence-conformance.d.ts",
    "dist/persistence.js",
    "dist/persistence.d.ts",
    "dist/browser.js",
    "dist/browser.d.ts",
    "dist/browser-conformance.js",
    "dist/browser-conformance.d.ts",
    "dist/browser-preview.js",
    "dist/browser-preview.d.ts",
    "dist/browser-playwright.js",
    "dist/browser-playwright.d.ts",
    "dist/visual-evaluation.js",
    "dist/visual-evaluation.d.ts",
    "dist/integration-store-postgres.js",
    "dist/integration-store-postgres.d.ts",
    "dist/integration-store-conformance.js",
    "dist/integration-store-conformance.d.ts",
    "dist/repository-integration-conformance.js",
    "dist/repository-integration-conformance.d.ts",
    "dist/deployment-integration-conformance.js",
    "dist/deployment-integration-conformance.d.ts",
    "dist/integration-github.js",
    "dist/integration-github.d.ts",
    "dist/integration-bitbucket.js",
    "dist/integration-bitbucket.d.ts",
    "dist/integration-vercel.js",
    "dist/integration-vercel.d.ts",
    "dist/integration-cloudflare.js",
    "dist/integration-cloudflare.d.ts",
    "migrations/0001_initial.sql",
    "migrations/0002_durable_generations.sql",
    "migrations/0013_generation_costs.sql",
    "migrations/0014_outbound_event_deliveries.sql",
    "migrations/0018_artifact_storage.sql",
    "migrations/0019_generated_artifacts.sql",
    "migrations/0020_visual_artifacts.sql",
    "migrations/0021_project_artifacts.sql",
    "migrations/0022_integration_connections.sql",
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
        'import { accessibilityGate, configuredIntegrations, consoleErrorGate, createViby, BrowserSession, DeploymentIntegrationHandle, DownloadArtifact, IntegrationAuthorizationError, IntegrationClient, IntegrationOperationError, RepositoryIntegrationHandle, SandboxSession, SourceImportError, generationEventStreamResponse, openBrowserSession, openTelemetry, signedOutboundEventSink, verifySignedOutboundEvent, skillRead } from "@viby/sdk";',
        'if (typeof createViby !== "function") throw new Error("createViby export is missing");',
        'if (typeof BrowserSession !== "function") throw new Error("BrowserSession export is missing");',
        'if (typeof openBrowserSession !== "function") throw new Error("openBrowserSession export is missing");',
        'if (typeof DownloadArtifact !== "function") throw new Error("DownloadArtifact export is missing");',
        'if (typeof SandboxSession !== "function") throw new Error("SandboxSession export is missing");',
        'if (typeof SourceImportError !== "function") throw new Error("SourceImportError export is missing");',
        'if (typeof signedOutboundEventSink !== "function") throw new Error("signedOutboundEventSink export is missing");',
        'if (typeof verifySignedOutboundEvent !== "function") throw new Error("verifySignedOutboundEvent export is missing");',
        'if (typeof generationEventStreamResponse !== "function") throw new Error("generationEventStreamResponse export is missing");',
        'if (typeof openTelemetry !== "function") throw new Error("openTelemetry export is missing");',
        'if (typeof consoleErrorGate !== "function") throw new Error("consoleErrorGate export is missing");',
        'if (typeof accessibilityGate !== "function") throw new Error("accessibilityGate export is missing");',
        'if (typeof configuredIntegrations !== "function") throw new Error("configuredIntegrations export is missing");',
        'if (typeof IntegrationClient !== "function") throw new Error("IntegrationClient export is missing");',
        'if (typeof IntegrationAuthorizationError !== "function") throw new Error("IntegrationAuthorizationError export is missing");',
        'if (typeof IntegrationOperationError !== "function") throw new Error("IntegrationOperationError export is missing");',
        'if (typeof RepositoryIntegrationHandle !== "function") throw new Error("RepositoryIntegrationHandle export is missing");',
        'if (typeof DeploymentIntegrationHandle !== "function") throw new Error("DeploymentIntegrationHandle export is missing");',
        'if (skillRead("./skills").source !== "file") throw new Error("skillRead export is invalid");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { bitbucket, bitbucketRepository, BitbucketRepositoryError } from "@viby/sdk/integrations/bitbucket";',
        'if (typeof bitbucket !== "function") throw new Error("Bitbucket repository adapter export is missing");',
        'if (bitbucketRepository !== bitbucket) throw new Error("Bitbucket repository alias is invalid");',
        'if (typeof BitbucketRepositoryError !== "function") throw new Error("Bitbucket repository error export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { cloudflare, cloudflareAccounts, cloudflareDeployment, CloudflareDeploymentError } from "@viby/sdk/integrations/cloudflare";',
        'if (typeof cloudflare !== "function") throw new Error("Cloudflare deployment adapter export is missing");',
        'if (typeof cloudflareAccounts !== "function") throw new Error("Cloudflare account helper export is missing");',
        'if (cloudflareDeployment !== cloudflare) throw new Error("Cloudflare deployment alias is invalid");',
        'if (typeof CloudflareDeploymentError !== "function") throw new Error("Cloudflare deployment error export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { vercel, vercelDeployment, VercelDeploymentError } from "@viby/sdk/integrations/vercel";',
        'if (typeof vercel !== "function") throw new Error("Vercel deployment adapter export is missing");',
        'if (vercelDeployment !== vercel) throw new Error("Vercel deployment alias is invalid");',
        'if (typeof VercelDeploymentError !== "function") throw new Error("Vercel deployment error export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { github, githubRepository, GitHubRepositoryError } from "@viby/sdk/integrations/github";',
        'if (typeof github !== "function") throw new Error("GitHub repository adapter export is missing");',
        'if (githubRepository !== github) throw new Error("GitHub repository alias is invalid");',
        'if (typeof GitHubRepositoryError !== "function") throw new Error("GitHub repository error export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { verifyDeploymentIntegration } from "@viby/sdk/integrations/deployment/conformance";',
        'if (typeof verifyDeploymentIntegration !== "function") throw new Error("deployment integration conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { verifyRepositoryIntegration } from "@viby/sdk/integrations/repository/conformance";',
        'if (typeof verifyRepositoryIntegration !== "function") throw new Error("repository integration conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { verifyIntegrationStores } from "@viby/sdk/integrations/conformance";',
        'if (typeof verifyIntegrationStores !== "function") throw new Error("integration store conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { EncryptedPostgresSecretStore, PostgresIntegrationConnectionStore } from "@viby/sdk/integrations/postgres";',
        'if (typeof PostgresIntegrationConnectionStore !== "function") throw new Error("Postgres connection store export is missing");',
        'if (typeof EncryptedPostgresSecretStore !== "function") throw new Error("Postgres secret store export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { postgresPersistence } from "@viby/sdk/persistence/postgres";',
        'import { verifyPersistenceAdapter } from "@viby/sdk/persistence/conformance";',
        'if (typeof postgresPersistence !== "function") throw new Error("Postgres persistence export is missing");',
        'if (typeof verifyPersistenceAdapter !== "function") throw new Error("persistence conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { verifyBrowserAdapter } from "@viby/sdk/browser/conformance";',
        'if (typeof verifyBrowserAdapter !== "function") throw new Error("browser conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { fileSystemArtifactStore } from "@viby/sdk/artifact/filesystem";',
        'import { verifyArtifactStore } from "@viby/sdk/artifact/conformance";',
        'if (typeof fileSystemArtifactStore !== "function") throw new Error("filesystem artifact store export is missing");',
        'if (typeof verifyArtifactStore !== "function") throw new Error("artifact conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { verifyGenerationEngine } from "@viby/sdk/generation/conformance";',
        'if (typeof verifyGenerationEngine !== "function") throw new Error("generation conformance export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    npm,
    [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--package-lock=false",
      "@modelcontextprotocol/server@2.0.0",
    ],
    { cwd: consumer, maxBuffer: 10 * 1024 * 1024 },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { registerVibyMcpTools } from "@viby/sdk/mcp";',
        'if (typeof registerVibyMcpTools !== "function") throw new Error("MCP tools export is missing");',
      ].join("\n"),
    ],
    { cwd: consumer },
  );
  await execute(
    node,
    [
      "--input-type=module",
      "--eval",
      [
        'import { verifySandboxAdapter } from "@viby/sdk/sandbox/conformance";',
        'if (typeof verifySandboxAdapter !== "function") throw new Error("sandbox conformance export is missing");',
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
