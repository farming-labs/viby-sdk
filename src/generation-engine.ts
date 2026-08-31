import { ConfigurationError } from "./errors.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "./generator.js";
import type { FrameworkId, GenerationOperation, JsonValue } from "./types.js";

export type GenerationEngineInput<Framework extends FrameworkId = FrameworkId> =
  GeneratorInput<Framework>;
export type GenerationEngineContext = GeneratorOptions;
export type GenerationEngineOutput = GeneratorOutput;

export interface GenerationEngineIdentity {
  /** Stable runtime or provider name used for durable attribution and worker routing. */
  readonly provider: string;
  /** Stable model, agent, or orchestration identifier used for durable attribution. */
  readonly model: string;
}

/**
 * Optional behavior an engine can expose beyond producing immutable source.
 *
 * Viby capability-gates optional operations instead of assuming every remote
 * harness supports inspection, live steering, durable traces, or artifacts.
 */
export interface GenerationEngineCapabilities {
  /** Operations accepted by the engine. `change` is the compatibility default. */
  readonly operations: readonly GenerationOperation[];
  /** Emits incremental assistant text through `context.onDelta`. */
  readonly streaming: boolean;
  /** Consumes durable steering updates at engine-defined safe boundaries. */
  readonly steering: boolean;
  /** Emits typed reasoning, command, search, and file events through `context.trace`. */
  readonly traces: boolean;
  /** Persists provider-neutral tool calls through `context.toolCalls`. */
  readonly toolCalls: boolean;
  /** May return generated binary artifacts in its final output. */
  readonly artifacts: boolean;
}

export type GenerationEngineCapabilitiesInput = Partial<GenerationEngineCapabilities>;

const DEFAULT_GENERATION_ENGINE_CAPABILITIES: GenerationEngineCapabilities = Object.freeze({
  operations: Object.freeze(["change"] as const),
  streaming: false,
  steering: false,
  traces: false,
  toolCalls: false,
  artifacts: false,
});

/**
 * Provider-neutral execution boundary for one Viby generation attempt.
 *
 * Engines may call a model directly, run a multi-step agent, delegate to a
 * remote runtime, or coordinate their own orchestration system. Viby retains
 * ownership of durable attempts, events, tasks, source versions, and usage.
 */
export interface GenerationEngine<Framework extends FrameworkId = FrameworkId>
extends ProjectGenerator<Framework> {
  readonly identity: GenerationEngineIdentity;
  readonly capabilities?: GenerationEngineCapabilitiesInput;
  /** Releases an optional remote client, session pool, or orchestration runtime. */
  close?(): Promise<void>;
}

export interface DefineGenerationEngineInput<Framework extends FrameworkId = FrameworkId> {
  readonly identity: GenerationEngineIdentity;
  readonly capabilities?: GenerationEngineCapabilitiesInput;
  generate(
    input: GeneratorInput<Framework>,
    options?: GeneratorOptions,
  ): Promise<GeneratorOutput>;
  close?(): Promise<void>;
}

/** Opaque provider-owned identity for one idempotently started remote run. */
export interface RemoteGenerationEngineRun {
  /** Stable external identity returned for the same Viby attempt ID. */
  readonly id: string;
  /** Credential-free provider metadata safe to retain in a host process. */
  readonly metadata?: Readonly<Record<string, JsonValue>>;
}

export interface RemoteGenerationEngineEventBase {
  /** Opaque resumable provider cursor. Cursors must be non-empty and unique within a run. */
  readonly cursor: string;
}

export type RemoteGenerationEngineEvent =
  | (RemoteGenerationEngineEventBase & {
      readonly type: "output.delta";
      readonly delta: string;
    })
  | (RemoteGenerationEngineEventBase & {
      readonly type: "completed";
      readonly output: GeneratorOutput;
    })
  | (RemoteGenerationEngineEventBase & {
      readonly type: "failed";
      readonly error: string;
      readonly retryable?: boolean;
    });

export interface RemoteGenerationEngineEventInput {
  /** Resume strictly after this provider cursor. `null` starts from the beginning. */
  readonly after: string | null;
  readonly signal?: AbortSignal;
}

/**
 * Remote harness boundary adapted to the ordinary GenerationEngine contract.
 *
 * `start` must be idempotent for `context.run.attemptId`. A reclaimed worker may
 * call it again for the same attempt and must receive the same external run.
 */
export interface DefineRemoteGenerationEngineInput<Framework extends FrameworkId = FrameworkId> {
  readonly identity: GenerationEngineIdentity;
  readonly capabilities?: GenerationEngineCapabilitiesInput;
  start(
    input: GeneratorInput<Framework>,
    context: GeneratorOptions,
  ): Promise<RemoteGenerationEngineRun>;
  events(
    run: RemoteGenerationEngineRun,
    input: RemoteGenerationEngineEventInput,
  ): AsyncIterable<RemoteGenerationEngineEvent>;
  cancel?(run: RemoteGenerationEngineRun, context: GeneratorOptions): Promise<void>;
  close?(): Promise<void>;
}

/** Defines and validates a custom generation engine without coupling it to an AI SDK model. */
export function defineGenerationEngine<Framework extends FrameworkId = FrameworkId>(
  input: DefineGenerationEngineInput<Framework>,
): GenerationEngine<Framework> {
  const identity = normalizeGenerationEngineIdentity(input?.identity);
  const capabilities = normalizeGenerationEngineCapabilities(input?.capabilities);
  if (typeof input?.generate !== "function") {
    throw new ConfigurationError("A generation engine must implement generate(input, options).");
  }
  return Object.freeze({
    identity,
    capabilities,
    generate: input.generate.bind(input),
    ...(typeof input.close === "function" ? { close: input.close.bind(input) } : {}),
  });
}

/** Adapts an asynchronous remote run into Viby's validated generation result boundary. */
export function defineRemoteGenerationEngine<Framework extends FrameworkId = FrameworkId>(
  input: DefineRemoteGenerationEngineInput<Framework>,
): GenerationEngine<Framework> {
  if (typeof input?.start !== "function" || typeof input?.events !== "function") {
    throw new ConfigurationError("A remote generation engine must implement start and events.");
  }
  if (input.cancel !== undefined && typeof input.cancel !== "function") {
    throw new ConfigurationError("A remote generation engine cancel hook must be a function.");
  }
  return defineGenerationEngine({
    identity: input.identity,
    capabilities: {
      ...input.capabilities,
      streaming: input.capabilities?.streaming ?? true,
    },
    async generate(generationInput, context = {}) {
      context.signal?.throwIfAborted();
      const run = normalizeRemoteRun(await input.start(generationInput, context));
      let cursor: string | null = null;
      const cursors = new Set<string>();
      try {
        for await (const event of input.events(run, {
          after: cursor,
          ...(context.signal ? { signal: context.signal } : {}),
        })) {
          context.signal?.throwIfAborted();
          const normalizedCursor = normalizeRemoteCursor(event?.cursor);
          if (cursors.has(normalizedCursor)) {
            throw new RemoteGenerationEngineError(
              run.id,
              `Remote generation engine repeated cursor ${normalizedCursor}.`,
              false,
            );
          }
          cursors.add(normalizedCursor);
          cursor = normalizedCursor;
          if (event.type === "output.delta") {
            if (typeof event.delta !== "string") {
              throw new RemoteGenerationEngineError(
                run.id,
                "Remote generation output deltas must be strings.",
                false,
              );
            }
            await context.onDelta?.(event.delta);
            continue;
          }
          if (event.type === "failed") {
            throw new RemoteGenerationEngineError(
              run.id,
              normalizeRemoteError(event.error),
              event.retryable ?? false,
            );
          }
          if (event.type === "completed") return event.output;
          throw new RemoteGenerationEngineError(
            run.id,
            "Remote generation engine emitted an unknown event.",
            false,
          );
        }
        throw new RemoteGenerationEngineError(
          run.id,
          "Remote generation engine ended without a completed or failed event.",
          true,
        );
      } catch (error) {
        if (context.signal?.aborted && input.cancel) {
          await input.cancel(run, context).catch(() => undefined);
        }
        throw error;
      }
    },
    ...(typeof input.close === "function" ? { close: input.close } : {}),
  });
}

export class RemoteGenerationEngineError extends Error {
  override readonly name = "RemoteGenerationEngineError";

  constructor(
    readonly runId: string,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

export function normalizeGenerationEngineCapabilities(
  capabilities: GenerationEngineCapabilitiesInput | undefined,
): GenerationEngineCapabilities {
  if (capabilities !== undefined && (!capabilities || typeof capabilities !== "object")) {
    throw new ConfigurationError("Generation engine capabilities must be an object.");
  }
  const operations = capabilities?.operations ?? DEFAULT_GENERATION_ENGINE_CAPABILITIES.operations;
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new ConfigurationError("Generation engine capabilities.operations cannot be empty.");
  }
  const normalizedOperations = [...new Set(operations)];
  if (normalizedOperations.some((operation) => operation !== "change" && operation !== "inspect")) {
    throw new ConfigurationError(
      "Generation engine capabilities.operations may contain only change or inspect.",
    );
  }
  return Object.freeze({
    operations: Object.freeze(normalizedOperations),
    streaming: booleanCapability(capabilities?.streaming, "streaming"),
    steering: booleanCapability(capabilities?.steering, "steering"),
    traces: booleanCapability(capabilities?.traces, "traces"),
    toolCalls: booleanCapability(capabilities?.toolCalls, "toolCalls"),
    artifacts: booleanCapability(capabilities?.artifacts, "artifacts"),
  });
}

export function normalizeGenerationEngineIdentity(
  identity: GenerationEngineIdentity | undefined,
): GenerationEngineIdentity {
  if (!identity || typeof identity !== "object") {
    throw new ConfigurationError("A generation engine identity is required.");
  }
  return Object.freeze({
    provider: normalizeIdentityPart(identity.provider, "provider"),
    model: normalizeIdentityPart(identity.model, "model"),
  });
}

function normalizeIdentityPart(value: string, label: string): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`Generation engine ${label} must be a string.`);
  }
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 200) {
    throw new ConfigurationError(
      `Generation engine ${label} must contain between 1 and 200 characters.`,
    );
  }
  return normalized;
}

function booleanCapability(value: boolean | undefined, name: string): boolean {
  if (value !== undefined && typeof value !== "boolean") {
    throw new ConfigurationError(`Generation engine capability ${name} must be a boolean.`);
  }
  return value ?? false;
}

function normalizeRemoteRun(run: RemoteGenerationEngineRun): RemoteGenerationEngineRun {
  if (!run || typeof run !== "object") {
    throw new ConfigurationError("A remote generation engine must return a run handle.");
  }
  const id = normalizeIdentityPart(run.id, "remote run id");
  if (run.metadata !== undefined && (!run.metadata || typeof run.metadata !== "object")) {
    throw new ConfigurationError("Remote generation engine metadata must be an object.");
  }
  return Object.freeze({ id, ...(run.metadata === undefined ? {} : { metadata: run.metadata }) });
}

function normalizeRemoteCursor(cursor: string): string {
  if (typeof cursor !== "string" || cursor.trim().length === 0 || cursor.length > 2_000) {
    throw new ConfigurationError(
      "Remote generation engine cursors must contain between 1 and 2000 characters.",
    );
  }
  return cursor;
}

function normalizeRemoteError(error: string): string {
  if (typeof error !== "string" || error.trim().length === 0) {
    return "Remote generation engine failed without an error message.";
  }
  return error.trim().slice(0, 8_000);
}
