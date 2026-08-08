import {
  isStepCount,
  Output,
  tool,
  ToolLoopAgent,
  type LanguageModel,
  type LanguageModelUsage,
} from "ai";
import { z } from "zod";
import { AgentWorkspace } from "./agent-workspace.js";
import {
  ConfigurationError,
  SandboxCommandApprovalRequiredError,
} from "./errors.js";
import type {
  AgentTracePart,
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "./generator.js";
import type {
  AgentRunnerConfig,
  FrameworkId,
  JsonValue,
  MessagePartDataMap,
  MessagePartType,
  SourceChange,
  PermissionTaskRequest,
} from "./types.js";
import { errorMessage } from "./utils.js";

const DEFAULT_MAX_STEPS = 20;
const DEFAULT_MAX_DURATION_MS = 300_000;
const DEFAULT_MAX_TOKENS = 200_000;
const DEFAULT_MAX_COMMANDS = 20;
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_COMMAND_OUTPUT_BYTES = 200_000;

export interface NormalizedAgentRunnerConfig {
  readonly maxSteps: number;
  readonly maxDurationMs: number;
  readonly maxTokens: number;
  readonly maxCommands: number;
  readonly commandTimeoutMs: number;
  readonly maxCommandOutputBytes: number;
  readonly sandboxPorts: readonly number[];
}

const agentResponseSchema = z.object({
  outcome: z.enum(["complete", "task"]),
  title: z.string().min(1).max(120).nullable(),
  summary: z.string().min(1).max(2_000).nullable(),
  task: z.object({
    kind: z.enum(["plan", "question", "permission"]),
    title: z.string().min(1).max(200),
    message: z.string().min(1).max(4_000),
    steps: z.array(z.string().min(1).max(1_000)).max(50),
    question: z.string().min(1).max(2_000).nullable(),
    choices: z.array(z.string().min(1).max(500)).max(20),
    allowFreeform: z.boolean(),
    action: z.string().min(1).max(1_000).nullable(),
    permissions: z.array(z.string().min(1).max(500)).max(50),
  }).nullable(),
});

export function normalizeAgentRunnerConfig(
  config: AgentRunnerConfig | undefined,
): NormalizedAgentRunnerConfig {
  if (config !== undefined && (!config || typeof config !== "object" || Array.isArray(config))) {
    throw new ConfigurationError("agent must be an object.");
  }
  return Object.freeze({
    maxSteps: integerLimit(config?.maxSteps, DEFAULT_MAX_STEPS, 1, 100, "agent.maxSteps"),
    maxDurationMs: integerLimit(
      config?.maxDurationMs,
      DEFAULT_MAX_DURATION_MS,
      1_000,
      3_600_000,
      "agent.maxDurationMs",
    ),
    maxTokens: integerLimit(config?.maxTokens, DEFAULT_MAX_TOKENS, 1_000, 10_000_000, "agent.maxTokens"),
    maxCommands: integerLimit(config?.maxCommands, DEFAULT_MAX_COMMANDS, 0, 1_000, "agent.maxCommands"),
    commandTimeoutMs: integerLimit(
      config?.commandTimeoutMs,
      DEFAULT_COMMAND_TIMEOUT_MS,
      100,
      900_000,
      "agent.commandTimeoutMs",
    ),
    maxCommandOutputBytes: integerLimit(
      config?.maxCommandOutputBytes,
      DEFAULT_MAX_COMMAND_OUTPUT_BYTES,
      1_000,
      10_000_000,
      "agent.maxCommandOutputBytes",
    ),
    sandboxPorts: normalizePorts(config?.sandboxPorts),
  });
}

export class AgentProjectGenerator<Framework extends FrameworkId = FrameworkId>
implements ProjectGenerator<Framework> {
  readonly #model: LanguageModel;
  readonly #config: NormalizedAgentRunnerConfig;

  constructor(model: LanguageModel, config: AgentRunnerConfig | undefined = undefined) {
    this.#model = model;
    this.#config = normalizeAgentRunnerConfig(config);
  }

  async generate(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions = {},
  ): Promise<GeneratorOutput> {
    const workspace = new AgentWorkspace(input.previousFiles, async () => undefined);
    const budget = new AgentExecutionBudget(this.#config);
    const approval = new AgentApprovalState();
    const tools = createAgentTools(workspace, input, options, budget, this.#config, approval);
    const agent = new ToolLoopAgent({
      model: this.#model,
      instructions: createAgentInstructions(input),
      tools,
      output: Output.object({
        name: "viby_agent_result",
        description: "The completed workspace result or a typed blocking task.",
        schema: agentResponseSchema,
      }),
      maxOutputTokens: Math.min(this.#config.maxTokens, 16_384),
      stopWhen: [
        isStepCount(this.#config.maxSteps),
        ({ steps }) => steps.reduce(
          (total, step) => total + (step.usage.totalTokens ?? 0),
          0,
        ) >= this.#config.maxTokens,
        () => approval.proposedAction !== null,
      ],
    });
    const result = await agent.generate({
      prompt: createAgentPrompt(input),
      ...(options.signal ? { abortSignal: options.signal } : {}),
      timeout: {
        totalMs: this.#config.maxDurationMs,
        toolMs: this.#config.commandTimeoutMs,
      },
    });
    if (approval.proposedAction) {
      return {
        kind: "task",
        task: approval.task(),
        usage: result.totalUsage,
        finishReason: result.finishReason,
      };
    }
    const output = result.output;
    if (output.outcome === "task") {
      if (!output.task || output.title || output.summary) {
        throw new ConfigurationError("The agent returned an inconsistent task outcome.");
      }
      if (workspace.changes().length > 0) {
        throw new ConfigurationError("The agent cannot pause after staging uncommitted workspace changes.");
      }
      return {
        kind: "task",
        task: normalizeAgentTask(output.task),
        usage: result.totalUsage,
        finishReason: result.finishReason,
      };
    }
    if (!output.title || !output.summary || output.task) {
      throw new ConfigurationError("The agent returned an inconsistent completion outcome.");
    }
    const changes = workspace.changes();
    if (changes.length === 0) {
      throw new ConfigurationError("The agent completed without changing the workspace.");
    }
    if (input.previousFiles.length === 0) {
      return {
        kind: "project",
        title: output.title,
        summary: output.summary,
        files: workspace.files(),
        usage: result.totalUsage,
        finishReason: result.finishReason,
      };
    }
    return {
      kind: "changes",
      title: output.title,
      summary: output.summary,
      changes,
      usage: result.totalUsage,
      finishReason: result.finishReason,
    };
  }
}

function createAgentTools<Framework extends FrameworkId>(
  workspace: AgentWorkspace,
  input: GeneratorInput<Framework>,
  options: GeneratorOptions,
  budget: AgentExecutionBudget,
  config: NormalizedAgentRunnerConfig,
  approval: AgentApprovalState,
) {
  const workspaceTools = {
    workspace_list_files: tool({
      description: "List source files in the mutable project workspace.",
      inputSchema: z.object({ prefix: z.string().max(500).nullable() }),
      execute: async ({ prefix }, { toolCallId }) => executeDurableTool(
        options,
        { toolCallId, name: "workspace.list-files", effect: "read", arguments: { prefix } },
        null,
        async () => (await workspace.tools.listFiles(prefix ? { prefix } : {}))
          .map((file) => ({ ...file })),
      ),
    }),
    workspace_read_file: tool({
      description: "Read one source file from the mutable project workspace.",
      inputSchema: z.object({ path: z.string().min(1).max(500) }),
      execute: async ({ path }, { toolCallId }) => executeDurableTool(
        options,
        { toolCallId, name: "workspace.read-file", effect: "read", arguments: { path } },
        { type: "file-read", complete: () => ({ path }) },
        async () => {
          const file = await workspace.tools.readFile({ path });
          return { ...file };
        },
      ),
    }),
    workspace_search: tool({
      description: "Search text in source files in the mutable project workspace.",
      inputSchema: z.object({
        query: z.string().min(1).max(500),
        prefix: z.string().max(500).nullable(),
        caseSensitive: z.boolean(),
        limit: z.number().int().min(1).max(200),
      }),
      execute: async ({ query, prefix, caseSensitive, limit }, { toolCallId }) => executeDurableTool(
        options,
        {
          toolCallId,
          name: "workspace.search",
          effect: "read",
          arguments: { query, prefix, caseSensitive, limit },
        },
        {
          type: "search",
          complete: (result) => ({
            query,
            path: prefix,
            matches: Array.isArray(result) ? result.length : null,
          }),
        },
        async () => (await workspace.tools.search({
          query,
          ...(prefix ? { prefix } : {}),
          caseSensitive,
          limit,
        })).map((result) => ({ ...result })),
      ),
    }),
    workspace_write_file: tool({
      description: "Create or replace a complete source file in the mutable project workspace.",
      inputSchema: z.object({
        path: z.string().min(1).max(500),
        content: z.string(),
        mediaType: z.string().max(200).nullable(),
      }),
      execute: async ({ path, content, mediaType }, { toolCallId }) => executeDurableTool(
        options,
        {
          toolCallId,
          name: "workspace.write-file",
          effect: "write",
          arguments: { path, content, mediaType },
        },
        { type: "file-edit", complete: () => ({ operation: "write", path }) },
        async () => {
          const change = await workspace.tools.writeFile({
            path,
            content,
            ...(mediaType ? { mediaType } : {}),
          });
          if (input.sandbox?.supports("files")) {
            await input.sandbox.writeFiles([{ path, content }], signalOptions(options.signal));
          }
          return change;
        },
      ),
    }),
    workspace_delete_file: tool({
      description: "Delete one source file from the mutable project workspace.",
      inputSchema: z.object({ path: z.string().min(1).max(500) }),
      execute: async ({ path }, { toolCallId }) => executeDurableTool(
        options,
        { toolCallId, name: "workspace.delete-file", effect: "write", arguments: { path } },
        { type: "file-edit", complete: () => ({ operation: "delete", path }) },
        async () => workspace.tools.deleteFile({ path }),
      ),
    }),
    workspace_move_file: tool({
      description: "Move one source file in the mutable project workspace.",
      inputSchema: z.object({
        from: z.string().min(1).max(500),
        to: z.string().min(1).max(500),
      }),
      execute: async ({ from, to }, { toolCallId }) => executeDurableTool(
        options,
        { toolCallId, name: "workspace.move-file", effect: "write", arguments: { from, to } },
        { type: "file-edit", complete: () => ({ operation: "move", from, to }) },
        async () => workspace.tools.moveFile({ from, to }),
      ),
    }),
  };

  if (!input.sandbox) return workspaceTools;
  const sandboxTools = {
    ...(input.sandbox.supports("files") ? {
      sandbox_read_file: tool({
        description: `Read a file from the ${input.sandbox.provider} sandbox snapshot.`,
        inputSchema: z.object({ path: z.string().min(1).max(500) }),
        execute: async ({ path }, { toolCallId }) => executeDurableTool(
          options,
          { toolCallId, name: "sandbox.read-file", effect: "read", arguments: { path } },
          { type: "file-read", complete: () => ({ path }) },
          async () => ({ path, content: Buffer.from(await input.sandbox!.readFile(
            path,
            signalOptions(options.signal),
          )).toString("utf8") }),
        ),
      }),
    } : {}),
    ...(input.sandbox.supports("commands") ? {
      sandbox_run_command: tool({
        description: `Run one bounded argv command in the ${input.sandbox.provider} sandbox. Shell strings and environment values are not accepted.`,
        inputSchema: z.object({
          command: z.string().min(1).max(512),
          args: z.array(z.string().max(100_000)).max(100),
          cwd: z.string().max(500).nullable(),
          timeoutMs: z.number().int().min(100).nullable(),
        }),
        execute: async ({ command, args, cwd, timeoutMs }, { toolCallId }) => {
          budget.useCommand();
          const boundedTimeout = Math.min(timeoutMs ?? config.commandTimeoutMs, config.commandTimeoutMs);
          const commandInput = {
            command,
            args,
            ...(cwd ? { cwd } : {}),
            timeoutMs: boundedTimeout,
            ...(options.signal ? { signal: options.signal } : {}),
          };
          let grant;
          try {
            grant = await input.sandbox!.authorizeCommand(commandInput);
          } catch (error) {
            if (error instanceof SandboxCommandApprovalRequiredError) {
              approval.request(error);
              return {
                approvalRequired: true,
                idempotencyKey: error.proposedAction.idempotencyKey,
              };
            }
            throw error;
          }
          return executeDurableTool(
            options,
            {
              toolCallId,
              name: "sandbox.run-command",
              effect: "external",
              idempotencyKey: grant.proposedAction.idempotencyKey,
              arguments: { command, args, cwd, timeoutMs: boundedTimeout },
            },
            {
              type: "command",
              complete: (result) => ({
                command,
                args,
                exitCode: isObject(result) && typeof result.exitCode === "number"
                  ? result.exitCode
                  : null,
              }),
            },
            async (part) => {
              const result = await input.sandbox!.run({
                ...commandInput,
                ...(input.sandbox!.supports("commandStreaming") && part
                  ? { onOutput: (event) => part.delta(event.data) }
                  : {}),
              }, grant);
              return {
                ...result,
                stdout: truncateUtf8(result.stdout, config.maxCommandOutputBytes),
                stderr: truncateUtf8(result.stderr, config.maxCommandOutputBytes),
              };
            },
          );
        },
      }),
    } : {}),
    ...(input.sandbox.supports("portUrls") && config.sandboxPorts.length > 0 ? {
      sandbox_get_url: tool({
        description: "Get the URL for one configured sandbox port.",
        inputSchema: z.object({ port: z.number().int().min(1).max(65_535) }),
        execute: async ({ port }, { toolCallId }) => {
          if (!config.sandboxPorts.includes(port)) {
            throw new ConfigurationError(`Sandbox port ${port} is not configured for this agent.`);
          }
          return executeDurableTool(
            options,
            { toolCallId, name: "sandbox.get-url", effect: "read", arguments: { port } },
            null,
            async () => ({ port, url: await input.sandbox!.url(port) }),
          );
        },
      }),
    } : {}),
  };
  return { ...workspaceTools, ...sandboxTools };
}

interface DurableToolInput {
  readonly toolCallId: string;
  readonly name: string;
  readonly effect: "read" | "write" | "external";
  readonly arguments: JsonValue;
  readonly idempotencyKey?: string;
}

type TraceDescriptor<Type extends MessagePartType> = {
  readonly type: Type;
  readonly complete: (result: JsonValue) => MessagePartDataMap[Type];
};

async function executeDurableTool<Type extends MessagePartType>(
  options: GeneratorOptions,
  input: DurableToolInput,
  trace: TraceDescriptor<Type> | null,
  execute: (part: AgentTracePart<Type> | null) => Promise<JsonValue>,
): Promise<JsonValue> {
  const part = trace ? await options.trace?.start(trace.type) ?? null : null;
  const call = await options.toolCalls?.start<JsonValue, JsonValue>({
    providerCallId: input.toolCallId,
    name: input.name,
    effect: input.effect,
    arguments: input.arguments,
    ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
  });
  if (call && !call.created) {
    if (call.toolCall.status === "succeeded") {
      if (part && trace) await part.complete(trace.complete(call.toolCall.result));
      return call.toolCall.result;
    }
    const message = call.toolCall.status === "failed"
      ? call.toolCall.error ?? "Tool call failed."
      : `Tool call ${call.toolCall.id} is already pending reconciliation.`;
    await part?.fail({
      message,
      code: call.toolCall.status === "failed" ? "tool_failed" : "pending_reconciliation",
      retryable: false,
    });
    if (call.toolCall.status === "failed") throw new Error(message);
    throw new ConfigurationError(message);
  }
  try {
    const result = await execute(part);
    await call?.succeed(result);
    if (part && trace) await part.complete(trace.complete(result));
    return result;
  } catch (error) {
    await call?.fail(errorMessage(error)).catch(() => undefined);
    await part?.fail({ message: errorMessage(error), code: "tool_failed", retryable: false })
      .catch(() => undefined);
    throw error;
  }
}

class AgentExecutionBudget {
  readonly #maxCommands: number;
  #commands = 0;

  constructor(config: NormalizedAgentRunnerConfig) {
    this.#maxCommands = config.maxCommands;
  }

  useCommand(): void {
    this.#commands += 1;
    if (this.#commands > this.#maxCommands) {
      throw new ConfigurationError(`The agent exceeded its ${this.#maxCommands}-command budget.`);
    }
  }
}

class AgentApprovalState {
  proposedAction: SandboxCommandApprovalRequiredError["proposedAction"] | null = null;
  #reason = "";

  request(error: SandboxCommandApprovalRequiredError): void {
    if (
      this.proposedAction
      && this.proposedAction.idempotencyKey !== error.proposedAction.idempotencyKey
    ) {
      throw new ConfigurationError("The agent requested multiple approvals in one execution step.");
    }
    this.proposedAction = error.proposedAction;
    this.#reason = error.reason;
  }

  task(): PermissionTaskRequest {
    if (!this.proposedAction) throw new ConfigurationError("The proposed agent action is missing.");
    const { command } = this.proposedAction;
    const rendered = [command.command, ...command.args].join(" ");
    return {
      kind: "permission",
      title: "Approve sandbox command",
      message: this.#reason,
      action: `Run ${rendered}`,
      permissions: ["sandbox.command.run"],
      proposedAction: this.proposedAction,
    };
  }
}

function createAgentInstructions<Framework extends FrameworkId>(input: GeneratorInput<Framework>): string {
  const skills = input.skills.length === 0
    ? "No additional skills were selected."
    : input.skills.map((skill) => {
        const files = skill.files.map((file) => (
          `<skill-file path="${file.path}">\n${file.content}\n</skill-file>`
        )).join("\n");
        return `<skill category="${skill.category}" name="${skill.name}" hash="${skill.contentHash}">\n${files}\n</skill>`;
      }).join("\n\n");
  return [
    "You are Viby, an expert product engineer operating a typed mutable source workspace.",
    `Build only a ${input.framework} project and follow its native conventions.`,
    "Inspect existing files before changing them. Use workspace tools for every source read, search, write, move, and delete.",
    "For a new project, create the entire runnable source tree with workspace_write_file. For an existing project, make the smallest complete set of workspace edits.",
    "Use sandbox tools only when available and useful for verification. Tool absence means the capability is unavailable; never invent it.",
    "Never put secrets, credentials, dependency folders, build output, or lockfiles in the workspace.",
    "Finish with outcome complete, a title, a concise summary, and task null. Return a task only before editing when progress genuinely requires approval or missing critical information.",
    "For a task outcome, title and summary must be null. Every output property is required.",
    "\nResolved skills:\n",
    skills,
  ].join("\n");
}

function createAgentPrompt<Framework extends FrameworkId>(input: GeneratorInput<Framework>): string {
  const history = input.messages.slice(-20).map((message) => (
    `${message.role.toUpperCase()}: ${message.content}`
  )).join("\n\n");
  const tasks = input.tasks.map((task) => JSON.stringify({
    id: task.id,
    kind: task.kind,
    status: task.status,
    resolution: task.resolution,
    ...(task.kind === "permission" && task.proposedAction
      ? { proposedAction: task.proposedAction }
      : {}),
  })).join("\n");
  return [
    history ? `Conversation so far:\n${history}` : "This is the first generation in the chat.",
    input.previousFiles.length > 0
      ? `The workspace contains ${input.previousFiles.length} files. Inspect them with tools.`
      : "The workspace is empty. Create a complete project with tools.",
    tasks ? `Generation task history:\n${tasks}` : "There is no generation task history.",
    `Current request:\n${input.prompt}`,
  ].join("\n\n");
}

function normalizeAgentTask(task: z.infer<typeof agentResponseSchema>["task"]): Extract<GeneratorOutput, { kind: "task" }>["task"] {
  if (!task) throw new ConfigurationError("The agent task is missing.");
  const common = { title: task.title, message: task.message };
  switch (task.kind) {
    case "plan":
      if (task.steps.length === 0) throw new ConfigurationError("A plan task requires steps.");
      return { kind: "plan", ...common, steps: task.steps };
    case "question":
      if (!task.question) throw new ConfigurationError("A question task requires a question.");
      return {
        kind: "question",
        ...common,
        question: task.question,
        choices: task.choices,
        allowFreeform: task.allowFreeform,
      };
    case "permission":
      if (!task.action || task.permissions.length === 0) {
        throw new ConfigurationError("A permission task requires an action and permissions.");
      }
      return { kind: "permission", ...common, action: task.action, permissions: task.permissions };
  }
}

function integerLimit(
  value: number | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  label: string,
): number {
  const normalized = value ?? fallback;
  if (!Number.isInteger(normalized) || normalized < minimum || normalized > maximum) {
    throw new ConfigurationError(`${label} must be an integer between ${minimum} and ${maximum}.`);
  }
  return normalized;
}

function normalizePorts(value: readonly number[] | undefined): readonly number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 16) {
    throw new ConfigurationError("agent.sandboxPorts must contain at most 16 ports.");
  }
  const ports = value.map((port) => {
    if (!Number.isInteger(port) || port < 1 || port > 65_535) {
      throw new ConfigurationError("agent.sandboxPorts must contain ports between 1 and 65535.");
    }
    return port;
  });
  if (new Set(ports).size !== ports.length) {
    throw new ConfigurationError("agent.sandboxPorts cannot contain duplicates.");
  }
  return ports;
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  return signal ? { signal } : {};
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value) <= maxBytes) return value;
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n[output truncated]`;
}

function isObject(value: JsonValue): value is { readonly [key: string]: JsonValue } {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
