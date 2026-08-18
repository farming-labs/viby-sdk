import type { SandboxCommandProposedAction } from "./sandbox.js";
import type { OutboundEventDeliveryData } from "./outbound-events.js";

export class VibyError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VibyError";
    this.code = code;
  }
}

export class ConfigurationError extends VibyError {
  constructor(message: string, options?: ErrorOptions) {
    super("configuration_error", message, options);
    this.name = "ConfigurationError";
  }
}

export class DatabaseNotReadyError extends VibyError {
  constructor() {
    super(
      "database_not_ready",
      "The Viby database schema is missing or outdated. Run `npx viby db migrate` before serving requests.",
    );
    this.name = "DatabaseNotReadyError";
  }
}

export class NotFoundError extends VibyError {
  constructor(resource: string) {
    super("not_found", `${resource} was not found in the current tenant scope.`);
    this.name = "NotFoundError";
  }
}

export class GenerationError extends VibyError {
  readonly generationId: string;

  constructor(generationId: string, message: string, options?: ErrorOptions) {
    super("generation_failed", message, options);
    this.name = "GenerationError";
    this.generationId = generationId;
  }
}

export class GenerationQualityError extends VibyError {
  readonly checkId: string;
  readonly exitCode: number | null;
  readonly detail: string | null;

  constructor(
    checkId: string,
    exitCode: number | null,
    options?: ErrorOptions & { readonly detail?: string | null },
  ) {
    const detail = options?.detail?.trim() || null;
    super(
      "generation_quality_failed",
      `${
        exitCode === null
          ? `Generation quality check ${checkId} could not run.`
          : `Generation quality check ${checkId} failed with exit code ${exitCode}.`
      }${detail ? `\n${detail}` : ""}`,
      options,
    );
    this.name = "GenerationQualityError";
    this.checkId = checkId;
    this.exitCode = exitCode;
    this.detail = detail;
  }
}

export class GenerationCancelledError extends VibyError {
  readonly generationId: string;

  constructor(generationId: string, message = "Generation was cancelled.") {
    super("generation_cancelled", message);
    this.name = "GenerationCancelledError";
    this.generationId = generationId;
  }
}

export class GenerationStateError extends VibyError {
  readonly generationId: string;

  constructor(generationId: string, message: string) {
    super("invalid_generation_state", message);
    this.name = "GenerationStateError";
    this.generationId = generationId;
  }
}

export class GenerationTaskRequiredError extends VibyError {
  readonly generationId: string;
  readonly taskIds: readonly string[];

  constructor(generationId: string, taskIds: readonly string[]) {
    super(
      "generation_task_required",
      `Generation ${generationId} is waiting for ${taskIds.length} task resolution${taskIds.length === 1 ? "" : "s"}.`,
    );
    this.name = "GenerationTaskRequiredError";
    this.generationId = generationId;
    this.taskIds = taskIds;
  }
}

export class SkillResolutionError extends VibyError {
  constructor(locator: string, message: string, options?: ErrorOptions) {
    super("skill_resolution_failed", `Could not resolve skill ${locator}: ${message}`, options);
    this.name = "SkillResolutionError";
  }
}

export class SourceImportError extends VibyError {
  readonly adapter: string;

  constructor(adapter: string, options?: ErrorOptions) {
    super("source_import_failed", `Source import adapter ${adapter} failed.`, options);
    this.name = "SourceImportError";
    this.adapter = adapter;
  }
}

export class IntegrationAuthorizationError extends VibyError {
  readonly provider: string | null;

  constructor(message: string, provider: string | null = null, options?: ErrorOptions) {
    super("integration_authorization_failed", message, options);
    this.name = "IntegrationAuthorizationError";
    this.provider = provider;
  }
}

export class ToolSourceAuthorizationError extends VibyError {
  readonly provider: string | null;

  constructor(message: string, provider: string | null = null, options?: ErrorOptions) {
    super("tool_source_authorization_failed", message, options);
    this.name = "ToolSourceAuthorizationError";
    this.provider = provider;
  }
}

export class ToolSourceConnectionRequiredError extends VibyError {
  readonly sourceId: string;

  constructor(sourceId: string) {
    super(
      "tool_source_connection_required",
      `Tool source ${sourceId} requires authorization.`,
    );
    this.name = "ToolSourceConnectionRequiredError";
    this.sourceId = sourceId;
  }
}

export class IntegrationConnectionRequiredError extends VibyError {
  readonly category: "repository" | "deployment";
  readonly integrationId: string;

  constructor(category: "repository" | "deployment", integrationId: string) {
    super(
      "integration_connection_required",
      `Integration ${category}.${integrationId} requires an active connection.`,
    );
    this.name = "IntegrationConnectionRequiredError";
    this.category = category;
    this.integrationId = integrationId;
  }
}

export class IntegrationOperationError extends VibyError {
  readonly category: "repository" | "deployment";
  readonly provider: string;
  readonly operation: string;

  constructor(
    category: "repository" | "deployment",
    provider: string,
    operation: string,
    options?: ErrorOptions,
  ) {
    super(
      "integration_operation_failed",
      `${provider} could not complete the ${category} ${operation} operation.`,
      options,
    );
    this.name = "IntegrationOperationError";
    this.category = category;
    this.provider = provider;
    this.operation = operation;
  }
}

export class OutboundEventSinkError extends VibyError {
  readonly sinkId: string;
  readonly eventId: string;

  constructor(sinkId: string, eventId: string, options?: ErrorOptions) {
    super("outbound_event_sink_failed", `Outbound event sink ${sinkId} failed to deliver ${eventId}.`, options);
    this.name = "OutboundEventSinkError";
    this.sinkId = sinkId;
    this.eventId = eventId;
  }
}

export class OutboundEventDeliveryError extends VibyError {
  readonly sinkId: string;
  readonly eventId: string;
  readonly eventCursor: string;
  readonly lastDeliveredCursor: string;
  readonly delivery: OutboundEventDeliveryData | null;

  constructor(
    sinkId: string,
    eventId: string,
    eventCursor: string,
    lastDeliveredCursor: string,
    delivery: OutboundEventDeliveryData | null,
    options?: ErrorOptions,
  ) {
    super("outbound_event_delivery_failed", `Outbound event delivery to ${sinkId} stopped at ${eventId}.`, options);
    this.name = "OutboundEventDeliveryError";
    this.sinkId = sinkId;
    this.eventId = eventId;
    this.eventCursor = eventCursor;
    this.lastDeliveredCursor = lastDeliveredCursor;
    this.delivery = delivery;
  }
}

export class OutboundEventSignatureError extends VibyError {
  constructor(message: string, options?: ErrorOptions) {
    super("invalid_outbound_event_signature", message, options);
    this.name = "OutboundEventSignatureError";
  }
}

export class SandboxUnavailableError extends VibyError {
  constructor(message: string) {
    super("sandbox_unavailable", message);
    this.name = "SandboxUnavailableError";
  }
}

export class SandboxCommandDeniedError extends VibyError {
  readonly provider: string;
  readonly action: "run" | "start";
  readonly reason: string;

  constructor(provider: string, action: "run" | "start", reason: string) {
    super("sandbox_command_denied", `Sandbox command was denied for ${provider}: ${reason}`);
    this.name = "SandboxCommandDeniedError";
    this.provider = provider;
    this.action = action;
    this.reason = reason;
  }
}

export class SandboxCommandApprovalRequiredError extends VibyError {
  readonly proposedAction: SandboxCommandProposedAction;
  readonly reason: string;

  constructor(proposedAction: SandboxCommandProposedAction, reason: string) {
    super(
      "sandbox_command_approval_required",
      `Sandbox command requires approval for ${proposedAction.provider}: ${reason}`,
    );
    this.name = "SandboxCommandApprovalRequiredError";
    this.proposedAction = proposedAction;
    this.reason = reason;
  }
}

export class SandboxError extends VibyError {
  readonly provider: string;
  readonly operation: string;

  constructor(
    provider: string,
    operation: string,
    message: string,
    options?: ErrorOptions,
  ) {
    super("sandbox_error", `${provider} could not ${operation}: ${message}`, options);
    this.name = "SandboxError";
    this.provider = provider;
    this.operation = operation;
  }
}

export class BrowserError extends VibyError {
  readonly provider: string;
  readonly operation: string;

  constructor(provider: string, operation: string, message: string, options?: ErrorOptions) {
    super("browser_error", `${provider} could not ${operation}: ${message}`, options);
    this.name = "BrowserError";
    this.provider = provider;
    this.operation = operation;
  }
}
