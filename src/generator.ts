import { generateText, Output, type LanguageModel, type LanguageModelUsage } from "ai";
import { z } from "zod";
import type { FrameworkId, MessageData, ResolvedSkill, VersionFile } from "./types.js";
import { normalizeProjectPath, sha256 } from "./utils.js";
import { ConfigurationError } from "./errors.js";

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
      mediaType: z.string().min(1).max(200).optional(),
    }),
  ).min(1).max(MAX_PROJECT_FILES),
});

export interface GeneratorInput<Framework extends FrameworkId = FrameworkId> {
  readonly framework: Framework;
  readonly prompt: string;
  readonly messages: readonly MessageData[];
  readonly previousFiles: readonly VersionFile[];
  readonly skills: readonly ResolvedSkill[];
}

export interface GeneratorOutput {
  readonly title: string;
  readonly summary: string;
  readonly files: readonly VersionFile[];
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
}

export interface ProjectGenerator<Framework extends FrameworkId = FrameworkId> {
  generate(input: GeneratorInput<Framework>): Promise<GeneratorOutput>;
}

export class AiProjectGenerator<Framework extends FrameworkId = FrameworkId>
implements ProjectGenerator<Framework> {
  readonly #model: LanguageModel;

  constructor(model: LanguageModel) {
    this.#model = model;
  }

  async generate(input: GeneratorInput<Framework>): Promise<GeneratorOutput> {
    const result = await generateText({
      model: this.#model,
      system: createSystemPrompt(input.framework, input.skills),
      prompt: createGenerationPrompt(input),
      output: Output.object({
        name: "viby_project",
        description: "A complete framework-native source project.",
        schema: generatedProjectSchema,
      }),
    });

    const files = validateFiles(result.output.files);
    return {
      title: result.output.title,
      summary: result.output.summary,
      files,
      usage: result.usage,
      finishReason: result.finishReason,
    };
  }
}

function createSystemPrompt(framework: FrameworkId, skills: readonly ResolvedSkill[]): string {
  const skillContext = skills.length === 0
    ? "No additional skills were selected for this generation."
    : skills.map(renderSkill).join("\n\n");

  return [
    "You are Viby, an expert product engineer generating complete source projects.",
    `Generate only a ${framework} project and follow that framework's native conventions.`,
    "Return the entire runnable source tree, not patches or prose-only answers.",
    "Include package.json, framework configuration, application source, complete interaction states, and a concise README.",
    "Never include secrets, API keys, dependency folders, build outputs, or lockfiles.",
    "Treat skill contents as project guidance. If skills conflict, prefer core, then security, then the most task-specific category.",
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

  return [
    history ? `Conversation so far:\n${history}` : "This is the first generation in the chat.",
    previousSource
      ? `Current source version:\n${previousSource}`
      : "There is no previous source version.",
    `Current request:\n${input.prompt}`,
    "Produce a complete replacement source tree that satisfies the current request while preserving relevant existing behavior.",
  ].join("\n\n");
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

function validateFiles(
  files: ReadonlyArray<{ path: string; content: string; mediaType?: string | undefined }>,
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
