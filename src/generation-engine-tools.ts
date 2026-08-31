import { ConfigurationError } from "./errors.js";
import type {
  AgentToolCallWriter,
  GenerationEngineToolChannel,
  GenerationEngineToolDescriptor,
  InvokeGenerationEngineToolInput,
} from "./generator.js";
import type { FrameworkId, GenerationTaskData, JsonValue, PermissionTaskRequest } from "./types.js";
import {
  createToolSourceProposedAction,
  resolveToolSourcePolicy,
  resolveToolSources,
  type ResolvedToolSource,
  type ToolSourceContext,
  type ToolSourceProposedAction,
  type ToolSourcesRuntimeConfig,
} from "./tool-source.js";

interface GenerationEngineToolsInput<Framework extends FrameworkId> {
  readonly config: ToolSourcesRuntimeConfig<Framework>;
  readonly context: ToolSourceContext<Framework>;
  readonly tasks: readonly GenerationTaskData[];
  readonly toolCalls: AgentToolCallWriter;
  readonly readOnly: boolean;
}

/** Raised when a host policy requires the user to approve an engine tool call. */
export class GenerationEngineToolApprovalRequiredError extends Error {
  override readonly name = "GenerationEngineToolApprovalRequiredError";

  constructor(
    readonly proposedAction: ToolSourceProposedAction,
    readonly permissions: readonly string[],
  ) {
    super(`Allow ${proposedAction.source}.${proposedAction.tool} to run with the proposed arguments?`);
  }

  task(): PermissionTaskRequest {
    return {
      kind: "permission",
      title: "Approve tool call",
      message: this.message,
      action: `Call ${this.proposedAction.source}.${this.proposedAction.tool}`,
      permissions: this.permissions,
      proposedToolAction: this.proposedAction,
    };
  }
}

/** Internal bridge used to expose host-authorized tool sources to custom engines. */
export class AuthorizedGenerationEngineTools<Framework extends FrameworkId>
implements GenerationEngineToolChannel {
  readonly #input: GenerationEngineToolsInput<Framework>;
  readonly #decisions = new Map<string, "allow" | "deny">();
  #resolved: Promise<readonly ResolvedToolSource<Framework>[]> | undefined;

  constructor(input: GenerationEngineToolsInput<Framework>) {
    this.#input = input;
    for (const task of input.tasks) {
      if (
        task.kind === "permission" &&
        task.status === "resolved" &&
        task.resolution?.kind === "permission" &&
        task.proposedToolAction
      ) {
        this.#decisions.set(
          task.proposedToolAction.idempotencyKey,
          task.resolution.decision,
        );
      }
    }
  }

  async list(): Promise<readonly GenerationEngineToolDescriptor[]> {
    return (await this.#tools()).map(({ key, source, tool }) => Object.freeze({
      name: key,
      source: source.id,
      tool: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: tool.description,
      inputSchema: tool.inputSchema,
      effect: tool.effect,
      permissions: Object.freeze([...(tool.permissions ?? [
        `tool.${source.id}.${tool.name}`,
      ])]),
    }));
  }

  async invoke(input: InvokeGenerationEngineToolInput): Promise<JsonValue> {
    if (!input || typeof input !== "object") {
      throw new ConfigurationError("A generation engine tool call is required.");
    }
    if (typeof input.name !== "string" || input.name.trim().length === 0) {
      throw new ConfigurationError("A generation engine tool name is required.");
    }
    if (typeof input.providerCallId !== "string" || input.providerCallId.trim().length === 0) {
      throw new ConfigurationError("A generation engine provider call id is required.");
    }
    if (!input.arguments || typeof input.arguments !== "object" || Array.isArray(input.arguments)) {
      throw new ConfigurationError("Generation engine tool arguments must be a JSON object.");
    }
    const resolved = (await this.#tools()).find(({ key }) => key === input.name);
    if (!resolved) {
      throw new ConfigurationError(`Generation engine tool is not available: ${input.name}`);
    }
    const proposedAction = createToolSourceProposedAction(
      resolved.source.id,
      resolved.tool.name,
      input.arguments,
      this.#input.context,
    );
    const decision = this.#decisions.get(proposedAction.idempotencyKey) ??
      await resolveToolSourcePolicy(this.#input.config, {
        source: resolved.source.id,
        tool: resolved.tool,
        arguments: input.arguments,
        context: this.#input.context,
      });
    if (decision === "deny") {
      throw new ConfigurationError(
        `Generation engine tool ${resolved.source.id}.${resolved.tool.name} was denied.`,
      );
    }
    if (decision === "approval-required") {
      throw new GenerationEngineToolApprovalRequiredError(
        proposedAction,
        resolved.tool.permissions ?? [`tool.${resolved.source.id}.${resolved.tool.name}`],
      );
    }

    const call = await this.#input.toolCalls.start<JsonValue, JsonValue>({
      providerCallId: input.providerCallId,
      name: `tool-source.${resolved.source.id}.${resolved.tool.name}`,
      effect: resolved.tool.effect,
      arguments: input.arguments,
      idempotencyKey: proposedAction.idempotencyKey,
    });
    if (!call.created) {
      if (call.toolCall.status === "succeeded") return call.toolCall.result;
      const message = call.toolCall.status === "failed"
        ? call.toolCall.error ?? "Tool call failed."
        : `Tool call ${call.toolCall.id} is already pending reconciliation.`;
      if (call.toolCall.status === "failed") throw new Error(message);
      throw new ConfigurationError(message);
    }
    try {
      const result = await resolved.source.call({
        name: resolved.tool.name,
        arguments: input.arguments,
        idempotencyKey: proposedAction.idempotencyKey,
      }, this.#input.context);
      await call.succeed(result);
      return result;
    } catch (error) {
      await call.fail(engineToolErrorMessage(error)).catch(() => undefined);
      throw error;
    }
  }

  #tools(): Promise<readonly ResolvedToolSource<Framework>[]> {
    return (this.#resolved ??= resolveToolSources(
      this.#input.config,
      this.#input.context,
    ).then((tools) => Object.freeze(
      tools.filter(({ tool }) => !this.#input.readOnly || tool.effect === "read"),
    )));
  }
}

function engineToolErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
