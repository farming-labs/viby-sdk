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

export class SkillResolutionError extends VibyError {
  constructor(locator: string, message: string, options?: ErrorOptions) {
    super("skill_resolution_failed", `Could not resolve skill ${locator}: ${message}`, options);
    this.name = "SkillResolutionError";
  }
}
