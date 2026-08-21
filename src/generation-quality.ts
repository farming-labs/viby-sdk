import { ConfigurationError, GenerationQualityError } from "./errors.js";
import {
  SandboxSession,
  sandboxCapabilities,
  type SandboxAdapter,
  type SandboxCommandPolicy,
  type SandboxFile,
} from "./sandbox.js";
import type {
  FrameworkId,
  GenerationQualityFailure,
  GenerationQualityCommand,
  GenerationQualityConfig,
  UserScope,
} from "./types.js";
import { createId, normalizeProjectPath } from "./utils.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_TIMEOUT_MS = 900_000;
const MAX_COMMANDS = 30;
const MAX_FAILURE_DETAIL_LENGTH = 8_000;

export interface NormalizedGenerationQualityCommand {
  readonly id: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

export interface NormalizedGenerationQualityConfig {
  readonly prepare: readonly NormalizedGenerationQualityCommand[];
  readonly checks: readonly NormalizedGenerationQualityCommand[];
  readonly checkConcurrency: number;
  readonly captureSourceChanges: boolean;
  readonly repairAttempts: number;
  readonly timeoutMs: number;
  readonly formatFailure?: GenerationQualityConfig["formatFailure"];
}

export interface GenerationQualityResult {
  /** Candidate files after any explicitly enabled sandbox source capture. */
  readonly files: readonly SandboxFile[];
}

export type GenerationQualityEvent =
  | {
      readonly type: "quality.started";
      readonly data: {
        readonly checkId: string;
        readonly phase: "prepare" | "check";
      };
    }
  | {
      readonly type: "quality.completed";
      readonly data: {
        readonly checkId: string;
        readonly phase: "prepare" | "check";
        readonly status: "passed" | "failed";
        readonly exitCode: number | null;
        readonly durationMs: number | null;
        readonly detail: string | null;
      };
    };

export function normalizeGenerationQuality(
  value: GenerationQualityConfig | undefined,
): NormalizedGenerationQualityConfig | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("generation.quality must be an object.");
  }
  if (!Array.isArray(value.checks) || value.checks.length === 0) {
    throw new ConfigurationError("generation.quality.checks must contain at least one command.");
  }
  if (value.prepare !== undefined && !Array.isArray(value.prepare)) {
    throw new ConfigurationError("generation.quality.prepare must be an array.");
  }
  if (value.captureSourceChanges !== undefined && typeof value.captureSourceChanges !== "boolean") {
    throw new ConfigurationError("generation.quality.captureSourceChanges must be a boolean.");
  }
  const repairAttempts = value.repairAttempts ?? 0;
  if (!Number.isInteger(repairAttempts) || repairAttempts < 0 || repairAttempts > 3) {
    throw new ConfigurationError(
      "generation.quality.repairAttempts must be an integer between 0 and 3.",
    );
  }
  const checkConcurrency = value.checkConcurrency ?? 1;
  if (!Number.isInteger(checkConcurrency) || checkConcurrency < 1 || checkConcurrency > 8) {
    throw new ConfigurationError(
      "generation.quality.checkConcurrency must be an integer between 1 and 8.",
    );
  }
  const prepare = (value.prepare ?? []).map((command) => normalizeCommand(command, "prepare"));
  const checks = value.checks.map((command) => normalizeCommand(command, "check"));
  if (prepare.length + checks.length > MAX_COMMANDS) {
    throw new ConfigurationError(
      `generation.quality cannot contain more than ${MAX_COMMANDS} commands.`,
    );
  }
  const ids = new Set<string>();
  for (const command of [...prepare, ...checks]) {
    if (ids.has(command.id)) {
      throw new ConfigurationError(`Generation quality command id is duplicated: ${command.id}`);
    }
    ids.add(command.id);
  }
  return Object.freeze({
    prepare: Object.freeze(prepare),
    checks: Object.freeze(checks),
    checkConcurrency,
    captureSourceChanges: value.captureSourceChanges ?? false,
    repairAttempts,
    timeoutMs: Math.min(
      3_600_000,
      [...prepare, ...checks].reduce((total, command) => total + command.timeoutMs, 0),
    ),
    ...(value.formatFailure ? { formatFailure: value.formatFailure } : {}),
  });
}

export async function verifyGenerationQuality<Framework extends FrameworkId>(input: {
  readonly config: NormalizedGenerationQualityConfig;
  readonly adapter: SandboxAdapter;
  readonly policy?: SandboxCommandPolicy;
  readonly scope: UserScope;
  readonly chatId: string;
  readonly framework: Framework;
  readonly files: readonly SandboxFile[];
  readonly signal: AbortSignal;
  readonly onEvent: (event: GenerationQualityEvent) => void | Promise<void>;
  /** Reuse an already materialized generation workspace instead of creating another sandbox. */
  readonly session?: SandboxSession;
}): Promise<GenerationQualityResult> {
  const capabilities =
    input.session?.capabilities ?? sandboxCapabilities(input.adapter.capabilities);
  if (!capabilities.files || !capabilities.commands) {
    throw new ConfigurationError(
      "Generation quality requires a sandbox adapter with files and commands capabilities.",
    );
  }
  const context = {
    ...input.scope,
    chatId: input.chatId,
    versionId: createId(),
    framework: input.framework,
  };
  let session: SandboxSession | null = input.session ?? null;
  const ownsSession = !input.session;
  try {
    if (!session) {
      let instance;
      try {
        instance = await input.adapter.create({
          context,
          timeoutMs: input.config.timeoutMs,
          env: {},
          ports: [],
          signal: input.signal,
        });
      } catch (error) {
        throw new GenerationQualityError("sandbox", null, { cause: error });
      }
      session = new SandboxSession(
        input.adapter.provider,
        capabilities,
        instance,
        () => {},
        null,
        input.policy ? { policy: input.policy, context } : null,
      );
    }
    await session.writeFiles(input.files, { signal: input.signal });
    for (const command of input.config.prepare) {
      await runQualityCommand(session, command, "prepare", input);
    }
    const failures = await mapConcurrent(
      input.config.checks,
      input.config.checkConcurrency,
      async (command) => {
        try {
          await runQualityCommand(session!, command, "check", input);
          return null;
        } catch (error) {
          return error;
        }
      },
    );
    const failure = failures.find((error) => error !== null);
    if (failure) throw failure;
    if (!input.config.captureSourceChanges) {
      return { files: input.files.map((file) => ({ ...file })) };
    }
    try {
      const decoder = new TextDecoder("utf-8", { fatal: true });
      return {
        files: await Promise.all(
          input.files.map(async (file) =>
            typeof file.content === "string"
              ? {
                  path: file.path,
                  content: decoder.decode(
                    await session!.readFile(file.path, {
                      signal: input.signal,
                    }),
                  ),
                }
              : { ...file },
          ),
        ),
      };
    } catch (error) {
      throw new GenerationQualityError("capture-source", null, { cause: error });
    }
  } finally {
    if (ownsSession) await session?.stop().catch(() => undefined);
  }
}

async function runQualityCommand<Framework extends FrameworkId>(
  session: SandboxSession,
  command: NormalizedGenerationQualityCommand,
  phase: "prepare" | "check",
  input: {
    readonly config: NormalizedGenerationQualityConfig;
    readonly signal: AbortSignal;
    readonly onEvent: (event: GenerationQualityEvent) => void | Promise<void>;
  },
): Promise<void> {
  await input.onEvent({
    type: "quality.started",
    data: { checkId: command.id, phase },
  });
  try {
    const result = await session.run({
      command: command.command,
      args: command.args,
      cwd: command.cwd,
      env: command.env,
      timeoutMs: command.timeoutMs,
      signal: input.signal,
    });
    const detail =
      result.exitCode === 0 || !input.config.formatFailure
        ? null
        : normalizeFailureDetail(
            await input.config.formatFailure({
              checkId: command.id,
              phase,
              exitCode: result.exitCode,
              durationMs: result.durationMs,
              stdout: result.stdout,
              stderr: result.stderr,
            } satisfies GenerationQualityFailure),
          );
    await input.onEvent({
      type: "quality.completed",
      data: {
        checkId: command.id,
        phase,
        status: result.exitCode === 0 ? "passed" : "failed",
        exitCode: result.exitCode,
        durationMs: result.durationMs,
        detail,
      },
    });
    if (result.exitCode !== 0) {
      throw new GenerationQualityError(command.id, result.exitCode, { detail });
    }
  } catch (error) {
    if (!(error instanceof GenerationQualityError)) {
      await input.onEvent({
        type: "quality.completed",
        data: {
          checkId: command.id,
          phase,
          status: "failed",
          exitCode: null,
          durationMs: null,
          detail: null,
        },
      });
      throw new GenerationQualityError(command.id, null, { cause: error });
    }
    throw error;
  }
}

async function mapConcurrent<Input, Output>(
  values: readonly Input[],
  concurrency: number,
  operation: (value: Input) => Promise<Output>,
): Promise<Output[]> {
  const results = new Array<Output>(values.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, async () => {
      while (next < values.length) {
        const index = next++;
        results[index] = await operation(values[index]!);
      }
    }),
  );
  return results;
}

function normalizeFailureDetail(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .trim();
  if (!normalized) return null;
  return normalized.length <= MAX_FAILURE_DETAIL_LENGTH
    ? normalized
    : `${normalized.slice(0, MAX_FAILURE_DETAIL_LENGTH)}\n[diagnostics truncated]`;
}

function normalizeCommand(
  value: GenerationQualityCommand,
  phase: "prepare" | "check",
): NormalizedGenerationQualityCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`Generation quality ${phase} command must be an object.`);
  }
  const id = value.id?.trim();
  if (!id || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new ConfigurationError(`Generation quality ${phase} command id is invalid.`);
  }
  const command = value.command?.trim();
  if (!command || command.length > 500 || /[\u0000-\u001f\u007f]/.test(command)) {
    throw new ConfigurationError(`Generation quality command ${id} is invalid.`);
  }
  if (value.args !== undefined && !Array.isArray(value.args)) {
    throw new ConfigurationError(`Generation quality command ${id} args must be an array.`);
  }
  const args = (value.args ?? []).map((argument) => {
    if (typeof argument !== "string" || argument.length > 10_000 || argument.includes("\u0000")) {
      throw new ConfigurationError(`Generation quality command ${id} has an invalid argument.`);
    }
    return argument;
  });
  const timeoutMs = value.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > MAX_COMMAND_TIMEOUT_MS) {
    throw new ConfigurationError(
      `Generation quality command ${id} timeoutMs must be between 100 and ${MAX_COMMAND_TIMEOUT_MS}.`,
    );
  }
  const cwd = value.cwd?.trim() || ".";
  return Object.freeze({
    id,
    command,
    args: Object.freeze(args),
    cwd: cwd === "." ? cwd : normalizeProjectPath(cwd),
    env: Object.freeze({ ...(value.env ?? {}) }),
    timeoutMs,
  });
}
