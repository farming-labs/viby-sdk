import {
  generateText,
  Output,
  streamText,
  type LanguageModel,
  type LanguageModelUsage,
  type GeneratedFile,
} from "ai";
import { z } from "zod";
import type {
  FrameworkId,
  AttachmentContent,
  GenerationTaskData,
  GenerationTaskRequest,
  GenerationOperation,
  GenerationSteeringData,
  MessageData,
  MessagePartDataMap,
  MessagePartType,
  JsonValue,
  ResolvedSkill,
  SourceChange,
  ToolCallData,
  ToolCallEffect,
  UserScope,
  VersionFile,
  VersionEntry,
  GeneratedArtifactKind,
} from "./types.js";
import { normalizeProjectPath, sha256 } from "./utils.js";
import { ConfigurationError } from "./errors.js";
import { applySourceChanges, normalizeSourceChanges } from "./source-changes.js";
import type { SandboxSession } from "./sandbox.js";
import type { ToolSourceContext } from "./tool-source.js";
import type { ProviderRequestAttributionWriter } from "./provider-request-attribution.js";

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

const inspectionResponseSchema = z.object({
  response: z.string().min(1).max(50_000),
});

export interface GeneratorInput<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  /** Defaults to change for engines built before inspection support. */
  readonly operation?: GenerationOperation;
  readonly prompt: string;
  readonly instructions?: string | null;
  readonly metadata?: Readonly<Record<string, JsonValue>>;
  readonly messages: readonly MessageData[];
  readonly previousFiles: readonly VersionFile[];
  /** Full immutable project tree, including artifact-backed binary paths. */
  readonly previousEntries?: readonly VersionEntry[];
  readonly skills: readonly ResolvedSkill[];
  readonly tasks: readonly GenerationTaskData[];
  readonly attachments?: readonly AttachmentContent[];
  readonly sandbox?: SandboxSession;
  /** Durable identity and chat metadata supplied by Viby, never model-authored. */
  readonly toolContext?: ToolSourceContext<Framework>;
}

export interface GeneratorProjectOutput {
  readonly kind: "project";
  readonly title: string;
  readonly summary: string;
  readonly files: readonly VersionFile[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  readonly artifacts?: readonly GeneratorArtifactOutput[];
}

export interface GeneratorTaskOutput {
  readonly kind: "task";
  readonly task: GenerationTaskRequest;
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  readonly artifacts?: readonly GeneratorArtifactOutput[];
}

export interface GeneratorChangesOutput {
  readonly kind: "changes";
  readonly title: string;
  readonly summary: string;
  readonly changes: readonly SourceChange[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  readonly artifacts?: readonly GeneratorArtifactOutput[];
}

export interface GeneratorMessageOutput {
  readonly kind: "message";
  readonly content: string;
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  readonly artifacts?: readonly GeneratorArtifactOutput[];
}

export interface GeneratorArtifactOutput {
  readonly kind?: GeneratedArtifactKind;
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export type GeneratorOutput =
  | GeneratorProjectOutput
  | GeneratorChangesOutput
  | GeneratorTaskOutput
  | GeneratorMessageOutput;

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
  /** Stable durable identity for remote harness idempotency, logging, and reconnect metadata. */
  readonly run?: GenerationEngineRunIdentity;
  readonly onDelta?: (delta: string) => void | Promise<void>;
  readonly trace?: AgentTraceWriter;
  readonly toolCalls?: AgentToolCallWriter;
  /** Durable per-provider-call attribution for support, usage, and billing. */
  readonly attribution?: ProviderRequestAttributionWriter;
  /** Opaque credential-free engine state scoped to this exact durable attempt. */
  readonly checkpoint?: GenerationEngineCheckpointChannel;
  /** Host-selected, policy-authorized tools projected without provider-specific types. */
  readonly tools?: GenerationEngineToolChannel;
  /** Durable, provider-neutral steering consumed at safe agent boundaries. */
  readonly steering?: GenerationSteeringChannel;
}

export interface GenerationEngineRunIdentity extends UserScope {
  readonly chatId: string;
  readonly generationId: string;
  readonly attemptId: string;
}

export interface GenerationEngineCheckpointData {
  readonly generationId: string;
  readonly attemptId: string;
  readonly revision: number;
  readonly cursor: string | null;
  readonly state: JsonValue;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface SaveGenerationEngineCheckpointInput {
  /** Optional provider cursor used to reconnect a remote event stream. */
  readonly cursor?: string | null;
  /** Opaque JSON state. Credentials and secret values must never be included. */
  readonly state: JsonValue;
}

export interface GenerationEngineCheckpointChannel {
  load(): Promise<GenerationEngineCheckpointData | null>;
  save(input: SaveGenerationEngineCheckpointInput): Promise<GenerationEngineCheckpointData>;
  clear(): Promise<void>;
}

export interface GenerationEngineToolDescriptor {
  /** Stable engine-facing key in `source__tool` form. */
  readonly name: string;
  readonly source: string;
  readonly tool: string;
  readonly title?: string;
  readonly description: string;
  readonly inputSchema: Readonly<Record<string, JsonValue>>;
  readonly effect: ToolCallEffect;
  readonly permissions: readonly string[];
}

export interface InvokeGenerationEngineToolInput {
  readonly name: string;
  /** Provider-native call identity retained in the durable tool record. */
  readonly providerCallId: string;
  readonly arguments: Readonly<Record<string, JsonValue>>;
}

export interface GenerationEngineToolChannel {
  list(): Promise<readonly GenerationEngineToolDescriptor[]>;
  invoke(input: InvokeGenerationEngineToolInput): Promise<JsonValue>;
}

export interface GenerationSteeringChannel {
  consume(): Promise<readonly GenerationSteeringUpdate[]>;
}

/** A consumed steering record plus private attachment bytes for the active engine only. */
export interface GenerationSteeringUpdate extends GenerationSteeringData {
  readonly attachments: readonly AttachmentContent[];
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
    const steeredInput = await applyQueuedSteering(input, options);
    if (steeredInput.operation === "inspect") {
      return this.#inspect(steeredInput, options);
    }
    if (options.onDelta) return this.#generateStreaming(steeredInput, options);

    const startedAt = Date.now();
    const result = await generateText({
      model: this.#model,
      system: createSystemPrompt(
        steeredInput.framework,
        steeredInput.skills,
        steeredInput.instructions ?? null,
      ),
      ...createMultimodalPrompt(createGenerationPrompt(steeredInput), steeredInput.attachments),
      output: Output.object({
        name: "viby_generation",
        description: "A complete source project, immutable source changes, or a typed blocking task.",
        schema: generatedResponseSchema,
      }),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    await recordAiSdkProviderRequest(options, this.#model, result, startedAt);

    return withGeneratedArtifacts(
      normalizeOutput(
        result.output,
        result.usage,
        result.finishReason,
        steeredInput.previousFiles,
      ),
      generatedFileOutputs(result.files),
    );
  }

  async #inspect(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions,
  ): Promise<GeneratorMessageOutput> {
    const startedAt = Date.now();
    const result = await generateText({
      model: this.#model,
      system: createInspectionSystemPrompt(
        input.framework,
        input.skills,
        input.instructions ?? null,
      ),
      ...createMultimodalPrompt(createGenerationPrompt(input), input.attachments),
      output: Output.object({
        name: "viby_inspection",
        description: "A read-only answer grounded in the immutable source version.",
        schema: inspectionResponseSchema,
      }),
      ...(options.signal ? { abortSignal: options.signal } : {}),
    });
    await recordAiSdkProviderRequest(options, this.#model, result, startedAt);
    if (options.onDelta) await options.onDelta(result.output.response);
    return {
      kind: "message",
      content: result.output.response,
      usage: result.usage,
      finishReason: result.finishReason,
      artifacts: generatedFileOutputs(result.files),
    };
  }

  async #generateStreaming(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions,
  ): Promise<GeneratorOutput> {
    const startedAt = Date.now();
    const result = streamText({
      model: this.#model,
      system: createSystemPrompt(input.framework, input.skills, input.instructions ?? null),
      ...createMultimodalPrompt(createGenerationPrompt(input), input.attachments),
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

    await recordAiSdkProviderRequest(options, this.#model, {
      response: await result.response,
      usage: await result.usage,
      providerMetadata: await result.providerMetadata,
    }, startedAt);

    return withGeneratedArtifacts(
      normalizeOutput(
        await result.output,
        await result.usage,
        await result.finishReason,
        input.previousFiles,
      ),
      generatedFileOutputs(await result.files),
    );
  }
}

interface AiSdkProviderResult {
  readonly response?: {
    readonly id?: string;
    readonly modelId?: string;
  };
  readonly usage: LanguageModelUsage;
  readonly providerMetadata?: unknown;
}

async function recordAiSdkProviderRequest(
  options: GeneratorOptions,
  model: LanguageModel,
  result: AiSdkProviderResult,
  startedAt: number,
): Promise<void> {
  if (!options.attribution) return;
  const providerRequestId = result.response?.id?.trim() || null;
  const configuredModel = typeof model === "string"
    ? null
    : { provider: model.provider, modelId: model.modelId };
  const modelId = result.response?.modelId?.trim() || configuredModel?.modelId;
  await options.attribution.record({
    idempotencyKey: providerRequestId
      ? `ai-sdk:${providerRequestId}`
      : `ai-sdk:${options.run?.attemptId ?? "direct"}:0`,
    providerRequestId,
    ...(configuredModel ? { modelProvider: configuredModel.provider } : {}),
    ...(modelId ? { modelId } : {}),
    outcome: "succeeded",
    inputTokens: result.usage.inputTokens ?? null,
    outputTokens: result.usage.outputTokens ?? null,
    totalTokens: result.usage.totalTokens ?? null,
    cacheReadTokens: result.usage.inputTokenDetails?.cacheReadTokens ?? null,
    cacheWriteTokens: result.usage.inputTokenDetails?.cacheWriteTokens ?? null,
    latencyMs: Math.max(0, Date.now() - startedAt),
    modelMetadata: credentialFreeModelMetadata(result.providerMetadata),
  });
}

function credentialFreeModelMetadata(value: unknown): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const encoded = JSON.stringify(value, (key, entry) => {
    if (/token|secret|authorization|api[-_]?key|credential/i.test(key)) return undefined;
    if (typeof entry === "bigint") return entry.toString();
    return entry;
  });
  if (!encoded || encoded.length > 32_000) return {};
  try {
    const parsed = JSON.parse(encoded) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Readonly<Record<string, JsonValue>>
      : {};
  } catch {
    return {};
  }
}

async function applyQueuedSteering<Framework extends FrameworkId>(
  input: GeneratorInput<Framework>,
  options: GeneratorOptions,
): Promise<GeneratorInput<Framework>> {
  const steering = await options.steering?.consume() ?? [];
  if (steering.length === 0) return input;
  return {
    ...input,
    prompt: [
      input.prompt,
      ...steering.map((entry) => `Steering update for the current run:\n${entry.prompt}`),
    ].join("\n\n"),
    attachments: [
      ...(input.attachments ?? []),
      ...steering.flatMap((entry) => entry.attachments),
    ],
  };
}

export function generatedFileOutputs(
  files: readonly GeneratedFile[],
): readonly GeneratorArtifactOutput[] {
  return files.map((file, index) => {
    const kind = artifactKindForMediaType(file.mediaType);
    return {
      kind,
      filename: `generated-${index + 1}.${extensionForMediaType(file.mediaType)}`,
      mediaType: file.mediaType,
      bytes: Uint8Array.from(file.uint8Array),
    };
  });
}

function withGeneratedArtifacts(
  output: GeneratorOutput,
  artifacts: readonly GeneratorArtifactOutput[],
): GeneratorOutput {
  return artifacts.length === 0 ? output : { ...output, artifacts };
}

function artifactKindForMediaType(mediaType: string): GeneratedArtifactKind {
  if (mediaType.startsWith("image/")) return "image";
  if (mediaType.startsWith("audio/")) return "audio";
  if (mediaType.startsWith("video/")) return "video";
  if (
    mediaType.startsWith("text/")
    || mediaType === "application/pdf"
    || mediaType.includes("document")
    || mediaType.includes("json")
  ) return "document";
  return "binary";
}

function extensionForMediaType(mediaType: string): string {
  return ({
    "image/jpeg": "jpg",
    "image/png": "png",
    "image/webp": "webp",
    "image/gif": "gif",
    "image/svg+xml": "svg",
    "audio/mpeg": "mp3",
    "audio/wav": "wav",
    "video/mp4": "mp4",
    "application/pdf": "pdf",
    "application/json": "json",
    "text/plain": "txt",
  } as Record<string, string>)[mediaType] ?? "bin";
}

function createSystemPrompt(
  framework: FrameworkId,
  skills: readonly ResolvedSkill[],
  instructions: string | null,
): string {
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
    instructions ? `\nGeneration-specific host instructions:\n${instructions}` : "",
  ].join("\n");
}

function createInspectionSystemPrompt(
  framework: FrameworkId,
  skills: readonly ResolvedSkill[],
  instructions: string | null,
): string {
  const skillContext = skills.length === 0
    ? "No additional skills were selected for this inspection."
    : skills.map(renderSkill).join("\n\n");
  return [
    "You are Viby performing a strictly read-only source inspection.",
    `The immutable project uses ${framework}.`,
    "Answer only from the supplied project source, conversation, and attachments.",
    "Do not propose or emit source edits as an executed result. Never claim that files were changed.",
    "Be precise, cite relevant project paths, and clearly distinguish evidence from inference.",
    "\nResolved skills:\n",
    skillContext,
    instructions ? `\nInspection-specific host instructions:\n${instructions}` : "",
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
    input.attachments?.length
      ? `${input.attachments.length} immutable attachment(s) are supplied as multimodal file parts with this request.`
      : "There are no attachments for this request.",
    `Current request:\n${input.prompt}`,
    input.previousFiles.length > 0
      ? "Produce the smallest complete set of typed source changes that satisfies the request while preserving relevant existing behavior."
      : "Produce a complete source tree that satisfies the request.",
  ].join("\n\n");
}

export function createMultimodalPrompt(
  prompt: string,
  attachments: readonly AttachmentContent[] | undefined,
) {
  if (!attachments || attachments.length === 0) return { prompt };
  return {
    messages: [{
      role: "user" as const,
      content: [
        { type: "text" as const, text: prompt },
        ...attachments.map((attachment) => ({
          type: "file" as const,
          data: attachment.bytes,
          filename: attachment.filename,
          mediaType: attachment.mediaType,
        })),
      ],
    }],
  };
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
    const block = `<project-file path="${file.path}" locked="${file.locked}">\n${file.content}\n</project-file>`;
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
      locked: false,
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
