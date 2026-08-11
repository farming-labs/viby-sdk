import { unzipSync, zipSync } from "fflate";
import { ConfigurationError } from "./errors.js";
import type { ArtifactReference } from "./artifact-store.js";
import type { IntegrationSourceFile } from "./integrations.js";
import type { SandboxCommand, SandboxSession } from "./sandbox.js";
import type { FrameworkId } from "./types.js";
import { createId, normalizeProjectPath, sha256 } from "./utils.js";

const DEFAULT_MAX_FILES = 20_000;
const DEFAULT_MAX_BYTES = 100_000_000;

export interface DeploymentPreparationConfig<Framework extends FrameworkId = FrameworkId> {
  /** Optional dependency-install step run before the build. */
  readonly install?: SandboxCommand;
  /** Framework-provided build command. */
  readonly build: SandboxCommand;
  /** Framework build output. A provider default such as `dist` is used when omitted. */
  readonly outputDirectory?: string;
  /** Runtime used only to enumerate the completed output without shell interpolation. */
  readonly collectorCommand?: string;
  readonly maxFiles?: number;
  readonly maxBytes?: number;
}

export interface DeploymentPreparationInput {
  readonly env?: Readonly<Record<string, string>>;
}

export interface DeploymentArtifactData {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly deploymentId: string;
  readonly framework: FrameworkId;
  readonly sandboxProvider: string;
  readonly outputDirectory: string;
  readonly commands: readonly DeploymentArtifactCommand[];
  readonly fileCount: number;
  readonly mediaType: "application/zip";
  readonly size: number;
  readonly checksum: string;
  readonly artifact: ArtifactReference;
  readonly createdAt: Date;
}

export interface DeploymentArtifactContent extends DeploymentArtifactData {
  readonly bytes: Uint8Array;
}

export interface DeploymentArtifactCommand {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly string[];
  readonly timeoutMs: number | null;
}

export interface CreateDeploymentArtifactRecord {
  readonly id: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly deploymentId: string;
  readonly framework: FrameworkId;
  readonly sandboxProvider: string;
  readonly outputDirectory: string;
  readonly commands: readonly DeploymentArtifactCommand[];
  readonly fileCount: number;
  readonly bytes: Uint8Array;
  readonly size: number;
  readonly checksum: string;
}

export interface PreparedDeploymentSource {
  readonly outputDirectory: string;
  readonly files: readonly IntegrationSourceFile[];
  readonly archive: Uint8Array;
  readonly commands: readonly DeploymentArtifactCommand[];
}

export async function prepareDeploymentSource(
  sandbox: SandboxSession,
  config: DeploymentPreparationConfig,
  providerOutputDirectory: string | undefined,
  input: DeploymentPreparationInput = {},
  signal?: AbortSignal,
): Promise<PreparedDeploymentSource> {
  const normalized = normalizePreparationConfig(config, providerOutputDirectory);
  const commands = [normalized.install, normalized.build].filter(
    (command): command is SandboxCommand => command !== undefined,
  );
  for (const command of commands) {
    const result = await sandbox.run({
      ...command,
      env: { ...(command.env ?? {}), ...(input.env ?? {}) },
      ...(signal ? { signal } : {}),
    });
    if (result.exitCode !== 0) {
      const detail = (result.stderr || result.stdout).trim().slice(0, 2_000);
      throw new Error(
        `Deployment preparation command ${command.command} exited with ${result.exitCode}`
          + `${detail ? `: ${detail}` : "."}`,
      );
    }
  }

  const manifestPath = `.viby/deployment-output-${createId()}.json`;
  const collected = await sandbox.run({
    command: normalized.collectorCommand,
    args: ["-e", OUTPUT_COLLECTOR_SCRIPT, normalized.outputDirectory, manifestPath],
    ...(signal ? { signal } : {}),
  });
  if (collected.exitCode !== 0) {
    const detail = (collected.stderr || collected.stdout).trim().slice(0, 2_000);
    throw new Error(`Could not enumerate deployment output${detail ? `: ${detail}` : "."}`);
  }
  const paths = parseOutputManifest(await sandbox.readFile(
    manifestPath,
    signal ? { signal } : {},
  ));
  if (paths.length === 0) {
    throw new ConfigurationError(
      `Deployment build output ${normalized.outputDirectory} contains no files.`,
    );
  }
  if (paths.length > normalized.maxFiles) {
    throw new ConfigurationError(
      `Deployment build output exceeds the ${normalized.maxFiles} file limit.`,
    );
  }
  let totalBytes = 0;
  const files: IntegrationSourceFile[] = [];
  const archiveEntries: Record<string, Uint8Array> = Object.create(null) as Record<
    string,
    Uint8Array
  >;
  for (const relativePath of paths) {
    const path = normalizeProjectPath(`${normalized.outputDirectory}/${relativePath}`);
    const content = await sandbox.readFile(path, signal ? { signal } : {});
    totalBytes += content.byteLength;
    if (totalBytes > normalized.maxBytes) {
      throw new ConfigurationError(
        `Deployment build output exceeds the ${normalized.maxBytes} byte limit.`,
      );
    }
    const bytes = Uint8Array.from(content);
    files.push({ path, content: bytes, mediaType: deploymentMediaType(path) });
    archiveEntries[path] = bytes;
  }
  return {
    outputDirectory: normalized.outputDirectory,
    files,
    archive: zipSync(archiveEntries, { level: 6 }),
    commands: commands.map((command) => publicBuildCommand(command, input.env)),
  };
}

export function deploymentFilesFromArtifact(
  artifact: DeploymentArtifactContent,
): readonly IntegrationSourceFile[] {
  if (sha256(artifact.bytes) !== artifact.checksum || artifact.bytes.byteLength !== artifact.size) {
    throw new Error(`Deployment artifact ${artifact.id} failed its size or checksum validation.`);
  }
  return Object.entries(unzipSync(artifact.bytes))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([path, content]) => ({
      path: normalizeProjectPath(path),
      content: Uint8Array.from(content),
      mediaType: deploymentMediaType(path),
    }));
}

function normalizePreparationConfig(
  config: DeploymentPreparationConfig,
  providerOutputDirectory: string | undefined,
) {
  if (!config || typeof config !== "object" || !config.build) {
    throw new ConfigurationError("Deployment preparation requires a build command.");
  }
  const configuredOutput = config.outputDirectory ?? providerOutputDirectory ?? "dist";
  if (
    typeof configuredOutput !== "string"
    || configuredOutput.trim().length === 0
    || configuredOutput.length > 1_000
  ) {
    throw new ConfigurationError(
      "Deployment preparation outputDirectory must contain 1-1000 characters.",
    );
  }
  const outputDirectory = normalizeProjectPath(configuredOutput.trim());
  const collectorCommand = typeof config.collectorCommand === "string"
    ? config.collectorCommand.trim()
    : "node";
  if (!collectorCommand || collectorCommand.length > 500) {
    throw new ConfigurationError("Deployment collector command must contain 1-500 characters.");
  }
  return {
    install: config.install,
    build: config.build,
    outputDirectory,
    collectorCommand,
    maxFiles: boundedLimit(config.maxFiles, DEFAULT_MAX_FILES, 1, 100_000, "maxFiles"),
    maxBytes: boundedLimit(config.maxBytes, DEFAULT_MAX_BYTES, 1, 1_000_000_000, "maxBytes"),
  };
}

function parseOutputManifest(bytes: Uint8Array): readonly string[] {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new Error("The deployment output manifest is invalid.");
  }
  if (!Array.isArray(value) || value.some((path) => typeof path !== "string")) {
    throw new Error("The deployment output manifest must contain file paths.");
  }
  return [...new Set(value.map((path) => normalizeProjectPath(path)))].sort();
}

function publicBuildCommand(
  command: SandboxCommand,
  runtimeEnvironment: Readonly<Record<string, string>> | undefined,
): DeploymentArtifactCommand {
  return {
    command: command.command,
    args: [...(command.args ?? [])],
    cwd: command.cwd ?? ".",
    environment: [...new Set([
      ...Object.keys(command.env ?? {}),
      ...Object.keys(runtimeEnvironment ?? {}),
    ])].sort(),
    timeoutMs: command.timeoutMs ?? null,
  };
}

function boundedLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isSafeInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new ConfigurationError(`Deployment preparation ${label} must be ${minimum}-${maximum}.`);
  }
  return normalized;
}

function deploymentMediaType(path: string): string {
  const extension = path.toLowerCase().split(".").at(-1);
  return ({
    html: "text/html",
    css: "text/css",
    js: "text/javascript",
    mjs: "text/javascript",
    json: "application/json",
    svg: "image/svg+xml",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    ico: "image/x-icon",
    txt: "text/plain",
    xml: "application/xml",
    wasm: "application/wasm",
  } as Record<string, string>)[extension ?? ""] ?? "application/octet-stream";
}

const OUTPUT_COLLECTOR_SCRIPT = String.raw`
const fs = require("node:fs/promises");
const path = require("node:path");
const output = path.resolve(process.cwd(), process.argv[1]);
const manifest = path.resolve(process.cwd(), process.argv[2]);
const files = [];
async function walk(directory, prefix = "") {
  const entries = await fs.readdir(directory, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (entry.isSymbolicLink()) throw new Error("Deployment output cannot contain symbolic links");
    const relative = prefix ? prefix + "/" + entry.name : entry.name;
    const absolute = path.join(directory, entry.name);
    if (entry.isDirectory()) await walk(absolute, relative);
    else if (entry.isFile()) files.push(relative);
  }
}
walk(output).then(async () => {
  await fs.mkdir(path.dirname(manifest), { recursive: true });
  await fs.writeFile(manifest, JSON.stringify(files));
}).catch((error) => { console.error(error.message); process.exitCode = 1; });
`;
