import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import type {
  Codex as CodexClient,
  CodexOptions,
  ModelReasoningEffort,
  ThreadEvent,
  ThreadOptions,
  Usage,
  WebSearchMode,
} from "@openai/codex-sdk";
import type { LanguageModelUsage } from "ai";
import { ConfigurationError } from "./errors.js";
import { defineCodingAgent, type CodingAgent } from "./generation-engine.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
} from "./generator.js";
import type { FrameworkId, SourceChange, VersionFile } from "./types.js";
import { normalizeProjectPath, sha256 } from "./utils.js";

const DEFAULT_MAX_FILES = 500;
const DEFAULT_MAX_FILE_BYTES = 2_000_000;
const DEFAULT_MAX_PROJECT_BYTES = 20_000_000;
const IGNORED_DIRECTORIES = new Set([".git", "node_modules", "dist", "build", ".next"]);

export interface CodexAgentOptions {
  /** Codex model identifier passed through unchanged to the official SDK. */
  readonly model: string;
  readonly reasoningEffort?: ModelReasoningEffort;
  readonly networkAccess?: boolean;
  readonly webSearch?: WebSearchMode;
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly codexPathOverride?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly config?: CodexOptions["config"];
  readonly maxFiles?: number;
  readonly maxFileBytes?: number;
  readonly maxProjectBytes?: number;
  /** Test and advanced-host escape hatch. Omit to use the official Codex SDK. */
  readonly client?: Pick<CodexClient, "startThread">;
}

/**
 * Creates a packaged Codex coding agent for Viby.
 *
 * Change runs receive a disposable workspace-write checkout. Inspection runs
 * use Codex read-only sandboxing and Viby will reject any source-producing
 * output at the durable completion boundary.
 */
export function codex<Framework extends FrameworkId = FrameworkId>(
  options: CodexAgentOptions,
): CodingAgent<Framework> {
  const normalized = normalizeOptions(options);
  return defineCodingAgent({
    identity: { provider: "openai-codex", model: normalized.model },
    generate: (input, generationOptions) => runCodex(
      normalized,
      input,
      generationOptions ?? {},
    ),
  });
}

interface NormalizedCodexAgentOptions extends CodexAgentOptions {
  readonly model: string;
  readonly maxFiles: number;
  readonly maxFileBytes: number;
  readonly maxProjectBytes: number;
}

async function runCodex<Framework extends FrameworkId>(
  config: NormalizedCodexAgentOptions,
  input: GeneratorInput<Framework>,
  options: GeneratorOptions,
): Promise<GeneratorOutput> {
  const root = await mkdtemp(join(tmpdir(), "viby-codex-"));
  const workspace = join(root, "workspace");
  await mkdir(workspace, { recursive: true });
  try {
    await materializeFiles(workspace, input.previousFiles);
    const client = config.client ?? await createCodexClient(config);
    const inspection = input.operation === "inspect";
    const threadOptions: ThreadOptions = {
      model: config.model,
      workingDirectory: workspace,
      skipGitRepoCheck: true,
      approvalPolicy: "never",
      sandboxMode: inspection ? "read-only" : "workspace-write",
      ...(config.reasoningEffort ? { modelReasoningEffort: config.reasoningEffort } : {}),
      ...(inspection
        ? { networkAccessEnabled: false, webSearchMode: "disabled" as const }
        : {
            ...(config.networkAccess === undefined
              ? {}
              : { networkAccessEnabled: config.networkAccess }),
            ...(config.webSearch ? { webSearchMode: config.webSearch } : {}),
          }),
    };
    const turn = await client.startThread(threadOptions).runStreamed(
      codexPrompt(input),
      options.signal ? { signal: options.signal } : undefined,
    );
    const streamedText = new Map<string, string>();
    let finalResponse = "";
    let usage: Usage | null = null;
    for await (const event of turn.events as AsyncIterable<ThreadEvent>) {
      options.signal?.throwIfAborted();
      if (
        (event.type === "item.started"
          || event.type === "item.updated"
          || event.type === "item.completed")
        && event.item.type === "agent_message"
      ) {
        const previous = streamedText.get(event.item.id) ?? "";
        const next = event.item.text;
        const delta = next.startsWith(previous) ? next.slice(previous.length) : next;
        if (delta) await options.onDelta?.(delta);
        streamedText.set(event.item.id, next);
        if (event.type === "item.completed") finalResponse = next;
      }
      if (event.type === "item.completed") {
        await recordCodexTrace(event.item, options, workspace);
      }
      if (event.type === "turn.completed") usage = event.usage;
      if (event.type === "turn.failed") throw new Error(event.error.message);
      if (event.type === "error") throw new Error(event.message);
    }
    finalResponse ||= [...streamedText.values()].at(-1) ?? "";
    if (!finalResponse.trim()) {
      throw new ConfigurationError("Codex completed without an assistant response.");
    }
    const modelUsage = codexUsage(usage);
    if (input.operation === "inspect") {
      return {
        kind: "message",
        content: finalResponse.trim(),
        usage: modelUsage,
        finishReason: "stop",
      };
    }
    const files = await collectFiles(workspace, config, input.previousFiles);
    const summary = finalResponse.trim().slice(0, 2_000);
    if (input.previousFiles.length === 0) {
      return {
        kind: "project",
        title: "Generated project",
        summary,
        files,
        usage: modelUsage,
        finishReason: "stop",
      };
    }
    const changes = diffFiles(input.previousFiles, files);
    if (changes.length === 0) {
      throw new ConfigurationError("Codex completed without changing the project workspace.");
    }
    return {
      kind: "changes",
      title: "Updated project",
      summary,
      changes,
      usage: modelUsage,
      finishReason: "stop",
    };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function createCodexClient(config: NormalizedCodexAgentOptions): Promise<CodexClient> {
  let module: typeof import("@openai/codex-sdk");
  try {
    module = await import("@openai/codex-sdk");
  } catch (error) {
    throw new ConfigurationError(
      `The Codex agent requires @openai/codex-sdk. Install it in the host application. ${error instanceof Error ? error.message : ""}`.trim(),
    );
  }
  return new module.Codex({
    ...(config.apiKey ? { apiKey: config.apiKey } : {}),
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    ...(config.codexPathOverride ? { codexPathOverride: config.codexPathOverride } : {}),
    ...(config.env ? { env: { ...config.env } } : {}),
    ...(config.config ? { config: config.config } : {}),
  });
}

function codexPrompt<Framework extends FrameworkId>(input: GeneratorInput<Framework>): string {
  const skills = input.skills.map((skill) => [
    `Skill ${skill.category}/${skill.name}:`,
    ...skill.files.map((file) => `<skill-file path="${file.path}">\n${file.content}\n</skill-file>`),
  ].join("\n")).join("\n\n");
  const history = input.messages.slice(-20)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  const readOnly = input.operation === "inspect";
  const lockedFiles = input.previousFiles
    .filter((file) => file.locked)
    .map((file) => file.path)
    .sort();
  return [
    readOnly
      ? "Inspect this project in read-only mode. Do not modify, create, move, or delete files and do not run effectful commands."
      : "Implement the requested change directly in the current workspace. Keep the result runnable and production-ready.",
    `Framework: ${input.framework}.`,
    readOnly
      ? "Ground the response in files you actually inspect, cite relevant paths, and distinguish evidence from inference."
      : "Respect existing architecture, locked-file policy, and framework conventions. Do not add dependency folders, build output, secrets, or lockfiles.",
    !readOnly && lockedFiles.length > 0
      ? `Locked files (must remain byte-for-byte unchanged):\n${lockedFiles.map((path) => `- ${path}`).join("\n")}`
      : "",
    input.instructions ? `Host instructions:\n${input.instructions}` : "",
    skills ? `Resolved skills:\n${skills}` : "",
    history ? `Conversation:\n${history}` : "",
    `Current request:\n${input.prompt}`,
  ].filter(Boolean).join("\n\n");
}

async function recordCodexTrace(
  item: Extract<ThreadEvent, { type: "item.completed" }>["item"],
  options: GeneratorOptions,
  workspace: string,
): Promise<void> {
  if (item.type === "reasoning" && item.text.trim()) {
    const part = await options.trace?.start("reasoning-summary");
    await part?.complete({ text: item.text.trim() });
    return;
  }
  if (item.type === "command_execution") {
    const part = await options.trace?.start("command");
    await part?.complete({
      command: item.command,
      args: [],
      exitCode: item.exit_code ?? null,
    });
    return;
  }
  if (item.type === "file_change") {
    for (const change of item.changes) {
      const part = await options.trace?.start("file-edit");
      await part?.complete({
        operation: change.kind === "add" ? "create" : change.kind,
        path: workspaceProjectPath(workspace, change.path),
      });
    }
    return;
  }
  if (item.type === "web_search") {
    const part = await options.trace?.start("search");
    await part?.complete({ query: item.query, path: null, matches: null });
    return;
  }
  if (item.type === "error") {
    const part = await options.trace?.start("error");
    await part?.complete({ message: item.message, code: "codex", retryable: false });
  }
}

function workspaceProjectPath(workspace: string, path: string): string {
  return normalizeProjectPath(relative(workspace, resolve(workspace, path)));
}

async function materializeFiles(root: string, files: readonly VersionFile[]): Promise<void> {
  for (const file of files) {
    const path = safeWorkspacePath(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.content, "utf8");
  }
}

async function collectFiles(
  root: string,
  config: Pick<NormalizedCodexAgentOptions, "maxFiles" | "maxFileBytes" | "maxProjectBytes">,
  previousFiles: readonly VersionFile[],
): Promise<VersionFile[]> {
  const previousByPath = new Map(previousFiles.map((file) => [file.path, file]));
  const paths: string[] = [];
  async function walk(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory() && IGNORED_DIRECTORIES.has(entry.name)) continue;
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await walk(absolute);
      else if (entry.isFile()) paths.push(relative(root, absolute).split(sep).join("/"));
      if (paths.length > config.maxFiles) {
        throw new ConfigurationError(`Codex workspace exceeded ${config.maxFiles} source files.`);
      }
    }
  }
  await walk(root);
  let totalBytes = 0;
  const files: VersionFile[] = [];
  for (const path of paths.sort()) {
    const bytes = await readFile(safeWorkspacePath(root, path));
    if (bytes.byteLength > config.maxFileBytes) {
      throw new ConfigurationError(`Codex source file exceeds ${config.maxFileBytes} bytes: ${path}`);
    }
    totalBytes += bytes.byteLength;
    if (totalBytes > config.maxProjectBytes) {
      throw new ConfigurationError(`Codex workspace exceeded ${config.maxProjectBytes} bytes.`);
    }
    if (bytes.includes(0)) continue;
    const content = bytes.toString("utf8");
    const previous = previousByPath.get(path);
    files.push({
      path: normalizeProjectPath(path),
      content,
      // Existing source metadata is part of the immutable project contract.
      // Re-inferring it here would turn an unchanged file into a false write.
      mediaType: previous ? previous.mediaType : mediaTypeForPath(path),
      size: bytes.byteLength,
      checksum: sha256(bytes),
      locked: false,
    });
  }
  if (files.length === 0) throw new ConfigurationError("Codex workspace contains no source files.");
  return files;
}

function diffFiles(previous: readonly VersionFile[], next: readonly VersionFile[]): SourceChange[] {
  const before = new Map(previous.map((file) => [file.path, file]));
  const after = new Map(next.map((file) => [file.path, file]));
  const changes: SourceChange[] = [];
  for (const path of [...before.keys()].sort()) {
    if (!after.has(path)) changes.push({ type: "delete", path });
  }
  for (const [path, file] of [...after.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const old = before.get(path);
    if (!old || old.content !== file.content || old.mediaType !== file.mediaType) {
      changes.push({ type: "write", path, content: file.content, mediaType: file.mediaType });
    }
  }
  return changes;
}

function codexUsage(usage: Usage | null): LanguageModelUsage {
  const inputTokens = usage?.input_tokens ?? 0;
  const outputTokens = usage?.output_tokens ?? 0;
  return {
    inputTokens,
    inputTokenDetails: {
      noCacheTokens: Math.max(0, inputTokens - (usage?.cached_input_tokens ?? 0)),
      cacheReadTokens: usage?.cached_input_tokens ?? 0,
      cacheWriteTokens: usage?.cache_write_input_tokens ?? 0,
    },
    outputTokens,
    outputTokenDetails: {
      textTokens: Math.max(0, outputTokens - (usage?.reasoning_output_tokens ?? 0)),
      reasoningTokens: usage?.reasoning_output_tokens ?? 0,
    },
    totalTokens: inputTokens + outputTokens,
  };
}

function safeWorkspacePath(root: string, path: string): string {
  const normalized = normalizeProjectPath(path);
  const absolute = resolve(root, normalized);
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`;
  if (!absolute.startsWith(prefix)) throw new ConfigurationError(`Unsafe workspace path: ${path}`);
  return absolute;
}

function mediaTypeForPath(path: string): string {
  const extension = path.split(".").at(-1)?.toLowerCase();
  return ({
    css: "text/css",
    html: "text/html",
    js: "text/javascript",
    jsx: "text/jsx",
    json: "application/json",
    md: "text/markdown",
    mjs: "text/javascript",
    ts: "text/typescript",
    tsx: "text/tsx",
    vue: "text/x-vue",
    svelte: "text/x-svelte",
    yaml: "application/yaml",
    yml: "application/yaml",
  } as Record<string, string>)[extension ?? ""] ?? "text/plain";
}

function normalizeOptions(options: CodexAgentOptions): NormalizedCodexAgentOptions {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ConfigurationError("codex() requires an options object.");
  }
  const model = options.model?.trim();
  if (!model || model.length > 200) {
    throw new ConfigurationError("codex.model must contain between 1 and 200 characters.");
  }
  return Object.freeze({
    ...options,
    model,
    maxFiles: boundedInteger(options.maxFiles, DEFAULT_MAX_FILES, 1, 2_000, "maxFiles"),
    maxFileBytes: boundedInteger(
      options.maxFileBytes,
      DEFAULT_MAX_FILE_BYTES,
      1_000,
      25_000_000,
      "maxFileBytes",
    ),
    maxProjectBytes: boundedInteger(
      options.maxProjectBytes,
      DEFAULT_MAX_PROJECT_BYTES,
      1_000,
      100_000_000,
      "maxProjectBytes",
    ),
  });
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new ConfigurationError(`codex.${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return normalized;
}
