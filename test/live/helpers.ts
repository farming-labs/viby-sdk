import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type {
  DeploymentData,
  IntegrationCredential,
  IntegrationSourceFile,
} from "../../src/integrations.js";

export type LiveProvider = "github" | "gitlab" | "vercel" | "cloudflare" | "netlify" | "bitbucket";

export type LiveCleanupResource =
  | {
      readonly provider: "github";
      readonly kind: "repository";
      readonly owner: string;
      readonly name: string;
    }
  | {
      readonly provider: "bitbucket";
      readonly kind: "repository";
      readonly workspace: string;
      readonly name: string;
    }
  | {
      readonly provider: "gitlab";
      readonly kind: "repository";
      readonly owner: string;
      readonly name: string;
    }
  | {
      readonly provider: "cloudflare";
      readonly kind: "pages-project";
      readonly accountId: string;
      readonly name: string;
    }
  | {
      readonly provider: "vercel";
      readonly kind: "deployment";
      readonly projectId: string;
      readonly idempotencyKey: string;
    }
  | {
      readonly provider: "netlify";
      readonly kind: "site";
      readonly id: string;
      readonly name: string;
    };

const providers = new Set<LiveProvider>([
  "github",
  "gitlab",
  "vercel",
  "cloudflare",
  "netlify",
  "bitbucket",
]);
const liveEnabled = process.env.VIBY_LIVE_PROVIDER_TESTS === "1";
const selectedProviders = selectedLiveProviders();

export function liveProviderTest(
  provider: LiveProvider,
  name: string,
  run: () => Promise<void>,
): void {
  const skip = !liveEnabled
    ? "set VIBY_LIVE_PROVIDER_TESTS=1 to allow disposable provider resources"
    : !selectedProviders.has(provider)
      ? `${provider} is not selected by VIBY_LIVE_PROVIDERS`
      : false;
  test(`[live:${provider}] ${name}`, { skip, timeout: 12 * 60_000 }, run);
}

export function requiredEnvironment(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for the selected live provider test.`);
  return value.replaceAll("\\n", "\n");
}

export function optionalEnvironment(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value.replaceAll("\\n", "\n") : null;
}

export function encodedCredential(value: Readonly<Record<string, unknown>>): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value));
}

export function decodedCredential(
  credential: IntegrationCredential | Uint8Array,
): Record<string, unknown> {
  const bytes = credential instanceof Uint8Array ? credential : credential.secret;
  return JSON.parse(new TextDecoder().decode(bytes)) as Record<string, unknown>;
}

export function sourceFile(path: string, content: string): IntegrationSourceFile {
  return {
    path,
    content: new TextEncoder().encode(content),
    mediaType: path.endsWith(".html") ? "text/html" : "text/plain",
  };
}

export function disposableName(provider: LiveProvider): string {
  const suffix = `${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`;
  return `viby-live-${provider}-${suffix}`.slice(0, 52).replace(/-+$/, "");
}

export async function withCleanup<Result>(
  run: (cleanup: (action: () => Promise<void>) => void) => Promise<Result>,
): Promise<Result> {
  const actions: Array<() => Promise<void>> = [];
  let result: Result | undefined;
  let runError: unknown;
  try {
    result = await run((action) => actions.push(action));
  } catch (error) {
    runError = error;
  }

  const cleanupErrors: unknown[] = [];
  for (const action of actions.reverse()) {
    try {
      await action();
    } catch (error) {
      cleanupErrors.push(error);
    }
  }

  if (runError !== undefined || cleanupErrors.length > 0) {
    const errors = [runError, ...cleanupErrors].filter((error) => error !== undefined);
    if (errors.length === 1) throw errors[0];
    throw new AggregateError(errors, "Live provider verification and cleanup both failed.");
  }
  return result as Result;
}

export function trackedCleanup(
  resource: LiveCleanupResource,
  action: () => Promise<void>,
): () => Promise<void> {
  addTrackedResource(resource);
  return async () => {
    await action();
    removeTrackedResource(resource);
  };
}

export function readTrackedResources(): readonly LiveCleanupResource[] {
  const path = cleanupFile();
  if (!path || !existsSync(path)) return [];
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(value)) throw new Error(`Live cleanup state ${path} is invalid.`);
  return value as LiveCleanupResource[];
}

export function removeTrackedResource(resource: LiveCleanupResource): void {
  const current = readTrackedResources();
  writeTrackedResources(current.filter((candidate) => resourceKey(candidate) !== resourceKey(resource)));
}

export async function providerRequest(
  url: string | URL,
  init: RequestInit,
  expected: readonly number[],
): Promise<Response> {
  const response = await fetch(url, init);
  if (expected.includes(response.status)) return response;
  const detail = redactProviderDetail((await response.text()).slice(0, 1_000));
  throw new Error(
    `Provider cleanup request ${init.method ?? "GET"} ${String(url)} failed with ${response.status}`
      + `${detail ? `: ${detail}` : "."}`,
  );
}

export async function waitForDeployment(
  read: () => Promise<DeploymentData | null>,
  timeoutMs = 8 * 60_000,
): Promise<DeploymentData> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const deployment = await read();
    assert.ok(deployment, "The provider lost the deployment during readiness polling.");
    if (deployment.status === "ready") return deployment;
    assert.notEqual(deployment.status, "failed", "The provider deployment failed.");
    assert.notEqual(deployment.status, "cancelled", "The provider deployment was cancelled.");
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  throw new Error(`Provider deployment did not become ready within ${timeoutMs}ms.`);
}

function selectedLiveProviders(): ReadonlySet<LiveProvider> {
  if (!liveEnabled) return new Set();
  const input = process.env.VIBY_LIVE_PROVIDERS?.trim();
  if (!input || input === "all") return providers;
  const selected = new Set<LiveProvider>();
  for (const value of input.split(",").map((item) => item.trim()).filter(Boolean)) {
    if (!providers.has(value as LiveProvider)) {
      throw new Error(`Unsupported VIBY_LIVE_PROVIDERS value: ${value}`);
    }
    selected.add(value as LiveProvider);
  }
  if (selected.size === 0) throw new Error("VIBY_LIVE_PROVIDERS selects no providers.");
  return selected;
}

function redactProviderDetail(value: string): string {
  return value
    .replace(/("?(?:access|refresh|id)?_?token"?\s*[:=]\s*")([^"]+)(")/gi, "$1[redacted]$3")
    .replace(/(bearer\s+)[a-z0-9._~-]+/gi, "$1[redacted]");
}

function addTrackedResource(resource: LiveCleanupResource): void {
  const current = readTrackedResources();
  if (current.some((candidate) => resourceKey(candidate) === resourceKey(resource))) return;
  writeTrackedResources([...current, resource]);
}

function writeTrackedResources(resources: readonly LiveCleanupResource[]): void {
  const path = cleanupFile();
  if (!path) return;
  if (resources.length === 0) {
    if (existsSync(path)) unlinkSync(path);
    return;
  }
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(resources, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, path);
}

function cleanupFile(): string | null {
  const configured = process.env.VIBY_LIVE_CLEANUP_FILE?.trim();
  if (configured) return resolve(configured);
  return liveEnabled ? resolve(".viby-live-cleanup.json") : null;
}

function resourceKey(resource: LiveCleanupResource): string {
  return JSON.stringify(resource);
}
