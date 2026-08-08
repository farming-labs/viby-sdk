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
