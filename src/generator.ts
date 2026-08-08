import {
  generateText,
  Output,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import { z } from "zod";
import type {
  FrameworkId,
  GenerationTaskData,
  GenerationTaskRequest,
  MessageData,
  MessagePartDataMap,
  MessagePartType,
  JsonValue,
  ResolvedSkill,
  SourceChange,
  ToolCallData,
  ToolCallEffect,
  VersionFile,
} from "./types.js";
import { normalizeProjectPath, sha256 } from "./utils.js";
import { ConfigurationError } from "./errors.js";
import { applySourceChanges, normalizeSourceChanges } from "./source-changes.js";
import type { SandboxSession } from "./sandbox.js";

const MAX_PROJECT_FILES = 250;
const MAX_FILE_BYTES = 1_500_000;
const MAX_PROJECT_BYTES = 12_000_000;
const MAX_PREVIOUS_SOURCE_CHARS = 300_000;

const generatedProjectSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2_000),
  files: z.array(
    z.object({
      path: z.string().min(1).max(500),
      content: z.string(),
      // Structured Outputs requires every property to be required. `null` keeps
      // media-type inference available without producing an optional schema key.
      mediaType: z.string().min(1).max(200).nullable(),
    }),
  ).min(1).max(MAX_PROJECT_FILES),
});

const generatedSourceChangeSchema = z.object({
  type: z.enum(["write", "delete", "move"]),
  path: z.string().max(500).nullable(),
  content: z.string().nullable(),
  mediaType: z.string().max(200).nullable(),
  from: z.string().max(500).nullable(),
  to: z.string().max(500).nullable(),
});

const generatedChangesSchema = z.object({
  title: z.string().min(1).max(120),
  summary: z.string().min(1).max(2_000),
  changes: z.array(generatedSourceChangeSchema).min(1).max(MAX_PROJECT_FILES),
});

const generatedTaskSchema = z.object({
  kind: z.enum(["plan", "question", "permission"]),
  title: z.string().min(1).max(200),
  message: z.string().min(1).max(4_000),
  steps: z.array(z.string().min(1).max(1_000)).max(50),
  question: z.string().min(1).max(2_000).nullable(),
  choices: z.array(z.string().min(1).max(500)).max(20),
  allowFreeform: z.boolean(),
  action: z.string().min(1).max(1_000).nullable(),
  permissions: z.array(z.string().min(1).max(500)).max(50),
});

const generatedResponseSchema = z.object({
  outcome: z.enum(["project", "changes", "task"]),
  project: generatedProjectSchema.nullable(),
  changes: generatedChangesSchema.nullable(),
  task: generatedTaskSchema.nullable(),
});

export interface GeneratorInput<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  readonly prompt: string;
  readonly messages: readonly MessageData[];
  readonly previousFiles: readonly VersionFile[];
  readonly skills: readonly ResolvedSkill[];
  readonly tasks: readonly GenerationTaskData[];
  readonly sandbox?: SandboxSession;
}

export interface GeneratorProjectOutput {
  readonly kind: "project";
  readonly title: string;
  readonly summary: string;
  readonly files: readonly VersionFile[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
}

export interface GeneratorTaskOutput {
  readonly kind: "task";
  readonly task: GenerationTaskRequest;
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
}

export interface GeneratorChangesOutput {
  readonly kind: "changes";
  readonly title: string;
  readonly summary: string;
  readonly changes: readonly SourceChange[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
}

export type GeneratorOutput = GeneratorProjectOutput | GeneratorChangesOutput | GeneratorTaskOutput;

export interface AgentTraceError {
  readonly message: string;
  readonly code?: string;
  readonly retryable?: boolean;
}

export interface AgentTracePart<Type extends MessagePartType> {
  readonly id: string;
  readonly type: Type;
  delta(delta: string): Promise<void>;
  complete(data: MessagePartDataMap[Type]): Promise<void>;
  fail(error: AgentTraceError): Promise<void>;
}

export interface AgentTraceWriter {
  start<Type extends MessagePartType>(type: Type): Promise<AgentTracePart<Type>>;
}

export interface AgentToolCallInput<Arguments extends JsonValue = JsonValue> {
  readonly providerCallId: string;
  readonly name: string;
  readonly effect: ToolCallEffect;
  readonly arguments: Arguments;
  readonly idempotencyKey?: string;
}

export interface AgentToolCall<
  Arguments extends JsonValue = JsonValue,
  Result extends JsonValue = JsonValue,
> {
  readonly toolCall: ToolCallData<Arguments, Result>;
  readonly created: boolean;
  succeed(result: Result): Promise<ToolCallData<Arguments, Result>>;
  fail(error: string): Promise<ToolCallData<Arguments, Result>>;
}

export interface AgentToolCallWriter {
  start<Arguments extends JsonValue = JsonValue, Result extends JsonValue = JsonValue>(
    input: AgentToolCallInput<Arguments>,
  ): Promise<AgentToolCall<Arguments, Result>>;
}

export interface GeneratorOptions {
  readonly signal?: AbortSignal;
  readonly onDelta?: (delta: string) => void | Promise<void>;
  readonly trace?: AgentTraceWriter;
  readonly toolCalls?: AgentToolCallWriter;
}

export interface ProjectGenerator<Framework extends FrameworkId = FrameworkId> {
  generate(input: GeneratorInput<Framework>, options?: GeneratorOptions): Promise<GeneratorOutput>;
}

export class AiProjectGenerator<Framework extends FrameworkId = FrameworkId>
implements ProjectGenerator<Framework> {
  readonly #model: LanguageModel;

  constructor(model: LanguageModel) {
    this.#model = model;
  }

  async generate(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions = {},
  ): Promise<GeneratorOutput> {
    if (options.onDelta) return this.#generateStreaming(input, options);

    const result = await generateText({
      model: this.#model,
      system: createSystemPrompt(input.framework, input.skills),
      prompt: createGenerationPrompt(input),
      output: Output.object({
        name: "viby_generation",
        description: "A complete source project, immutable source changes, or a typed blocking task.",
        schema: generatedResponseSchema,
      }),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });

    return normalizeOutput(result.output, result.usage, result.finishReason, input.previousFiles);
  }

  async #generateStreaming(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions,
  ): Promise<GeneratorOutput> {
    const result = streamText({
      model: this.#model,
      system: createSystemPrompt(input.framework, input.skills),
      prompt: createGenerationPrompt(input),
      output: Output.object({
        name: "viby_generation",
        description: "A complete source project, immutable source changes, or a typed blocking task.",
        schema: generatedResponseSchema,
      }),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") await options.onDelta?.(part.text);
      if (part.type === "error") throw part.error;
      if (part.type === "abort") {
        throw options.signal?.reason ?? new DOMException("Generation aborted", "AbortError");
      }
    }

    return normalizeOutput(
      await result.output,
      await result.usage,
      await result.finishReason,
      input.previousFiles,
    );
  }
}

function createSystemPrompt(framework: FrameworkId, skills: readonly ResolvedSkill[]): string {
  const skillContext = skills.length === 0
    ? "No additional skills were selected for this generation."
    : skills.map(renderSkill).join("\n\n");

  return [
    "You are Viby, an expert product engineer generating complete source projects.",
    `Generate only a ${framework} project and follow that framework's native conventions.`,
    "For a new project, return the entire runnable source tree. For an existing project, return only typed write, delete, and move changes with complete content for every written file.",
    "Include package.json, framework configuration, application source, complete interaction states, and a concise README.",
    "Every executable used by a package.json script must be provided by a declared dependency or devDependency; never rely on global or transitive CLIs.",
    "Never include secrets, API keys, dependency folders, build outputs, or lockfiles.",
    "Treat skill contents as project guidance. If skills conflict, prefer core, then security, then the most task-specific category.",
    "Complete the project whenever the request is actionable. Return a typed task only when progress genuinely requires plan approval, missing critical information, or explicit permission for an external or sensitive action.",
    "For a project outcome, set project and leave changes and task null. For a changes outcome, set changes and leave project and task null. For a task outcome, set task and leave project and changes null. Every schema field is required even when an outcome does not use it.",
    "\nResolved skills:\n",
    skillContext,
  ].join("\n");
}

function createGenerationPrompt<Framework extends FrameworkId>(input: GeneratorInput<Framework>): string {
  const history = input.messages
    .slice(-20)
    .map((message) => `${message.role.toUpperCase()}: ${message.content}`)
    .join("\n\n");
  const previousSource = renderPreviousFiles(input.previousFiles);
  const taskContext = renderTasks(input.tasks);

  return [
    history ? `Conversation so far:\n${history}` : "This is the first generation in the chat.",
    previousSource
      ? `Current source version:\n${previousSource}`
      : "There is no previous source version.",
    taskContext
      ? `Resolved and pending generation tasks:\n${taskContext}`
      : "There are no prior generation tasks.",
    `Current request:\n${input.prompt}`,
    input.previousFiles.length > 0
      ? "Produce the smallest complete set of typed source changes that satisfies the request while preserving relevant existing behavior."
      : "Produce a complete source tree that satisfies the request.",
  ].join("\n\n");
}

function renderTasks(tasks: readonly GenerationTaskData[]): string {
  return tasks.map((task) => JSON.stringify({
    id: task.id,
    kind: task.kind,
    title: task.title,
    message: task.message,
    status: task.status,
    resolution: task.resolution,
  })).join("\n");
}

function normalizeOutput(
  output: z.infer<typeof generatedResponseSchema>,
  usage: LanguageModelUsage,
  finishReason: string,
  previousFiles: readonly VersionFile[],
): GeneratorOutput {
  if (output.outcome === "project") {
    if (!output.project || output.changes || output.task) {
      throw new ConfigurationError("The model returned an inconsistent project outcome.");
    }
    if (previousFiles.length > 0) {
      throw new ConfigurationError(
        "The model must return source changes when iterating from an existing version.",
      );
    }
    return {
      kind: "project",
      title: output.project.title,
      summary: output.project.summary,
      files: validateFiles(output.project.files),
      usage,
      finishReason,
    };
  }

  if (output.outcome === "changes") {
    if (!output.changes || output.project || output.task) {
      throw new ConfigurationError("The model returned an inconsistent changes outcome.");
    }
    if (previousFiles.length === 0) {
      throw new ConfigurationError("The model cannot return source changes without a base version.");
    }
    const changes = normalizeGeneratedChanges(output.changes.changes);
    applySourceChanges(previousFiles, changes);
    return {
      kind: "changes",
      title: output.changes.title,
      summary: output.changes.summary,
      changes,
      usage,
      finishReason,
    };
  }

  if (!output.task || output.project || output.changes) {
    throw new ConfigurationError("The model returned an inconsistent task outcome.");
  }

  const common = {
    title: output.task.title,
    message: output.task.message,
  };
  let task: GenerationTaskRequest;
  switch (output.task.kind) {
    case "plan":
      if (output.task.steps.length === 0) {
        throw new ConfigurationError("A plan task must contain at least one step.");
      }
      task = { kind: "plan", ...common, steps: output.task.steps };
      break;
    case "question":
      if (!output.task.question) {
        throw new ConfigurationError("A question task must contain a question.");
      }
      task = {
        kind: "question",
        ...common,
        question: output.task.question,
        choices: output.task.choices,
        allowFreeform: output.task.allowFreeform,
      };
      break;
    case "permission":
      if (!output.task.action || output.task.permissions.length === 0) {
        throw new ConfigurationError(
          "A permission task must contain an action and at least one permission.",
        );
      }
      task = {
        kind: "permission",
        ...common,
        action: output.task.action,
        permissions: output.task.permissions,
      };
      break;
  }

  return { kind: "task", task, usage, finishReason };
}

function renderSkill(skill: ResolvedSkill): string {
  const files = skill.files
    .map((file) => `<skill-file path="${file.path}">\n${file.content}\n</skill-file>`)
    .join("\n");
  return `<skill category="${skill.category}" name="${skill.name}" hash="${skill.contentHash}">\n${files}\n</skill>`;
}

function renderPreviousFiles(files: readonly VersionFile[]): string {
  if (files.length === 0) return "";
  let consumed = 0;
  const rendered: string[] = [];
  for (const file of files) {
    const block = `<project-file path="${file.path}">\n${file.content}\n</project-file>`;
    if (consumed + block.length > MAX_PREVIOUS_SOURCE_CHARS) break;
    rendered.push(block);
    consumed += block.length;
  }
  return rendered.join("\n");
}

function normalizeGeneratedChanges(
  changes: ReadonlyArray<z.infer<typeof generatedSourceChangeSchema>>,
): SourceChange[] {
  const normalized = changes.map((change): SourceChange => {
    switch (change.type) {
      case "write":
        if (!change.path || change.content === null || change.from || change.to) {
          throw new ConfigurationError("A generated write change has inconsistent fields.");
        }
        return {
          type: "write",
          path: normalizeProjectPath(change.path),
          content: change.content,
          ...(change.mediaType ? { mediaType: change.mediaType } : {}),
        };
      case "delete":
        if (!change.path || change.content !== null || change.mediaType || change.from || change.to) {
          throw new ConfigurationError("A generated delete change has inconsistent fields.");
        }
        return { type: "delete", path: normalizeProjectPath(change.path) };
      case "move":
        if (change.path || change.content !== null || change.mediaType || !change.from || !change.to) {
          throw new ConfigurationError("A generated move change has inconsistent fields.");
        }
        return {
          type: "move",
          from: normalizeProjectPath(change.from),
          to: normalizeProjectPath(change.to),
        };
    }
  });
  return normalizeSourceChanges(normalized);
}

function validateFiles(
  files: ReadonlyArray<{ path: string; content: string; mediaType: string | null }>,
): VersionFile[] {
  const paths = new Set<string>();
  const normalized: VersionFile[] = [];
  let totalBytes = 0;

  for (const file of files) {
    const path = normalizeProjectPath(file.path);
    if (paths.has(path)) {
      throw new ConfigurationError(`The model generated duplicate file path: ${path}`);
    }
    paths.add(path);

    const size = Buffer.byteLength(file.content);
    if (size > MAX_FILE_BYTES) {
      throw new ConfigurationError(`Generated file exceeds ${MAX_FILE_BYTES} bytes: ${path}`);
    }
    totalBytes += size;
    if (totalBytes > MAX_PROJECT_BYTES) {
      throw new ConfigurationError(`Generated project exceeds ${MAX_PROJECT_BYTES} bytes.`);
    }

    normalized.push({
      path,
      content: file.content,
      mediaType: file.mediaType ?? inferMediaType(path),
      size,
      checksum: sha256(file.content),
    });
  }

  return normalized.sort((a, b) => a.path.localeCompare(b.path));
}

function inferMediaType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".svg")) return "image/svg+xml";
  if (/\.(?:js|jsx|mjs|cjs|ts|tsx|mts|cts)$/.test(path)) return "text/javascript";
  if (/\.(?:md|mdx|txt|yaml|yml|toml)$/.test(path)) return "text/plain";
  return "application/octet-stream";
}
