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
  GenerationQualityCommand,
  GenerationQualityConfig,
  UserScope,
} from "./types.js";
import { createId, normalizeProjectPath } from "./utils.js";

const DEFAULT_COMMAND_TIMEOUT_MS = 300_000;
const MAX_COMMAND_TIMEOUT_MS = 900_000;
const MAX_COMMANDS = 30;

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
  readonly timeoutMs: number;
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
  const prepare = (value.prepare ?? []).map((command) => normalizeCommand(command, "prepare"));
  const checks = value.checks.map((command) => normalizeCommand(command, "check"));
  if (prepare.length + checks.length > MAX_COMMANDS) {
    throw new ConfigurationError(`generation.quality cannot contain more than ${MAX_COMMANDS} commands.`);
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
    timeoutMs: Math.min(
      3_600_000,
      [...prepare, ...checks].reduce((total, command) => total + command.timeoutMs, 0),
    ),
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
}): Promise<void> {
  const capabilities = sandboxCapabilities(input.adapter.capabilities);
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
  let session: SandboxSession | null = null;
  try {
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
    await session.writeFiles(input.files, { signal: input.signal });
    for (const [phase, commands] of [
      ["prepare", input.config.prepare],
      ["check", input.config.checks],
    ] as const) {
      for (const command of commands) {
        await input.onEvent({
          type: "quality.started",
          data: {
            checkId: command.id,
            phase,
          },
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
          await input.onEvent({
            type: "quality.completed",
            data: {
              checkId: command.id,
              phase,
              status: result.exitCode === 0 ? "passed" : "failed",
              exitCode: result.exitCode,
              durationMs: result.durationMs,
            },
          });
          if (result.exitCode !== 0) {
            throw new GenerationQualityError(command.id, result.exitCode);
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
              },
            });
            throw new GenerationQualityError(command.id, null, { cause: error });
          }
          throw error;
        }
      }
    }
  } finally {
    await session?.stop().catch(() => undefined);
  }
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
