import {
  isStepCount,
  jsonSchema,
  NoOutputGeneratedError,
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
import { createMultimodalPrompt, generatedFileOutputs } from "./generator.js";
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
import {
  createToolSourceProposedAction,
  resolveToolSourcePolicy,
  resolveToolSources,
  type ToolSourceProposedAction,
  type ToolSourcesConfig,
} from "./tool-source.js";

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
  readonly maxOutputTokens: number;
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
  const maxTokens = integerLimit(
    config?.maxTokens,
    DEFAULT_MAX_TOKENS,
    1_000,
    10_000_000,
    "agent.maxTokens",
  );
  return Object.freeze({
    maxSteps: integerLimit(config?.maxSteps, DEFAULT_MAX_STEPS, 1, 100, "agent.maxSteps"),
    maxDurationMs: integerLimit(
      config?.maxDurationMs,
      DEFAULT_MAX_DURATION_MS,
      1_000,
      3_600_000,
      "agent.maxDurationMs",
    ),
    maxTokens,
    maxOutputTokens: integerLimit(
      config?.maxOutputTokens,
      Math.min(maxTokens, 16_384),
      256,
      1_000_000,
      "agent.maxOutputTokens",
    ),
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
  readonly #tools: ToolSourcesConfig<Framework> | undefined;

  constructor(
    model: LanguageModel,
    config: AgentRunnerConfig | undefined = undefined,
    tools: ToolSourcesConfig<Framework> | undefined = undefined,
  ) {
    this.#model = model;
    this.#config = normalizeAgentRunnerConfig(config);
    this.#tools = tools;
  }

  async generate(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions = {},
  ): Promise<GeneratorOutput> {
    const previousEntries = input.previousEntries ?? input.previousFiles;
    const workspace = new AgentWorkspace(previousEntries, async () => undefined);
    const budget = new AgentExecutionBudget(this.#config);
    const approval = new AgentApprovalState(input.tasks);
    const tools = await createAgentTools(
      workspace,
      input,
      options,
      budget,
      this.#config,
      approval,
      this.#tools,
    );
    const agent = new ToolLoopAgent({
      model: this.#model,
      instructions: createAgentInstructions(input),
      tools,
      output: Output.object({
        name: "viby_agent_result",
        description: "The completed workspace result or a typed blocking task.",
        schema: agentResponseSchema,
      }),
      maxOutputTokens: Math.min(this.#config.maxTokens, this.#config.maxOutputTokens),
      prepareStep: async ({ steps, messages }) => {
        const steering = await options.steering?.consume() ?? [];
        const exhausted = totalStepTokens(steps) >= this.#config.maxTokens;
        if (!exhausted && steering.length === 0) return undefined;
        return {
          ...(steering.length === 0 ? {} : {
            messages: [
              ...messages,
              ...steering.map((entry) => ({
                role: "user" as const,
                content: entry.attachments.length === 0
                  ? `Steering update for the current run:\n${entry.prompt}`
                  : [
                      {
                        type: "text" as const,
                        text: `Steering update for the current run:\n${entry.prompt}`,
                      },
                      ...entry.attachments.map((attachment) => ({
                        type: "file" as const,
                        data: attachment.bytes,
                        filename: attachment.filename,
                        mediaType: attachment.mediaType,
                      })),
                    ],
              })),
            ],
          }),
          ...(exhausted ? {
            activeTools: [],
            toolChoice: "none" as const,
            instructions: `${createAgentInstructions(input)}\n\nThe execution budget is exhausted. Do not call tools. Return the required complete or task outcome now based on the workspace work already performed.`,
          } : {}),
        };
      },
      stopWhen: [
        isStepCount(this.#config.maxSteps),
        () => approval.proposedAction !== null,
      ],
    });
    const result = await agent.generate({
      ...createMultimodalPrompt(createAgentPrompt(input), input.attachments),
      ...(options.signal ? { abortSignal: options.signal } : {}),
      timeout: {
        totalMs: this.#config.maxDurationMs,
        toolMs: this.#config.commandTimeoutMs,
      },
    });
    const artifacts = generatedFileOutputs(result.files);
    if (approval.proposedAction) {
      return {
        kind: "task",
        task: approval.task(),
        usage: result.totalUsage,
        finishReason: result.finishReason,
        artifacts,
      };
    }
    let output: z.infer<typeof agentResponseSchema>;
    try {
      output = result.output;
    } catch (error) {
      const changes = workspace.changes();
      if (!NoOutputGeneratedError.isInstance(error) || changes.length === 0) throw error;
      return completedWorkspaceOutput({
        input,
        workspace,
        changes,
        title: previousEntries.length > 0 ? "Updated project" : "Generated project",
        summary: `Applied ${changes.length} validated workspace ${changes.length === 1 ? "change" : "changes"} before the model's final response ended.`,
        usage: result.totalUsage,
        finishReason: result.finishReason,
        artifacts,
      });
    }
    if (output.outcome === "task") {
      if (!output.task || output.title || output.summary) {
        throw new ConfigurationError("The agent returned an inconsistent task outcome.");
      }
      const changes = workspace.changes();
      if (changes.length > 0) {
        return completedWorkspaceOutput({
          input,
          workspace,
          changes,
          title: previousEntries.length > 0 ? "Updated project" : "Generated project",
          summary: `Applied ${changes.length} validated workspace ${changes.length === 1 ? "change" : "changes"} before the model returned a late task outcome.`,
          usage: result.totalUsage,
          finishReason: result.finishReason,
          artifacts,
        });
      }
      return {
        kind: "task",
        task: normalizeAgentTask(output.task),
        usage: result.totalUsage,
        finishReason: result.finishReason,
        artifacts,
      };
    }
    if (!output.title || !output.summary || output.task) {
      throw new ConfigurationError("The agent returned an inconsistent completion outcome.");
    }
    const changes = workspace.changes();
    if (changes.length === 0) {
      throw new ConfigurationError("The agent completed without changing the workspace.");
    }
    return completedWorkspaceOutput({
      input,
      workspace,
      changes,
      title: output.title,
      summary: output.summary,
      usage: result.totalUsage,
      finishReason: result.finishReason,
      artifacts,
    });
  }
}

function completedWorkspaceOutput<Framework extends FrameworkId>(options: {
  readonly input: GeneratorInput<Framework>;
  readonly workspace: AgentWorkspace;
  readonly changes: readonly SourceChange[];
  readonly title: string;
  readonly summary: string;
  readonly usage: LanguageModelUsage;
  readonly finishReason: string;
  readonly artifacts: readonly import("./generator.js").GeneratorArtifactOutput[];
}): GeneratorOutput {
  const previousEntries = options.input.previousEntries ?? options.input.previousFiles;
  if (previousEntries.length === 0) {
    return {
      kind: "project",
      title: options.title,
      summary: options.summary,
      files: options.workspace.files(),
      usage: options.usage,
      finishReason: options.finishReason,
      artifacts: options.artifacts,
    };
  }
  return {
    kind: "changes",
    title: options.title,
    summary: options.summary,
    changes: options.changes,
    usage: options.usage,
    finishReason: options.finishReason,
    artifacts: options.artifacts,
  };
}

function totalStepTokens(steps: readonly { readonly usage: LanguageModelUsage }[]): number {
  return steps.reduce((total, step) => total + (step.usage.totalTokens ?? 0), 0);
}

async function createAgentTools<Framework extends FrameworkId>(
  workspace: AgentWorkspace,
  input: GeneratorInput<Framework>,
  options: GeneratorOptions,
  budget: AgentExecutionBudget,
  config: NormalizedAgentRunnerConfig,
  approval: AgentApprovalState,
  toolSources: ToolSourcesConfig<Framework> | undefined,
) {
  const workspacePaths = new Set(
    (await workspace.tools.listFiles()).map((file) => file.path),
  );
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
      execute: async ({ path, content, mediaType }, { toolCallId }) => {
        const operation = workspacePaths.has(path) ? "update" as const : "create" as const;
        return executeDurableTool(
          options,
          {
            toolCallId,
            name: "workspace.write-file",
            effect: "write",
            arguments: { path, content, mediaType },
          },
          { type: "file-edit", complete: () => ({ operation, path }) },
          async () => {
            const change = await workspace.tools.writeFile({
              path,
              content,
              ...(mediaType ? { mediaType } : {}),
            });
            if (input.sandbox?.supports("files")) {
              await input.sandbox.writeFiles([{ path, content }], signalOptions(options.signal));
            }
            workspacePaths.add(path);
            return change;
          },
        );
      },
    }),
    workspace_delete_file: tool({
      description: "Delete one source file from the mutable project workspace.",
      inputSchema: z.object({ path: z.string().min(1).max(500) }),
      execute: async ({ path }, { toolCallId }) => executeDurableTool(
        options,
        { toolCallId, name: "workspace.delete-file", effect: "write", arguments: { path } },
        { type: "file-edit", complete: () => ({ operation: "delete", path }) },
        async () => {
          const change = await workspace.tools.deleteFile({ path });
          workspacePaths.delete(path);
          return change;
        },
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
        async () => {
          const change = await workspace.tools.moveFile({ from, to });
          workspacePaths.delete(from);
          workspacePaths.add(to);
          return change;
        },
      ),
    }),
  };

  const inboundTools = input.toolContext && toolSources
    ? await createInboundAgentTools(input.toolContext, toolSources, options, approval)
    : {};
  if (!input.sandbox) return { ...workspaceTools, ...inboundTools };
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
              approval.requestSandbox(error);
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
  return { ...workspaceTools, ...sandboxTools, ...inboundTools };
}

async function createInboundAgentTools<Framework extends FrameworkId>(
  context: NonNullable<GeneratorInput<Framework>["toolContext"]>,
  config: ToolSourcesConfig<Framework>,
  options: GeneratorOptions,
  approval: AgentApprovalState,
) {
  const definitions = await resolveToolSources(config, context);
  return Object.fromEntries(definitions.map(({ key, source, tool: definition }) => [
    key,
    tool({
      description: definition.description,
      inputSchema: jsonSchema<Readonly<Record<string, JsonValue>>>(definition.inputSchema as never),
      execute: async (arguments_, { toolCallId }) => {
        const proposedAction = createToolSourceProposedAction(
          source.id,
          definition.name,
          arguments_,
          context,
        );
        const resolved = approval.decision(proposedAction.idempotencyKey);
        const decision = resolved ?? await resolveToolSourcePolicy(config, {
          source: source.id,
          tool: definition,
          arguments: arguments_,
          context,
        });
        if (decision === "deny") {
          throw new ConfigurationError(`Inbound tool ${source.id}.${definition.name} was denied.`);
        }
        if (decision === "approval-required") {
          approval.requestTool(proposedAction, definition.permissions ?? [
            `tool.${source.id}.${definition.name}`,
          ]);
          return {
            approvalRequired: true,
            idempotencyKey: proposedAction.idempotencyKey,
          };
        }
        return executeDurableTool(
          options,
          {
            toolCallId,
            name: `tool-source.${source.id}.${definition.name}`,
            effect: definition.effect,
            idempotencyKey: proposedAction.idempotencyKey,
            arguments: arguments_,
          },
          null,
          async () => source.call({
            name: definition.name,
            arguments: arguments_,
            idempotencyKey: proposedAction.idempotencyKey,
          }, context),
        );
      },
    }),
  ]));
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
  proposedAction: SandboxCommandApprovalRequiredError["proposedAction"] | ToolSourceProposedAction | null = null;
  #reason = "";
  #permissions: readonly string[] = [];
  readonly #decisions = new Map<string, "allow" | "deny">();

  constructor(tasks: readonly import("./types.js").GenerationTaskData[]) {
    for (const task of tasks) {
      if (
        task.kind === "permission"
        && task.status === "resolved"
        && task.resolution?.kind === "permission"
        && (task.proposedAction || task.proposedToolAction)
      ) {
        this.#decisions.set(
          (task.proposedAction ?? task.proposedToolAction)!.idempotencyKey,
          task.resolution.decision,
        );
      }
    }
  }

  requestSandbox(error: SandboxCommandApprovalRequiredError): void {
    if (
      this.proposedAction
      && this.proposedAction.idempotencyKey !== error.proposedAction.idempotencyKey
    ) {
      throw new ConfigurationError("The agent requested multiple approvals in one execution step.");
    }
    this.proposedAction = error.proposedAction;
    this.#reason = error.reason;
    this.#permissions = ["sandbox.command.run"];
  }

  requestTool(action: ToolSourceProposedAction, permissions: readonly string[]): void {
    if (this.proposedAction && this.proposedAction.idempotencyKey !== action.idempotencyKey) {
      throw new ConfigurationError("The agent requested multiple approvals in one execution step.");
    }
    this.proposedAction = action;
    this.#reason = `Allow ${action.source}.${action.tool} to run with the proposed arguments?`;
    this.#permissions = permissions;
  }

  decision(idempotencyKey: string): "allow" | "deny" | undefined {
    return this.#decisions.get(idempotencyKey);
  }

  task(): PermissionTaskRequest {
    if (!this.proposedAction) throw new ConfigurationError("The proposed agent action is missing.");
    if (this.proposedAction.type === "sandbox-command") {
      const rendered = [
        this.proposedAction.command.command,
        ...this.proposedAction.command.args,
      ].join(" ");
      return {
        kind: "permission",
        title: "Approve sandbox command",
        message: this.#reason,
        action: `Run ${rendered}`,
        permissions: this.#permissions,
        proposedAction: this.proposedAction,
      };
    }
    return {
      kind: "permission",
      title: "Approve tool call",
      message: this.#reason,
      action: `Call ${this.proposedAction.source}.${this.proposedAction.tool}`,
      permissions: this.#permissions,
      proposedToolAction: this.proposedAction,
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
    "Batch independent tool calls into the same step whenever possible, especially file reads. Do not inspect files serially when they can be read together.",
    "For a new project, create the entire runnable source tree with workspace_write_file. For an existing project, make the smallest complete set of workspace edits.",
    "Use sandbox tools only when available and useful for verification. Tool absence means the capability is unavailable; never invent it.",
    "Never put secrets, credentials, dependency folders, build output, or lockfiles in the workspace.",
    "Finish with outcome complete, a title, a concise summary, and task null. Return a task only before editing when progress genuinely requires approval or missing critical information.",
    "For a task outcome, title and summary must be null. Every output property is required.",
    "\nResolved skills:\n",
    skills,
    input.instructions ? `\nGeneration-specific host instructions:\n${input.instructions}` : "",
  ].join("\n");
}

function createAgentPrompt<Framework extends FrameworkId>(input: GeneratorInput<Framework>): string {
  const history = input.messages.slice(-20).map((message) => (
    `${message.role.toUpperCase()}: ${message.content}`
  )).join("\n\n");
  const workspaceEntries = input.previousEntries ?? input.previousFiles;
  const workspaceInventory = workspaceEntries
    .slice(0, 500)
    .map((entry) => `- ${entry.path}`)
    .join("\n");
  const tasks = input.tasks.map((task) => JSON.stringify({
    id: task.id,
    kind: task.kind,
    status: task.status,
    resolution: task.resolution,
    ...(task.kind === "permission" && (task.proposedAction || task.proposedToolAction)
      ? { proposedAction: task.proposedAction ?? task.proposedToolAction }
      : {}),
  })).join("\n");
  return [
    history ? `Conversation so far:\n${history}` : "This is the first generation in the chat.",
    workspaceEntries.length > 0
      ? [
          `The workspace contains ${workspaceEntries.length} entries:`,
          workspaceInventory,
          workspaceEntries.length > 500 ? "- [additional entries omitted]" : "",
          "Read only files relevant to the current request. Do not inspect package or framework configuration unless the request changes dependencies, scripts, build behavior, or runtime behavior.",
        ].filter(Boolean).join("\n")
      : "The workspace is empty. Create a complete project with tools.",
    tasks ? `Generation task history:\n${tasks}` : "There is no generation task history.",
    input.attachments?.length
      ? `${input.attachments.length} immutable attachment(s) are supplied as multimodal file parts.`
      : "There are no attachments for this request.",
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
