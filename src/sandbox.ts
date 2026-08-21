import {
  ConfigurationError,
  SandboxCommandApprovalRequiredError,
  SandboxCommandDeniedError,
  SandboxError,
  SandboxUnavailableError,
} from "./errors.js";
import type { FrameworkId, UserScope } from "./types.js";
import type { EnvironmentName } from "./environment.js";
import { createId, errorMessage, normalizeProjectPath, sha256 } from "./utils.js";

const DEFAULT_SANDBOX_TIMEOUT_MS = 300_000;
const MAX_SANDBOX_TIMEOUT_MS = 86_400_000;
const MAX_ENVIRONMENT_BYTES = 128_000;
const MAX_ENVIRONMENT_ENTRIES = 256;
const MAX_PORTS = 16;

export const SANDBOX_CAPABILITY_NAMES = [
  "files",
  "commands",
  "commandStreaming",
  "portUrls",
  "backgroundProcesses",
  "reconnect",
  "snapshots",
] as const;

export type SandboxCapability = typeof SANDBOX_CAPABILITY_NAMES[number];

export type SandboxCapabilities = Readonly<Record<SandboxCapability, boolean>>;

export function sandboxCapabilities(
  capabilities: Partial<SandboxCapabilities> = {},
): SandboxCapabilities {
  if (!capabilities || typeof capabilities !== "object" || Array.isArray(capabilities)) {
    throw new ConfigurationError("Sandbox capabilities must be an object.");
  }
  const unknown = Object.keys(capabilities).filter((key) => (
    !SANDBOX_CAPABILITY_NAMES.includes(key as SandboxCapability)
  ));
  if (unknown.length > 0) {
    throw new ConfigurationError(`Unknown sandbox capability: ${unknown[0]}`);
  }
  for (const [name, enabled] of Object.entries(capabilities)) {
    if (typeof enabled !== "boolean") {
      throw new ConfigurationError(`Sandbox capability ${name} must be a boolean.`);
    }
  }
  return Object.freeze(Object.fromEntries(
    SANDBOX_CAPABILITY_NAMES.map((name) => [name, capabilities[name] ?? false]),
  ) as unknown as SandboxCapabilities);
}

export interface SandboxAdapter {
  readonly provider: string;
  readonly capabilities: SandboxCapabilities;
  create(input: SandboxCreateInput): Promise<SandboxInstance>;
  reconnect?(input: SandboxReconnectInput): Promise<SandboxInstance>;
}

export interface SandboxCreateContext<Framework extends FrameworkId = FrameworkId> {
  readonly tenantId: string;
  readonly userId: string;
  readonly chatId: string;
  readonly versionId: string;
  readonly framework: Framework;
}

export interface SandboxCreateInput<Framework extends FrameworkId = FrameworkId> {
  readonly context: SandboxCreateContext<Framework>;
  readonly timeoutMs: number;
  readonly env: Readonly<Record<string, string>>;
  readonly ports: readonly number[];
  readonly signal?: AbortSignal;
}

export interface SandboxReconnectInput<Framework extends FrameworkId = FrameworkId> {
  readonly sandboxId: string;
  readonly context: SandboxCreateContext<Framework>;
  readonly ports: readonly number[];
  readonly expiresAt: Date;
  readonly signal?: AbortSignal;
}

export type SandboxLeaseStatus = "active" | "stopped" | "expired";

export interface SandboxLeaseData<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly sandboxId: string;
  readonly provider: string;
  readonly context: SandboxCreateContext<Framework>;
  readonly ports: readonly number[];
  readonly status: SandboxLeaseStatus;
  readonly expiresAt: Date;
  readonly createdAt: Date;
  readonly updatedAt: Date;
  readonly stoppedAt: Date | null;
}

export interface CreateSandboxLeaseRecord<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly sandboxId: string;
  readonly provider: string;
  readonly context: SandboxCreateContext<Framework>;
  readonly ports: readonly number[];
  readonly expiresAt: Date;
}

export interface SandboxLeaseStore {
  createSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    input: CreateSandboxLeaseRecord<Framework>,
  ): Promise<SandboxLeaseData<Framework>>;
  getSandboxLease<Framework extends FrameworkId>(
    scope: UserScope,
    id: string,
  ): Promise<SandboxLeaseData<Framework> | null>;
  closeSandboxLease(
    scope: UserScope,
    id: string,
    status: Exclude<SandboxLeaseStatus, "active">,
  ): Promise<void>;
}

export interface SandboxOpenOptions {
  readonly timeoutMs?: number;
  /** Resolve this durable project environment before creating the sandbox. */
  readonly environment?: EnvironmentName;
  readonly env?: Readonly<Record<string, string>>;
  readonly ports?: readonly number[];
  readonly signal?: AbortSignal;
}

export interface SandboxReconnectOptions {
  readonly signal?: AbortSignal;
}

export interface SandboxCommandPolicyRequest<Framework extends FrameworkId = FrameworkId> {
  readonly action: "run" | "start";
  readonly provider: string;
  readonly context: SandboxCreateContext<Framework>;
  readonly command: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: readonly string[];
    readonly timeoutMs: number;
  };
}

export type SandboxCommandPolicyDecision =
  | { readonly decision: "allow" }
  | { readonly decision: "deny"; readonly reason: string }
  | { readonly decision: "approval-required"; readonly reason: string }
  | { readonly allow: true }
  | { readonly allow: false; readonly reason: string };

export type SandboxCommandPolicy = (
  request: SandboxCommandPolicyRequest,
) => SandboxCommandPolicyDecision | Promise<SandboxCommandPolicyDecision>;

export interface SandboxCommandPolicyOptions {
  readonly allowCommands?: readonly string[];
  readonly denyCommands?: readonly string[];
  readonly actions?: readonly ("run" | "start")[];
  readonly environment?: readonly string[];
  readonly maxTimeoutMs?: number;
  readonly maxArgs?: number;
}

export interface SandboxCommandAuthorization<Framework extends FrameworkId = FrameworkId> {
  readonly policy: SandboxCommandPolicy;
  readonly context: SandboxCreateContext<Framework>;
  readonly approvedActionKeys?: ReadonlySet<string>;
  readonly deniedActionKeys?: ReadonlySet<string>;
}

export interface SandboxResolvedCommandActions {
  readonly approvedActionKeys?: readonly string[];
  readonly deniedActionKeys?: readonly string[];
}

export interface SandboxCommandProposedAction<Framework extends FrameworkId = FrameworkId> {
  readonly type: "sandbox-command";
  readonly idempotencyKey: string;
  readonly provider: string;
  readonly action: "run" | "start";
  readonly context: SandboxCreateContext<Framework> | null;
  readonly command: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly environment: readonly string[];
    readonly timeoutMs: number;
  };
}

export interface SandboxCommandGrant {
  readonly proposedAction: SandboxCommandProposedAction;
}

export function sandboxCommandPolicy(options: SandboxCommandPolicyOptions): SandboxCommandPolicy {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Sandbox command policy options must be an object.");
  }
  const allowCommands = normalizePolicyStrings(options.allowCommands, "allowCommands");
  const denyCommands = normalizePolicyStrings(options.denyCommands, "denyCommands");
  const overlap = [...allowCommands].find((command) => denyCommands.has(command));
  if (overlap) {
    throw new ConfigurationError(`Sandbox command policy cannot both allow and deny ${overlap}.`);
  }
  if (options.actions !== undefined && !Array.isArray(options.actions)) {
    throw new ConfigurationError("Sandbox command policy actions must be an array.");
  }
  const actions = new Set(options.actions ?? ["run", "start"]);
  if ([...actions].some((action) => action !== "run" && action !== "start")) {
    throw new ConfigurationError("Sandbox command policy actions must be run or start.");
  }
  const environment = normalizePolicyEnvironment(options.environment);
  const maxTimeoutMs = normalizePolicyLimit(options.maxTimeoutMs, 1, MAX_SANDBOX_TIMEOUT_MS, "maxTimeoutMs");
  const maxArgs = normalizePolicyLimit(options.maxArgs, 0, 10_000, "maxArgs");

  return (request) => {
    const command = request.command.command;
    if (!actions.has(request.action)) {
      return { decision: "deny", reason: `${request.action} commands are not allowed.` };
    }
    if (denyCommands.has(command)) {
      return { decision: "deny", reason: `${command} is explicitly denied.` };
    }
    if (allowCommands.size > 0 && !allowCommands.has(command)) {
      return { decision: "deny", reason: `${command} is not in the command allowlist.` };
    }
    if (maxTimeoutMs !== null && request.command.timeoutMs > maxTimeoutMs) {
      return { decision: "deny", reason: `Command timeout exceeds ${maxTimeoutMs}ms.` };
    }
    if (maxArgs !== null && request.command.args.length > maxArgs) {
      return { decision: "deny", reason: `Command has more than ${maxArgs} arguments.` };
    }
    const disallowedEnvironment = request.command.environment.find((name) => (
      environment !== null && !environment.has(name)
    ));
    if (disallowedEnvironment) {
      return {
        decision: "deny",
        reason: `Environment variable ${disallowedEnvironment} is not allowed.`,
      };
    }
    return { decision: "allow" };
  };
}

export interface SandboxFile {
  readonly path: string;
  readonly content: string | Uint8Array;
}

export interface SandboxOperationOptions {
  readonly signal?: AbortSignal;
}

export interface SandboxReadinessOptions extends SandboxOperationOptions {
  readonly path?: string;
  readonly timeoutMs?: number;
  readonly intervalMs?: number;
  readonly check?: (url: string, options: { readonly signal: AbortSignal }) => Promise<boolean>;
}

export interface SandboxCommand {
  readonly command: string;
  readonly args?: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
  readonly onOutput?: (event: SandboxOutputEvent) => void | Promise<void>;
}

export interface SandboxOutputEvent {
  readonly stream: "stdout" | "stderr";
  readonly data: string;
}

export interface SandboxCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly durationMs: number;
}

export interface SandboxProcessInstance {
  readonly id: string;
  wait(options?: SandboxOperationOptions): Promise<SandboxCommandResult>;
  kill(options?: SandboxOperationOptions): Promise<void>;
}

export interface SandboxInstance {
  readonly id: string;
  writeFiles(files: readonly SandboxFile[], options?: SandboxOperationOptions): Promise<void>;
  run(command: SandboxCommand): Promise<SandboxCommandResult>;
  start?(command: SandboxCommand): Promise<SandboxProcessInstance>;
  readFile(path: string, options?: SandboxOperationOptions): Promise<Uint8Array>;
  getUrl?(port: number): string | Promise<string>;
  stop(options?: SandboxOperationOptions): Promise<void>;
}

export class SandboxProcess {
  readonly id: string;
  readonly provider: string;
  readonly #instance: SandboxProcessInstance;
  #killPromise: Promise<void> | null = null;

  constructor(provider: string, instance: SandboxProcessInstance) {
    this.provider = normalizeProvider(provider);
    this.id = normalizeSandboxId(instance.id);
    if (typeof instance.wait !== "function" || typeof instance.kill !== "function") {
      throw new ConfigurationError("A sandbox background process requires wait and kill methods.");
    }
    this.#instance = instance;
  }

  get killed(): boolean {
    return this.#killPromise !== null;
  }

  async wait(options: SandboxOperationOptions = {}): Promise<SandboxCommandResult> {
    const result = await sandboxOperation(this.provider, "wait for process", () => (
      this.#instance.wait(signalOptions(options.signal))
    ));
    return validateCommandResult(this.provider, "wait for process", result);
  }

  kill(options: SandboxOperationOptions = {}): Promise<void> {
    if (this.#killPromise) return this.#killPromise;
    this.#killPromise = sandboxOperation(this.provider, "kill process", () => (
      this.#instance.kill(signalOptions(options.signal))
    ));
    return this.#killPromise;
  }
}

export class SandboxSession {
  readonly id: string;
  readonly provider: string;
  readonly capabilities: SandboxCapabilities;
  readonly leaseId: string | null;
  readonly #instance: SandboxInstance;
  readonly #onStopped: () => void | Promise<void>;
  readonly #authorization: SandboxCommandAuthorization | null;
  readonly #grants = new WeakSet<object>();
  #stopPromise: Promise<void> | null = null;

  constructor(
    provider: string,
    capabilities: SandboxCapabilities,
    instance: SandboxInstance,
    onStopped: () => void | Promise<void> = () => {},
    leaseId: string | null = null,
    authorization: SandboxCommandAuthorization | null = null,
  ) {
    this.provider = normalizeProvider(provider);
    this.capabilities = sandboxCapabilities(capabilities);
    this.id = normalizeSandboxId(instance.id);
    this.leaseId = leaseId;
    this.#instance = instance;
    this.#onStopped = onStopped;
    this.#authorization = authorization;
  }

  get stopped(): boolean {
    return this.#stopPromise !== null;
  }

  supports(capability: SandboxCapability): boolean {
    if (!SANDBOX_CAPABILITY_NAMES.includes(capability)) {
      throw new ConfigurationError(`Unknown sandbox capability: ${String(capability)}`);
    }
    return this.capabilities[capability];
  }

  async writeFiles(
    files: readonly SandboxFile[],
    options: SandboxOperationOptions = {},
  ): Promise<void> {
    this.#assertRunning();
    if (!Array.isArray(files) || files.length === 0) {
      throw new ConfigurationError("Sandbox file writes require at least one file.");
    }
    const normalized = files.map((file) => ({
      path: normalizeProjectPath(file.path),
      content: normalizeFileContent(file.content),
    }));
    await sandboxOperation(this.provider, "write files", () => (
      this.#instance.writeFiles(normalized, signalOptions(options.signal))
    ));
  }

  async authorizeCommand(
    command: SandboxCommand,
    action: "run" | "start" = "run",
  ): Promise<SandboxCommandGrant> {
    this.#assertRunning();
    const normalized = normalizeCommand(command);
    const proposedAction = await this.#authorize(action, normalized);
    const grant: SandboxCommandGrant = Object.freeze({ proposedAction });
    this.#grants.add(grant);
    return grant;
  }

  async run(
    command: SandboxCommand,
    grant?: SandboxCommandGrant,
  ): Promise<SandboxCommandResult> {
    this.#assertRunning();
    const normalized = normalizeCommand(command);
    if (grant) this.#consumeGrant("run", normalized, grant);
    else await this.#authorize("run", normalized);
    const result = await sandboxOperation(this.provider, "run command", () => (
      this.#instance.run(normalized)
    ));
    return validateCommandResult(this.provider, "run command", result);
  }

  async start(command: SandboxCommand, grant?: SandboxCommandGrant): Promise<SandboxProcess> {
    this.#assertRunning();
    if (!this.capabilities.backgroundProcesses || !this.#instance.start) {
      throw new SandboxUnavailableError(
        `Sandbox provider ${this.provider} does not support background processes.`,
      );
    }
    const normalized = normalizeCommand(command);
    if (grant) this.#consumeGrant("start", normalized, grant);
    else await this.#authorize("start", normalized);
    const process = await sandboxOperation(this.provider, "start process", () => (
      this.#instance.start!(normalized)
    ));
    return new SandboxProcess(this.provider, process);
  }

  async readFile(
    path: string,
    options: SandboxOperationOptions = {},
  ): Promise<Uint8Array> {
    this.#assertRunning();
    const content = await sandboxOperation(this.provider, "read file", () => (
      this.#instance.readFile(
        normalizeProjectPath(path),
        signalOptions(options.signal),
      )
    ));
    if (!(content instanceof Uint8Array)) {
      throw new SandboxError(
        this.provider,
        "read file",
        "The adapter returned invalid file content.",
      );
    }
    return content;
  }

  async url(port: number): Promise<string> {
    this.#assertRunning();
    const normalizedPort = normalizePort(port);
    if (!this.#instance.getUrl) {
      throw new SandboxUnavailableError(
        `Sandbox provider ${this.provider} does not support public port URLs.`,
      );
    }
    const value = await sandboxOperation(this.provider, "resolve port URL", () => (
      this.#instance.getUrl!(normalizedPort)
    ));
    try {
      const url = new URL(value);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        throw new TypeError("Sandbox URLs must use HTTP or HTTPS.");
      }
      return url.toString();
    } catch (error) {
      throw new SandboxError(
        this.provider,
        "resolve port URL",
        "The adapter returned an invalid URL.",
        { cause: error },
      );
    }
  }

  async waitForPort(port: number, options: SandboxReadinessOptions = {}): Promise<string> {
    this.#assertRunning();
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Sandbox readiness options must be an object.");
    }
    if (!this.capabilities.portUrls) {
      throw new SandboxUnavailableError(
        `Sandbox provider ${this.provider} does not support public port URLs.`,
      );
    }
    const timeoutMs = normalizeReadinessTimeout(options.timeoutMs);
    const intervalMs = normalizeReadinessInterval(options.intervalMs);
    const path = normalizeReadinessPath(options.path);
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort(new DOMException(
        `Sandbox port ${port} did not become ready within ${timeoutMs}ms.`,
        "TimeoutError",
      ));
    }, timeoutMs);
    const abort = () => controller.abort(options.signal?.reason);
    if (options.signal?.aborted) abort();
    else options.signal?.addEventListener("abort", abort, { once: true });
    try {
      while (true) {
        controller.signal.throwIfAborted();
        const baseUrl = await this.url(port);
        const target = new URL(path, baseUrl).toString();
        try {
          const ready = await (options.check ?? defaultReadinessCheck)(target, {
            signal: controller.signal,
          });
          if (ready) return target;
        } catch (error) {
          if (controller.signal.aborted) throw controller.signal.reason;
          // Connection and non-ready response failures are retried until the deadline.
        }
        await waitForReadiness(intervalMs, controller.signal);
      }
    } catch (error) {
      if (controller.signal.aborted && controller.signal.reason) throw controller.signal.reason;
      throw error;
    } finally {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abort);
    }
  }

  stop(options: SandboxOperationOptions = {}): Promise<void> {
    if (this.#stopPromise) return this.#stopPromise;
    this.#stopPromise = sandboxOperation(this.provider, "stop sandbox", () => (
      this.#instance.stop(signalOptions(options.signal))
    )).finally(this.#onStopped);
    return this.#stopPromise;
  }

  #assertRunning(): void {
    if (this.stopped) {
      throw new SandboxError(this.provider, "use sandbox", "The sandbox has been stopped.");
    }
  }

  async #authorize(
    action: "run" | "start",
    command: SandboxCommand,
  ): Promise<SandboxCommandProposedAction> {
    const proposedAction = createSandboxCommandProposedAction(
      this.provider,
      action,
      this.#authorization?.context ?? null,
      command,
    );
    if (!this.#authorization) return proposedAction;
    const request = this.#commandPolicyRequest(action, command);
    let rawDecision: SandboxCommandPolicyDecision;
    try {
      rawDecision = await this.#authorization.policy(request);
    } catch (error) {
      if (
        error instanceof SandboxCommandDeniedError
        || error instanceof SandboxCommandApprovalRequiredError
      ) throw error;
      throw new SandboxError(
        this.provider,
        "authorize command",
        `The command policy failed: ${errorMessage(error)}`,
        { cause: error },
      );
    }
    const decision = normalizeCommandPolicyDecision(rawDecision);
    if (!decision) {
      throw new SandboxError(
        this.provider,
        "authorize command",
        "The command policy returned an invalid decision.",
      );
    }
    if (decision.decision === "allow") return proposedAction;
    const reason = decision.reason?.trim();
    if (!reason || reason.length > 1_000) {
      throw new SandboxError(
        this.provider,
        "authorize command",
        `The command policy returned an invalid ${decision.decision} reason.`,
      );
    }
    if (decision.decision === "deny") {
      throw new SandboxCommandDeniedError(this.provider, action, reason);
    }
    if (this.#authorization.deniedActionKeys?.has(proposedAction.idempotencyKey)) {
      throw new SandboxCommandDeniedError(
        this.provider,
        action,
        "The proposed action was denied.",
      );
    }
    if (this.#authorization.approvedActionKeys?.has(proposedAction.idempotencyKey)) {
      return proposedAction;
    }
    throw new SandboxCommandApprovalRequiredError(proposedAction, reason);
  }

  #commandPolicyRequest(
    action: "run" | "start",
    command: SandboxCommand,
  ): SandboxCommandPolicyRequest {
    return {
      action,
      provider: this.provider,
      context: { ...this.#authorization!.context },
      command: {
        command: command.command,
        args: [...(command.args ?? [])],
        cwd: command.cwd ?? ".",
        environment: Object.keys(command.env ?? {}).sort(),
        timeoutMs: command.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
      },
    };
  }

  #consumeGrant(
    action: "run" | "start",
    command: SandboxCommand,
    grant: SandboxCommandGrant,
  ): void {
    const proposedAction = createSandboxCommandProposedAction(
      this.provider,
      action,
      this.#authorization?.context ?? null,
      command,
    );
    if (
      !this.#grants.has(grant)
      || grant.proposedAction.idempotencyKey !== proposedAction.idempotencyKey
    ) {
      throw new SandboxError(this.provider, "authorize command", "The command approval grant is invalid.");
    }
    this.#grants.delete(grant);
  }
}

function normalizeCommandPolicyDecision(
  decision: SandboxCommandPolicyDecision,
): Exclude<SandboxCommandPolicyDecision, { readonly allow: boolean }> | null {
  if (!decision || typeof decision !== "object" || Array.isArray(decision)) return null;
  if ("allow" in decision) {
    if (decision.allow === true) return { decision: "allow" };
    if (decision.allow === false) return { decision: "deny", reason: decision.reason };
    return null;
  }
  if (!["allow", "deny", "approval-required"].includes(decision.decision)) return null;
  return decision;
}

export function sandboxCommandProposedAction<Framework extends FrameworkId>(
  request: SandboxCommandPolicyRequest<Framework>,
): SandboxCommandProposedAction<Framework> {
  return createSandboxCommandProposedAction(
    request.provider,
    request.action,
    request.context,
    {
      command: request.command.command,
      args: request.command.args,
      cwd: request.command.cwd,
      env: Object.fromEntries(request.command.environment.map((name) => [name, ""])),
      timeoutMs: request.command.timeoutMs,
    },
  );
}

function createSandboxCommandProposedAction<Framework extends FrameworkId>(
  provider: string,
  action: "run" | "start",
  context: SandboxCreateContext<Framework> | null,
  input: SandboxCommand,
): SandboxCommandProposedAction<Framework> {
  const command = {
    command: input.command,
    args: [...(input.args ?? [])],
    cwd: input.cwd ?? ".",
    environment: Object.keys(input.env ?? {}).sort(),
    timeoutMs: input.timeoutMs ?? DEFAULT_SANDBOX_TIMEOUT_MS,
  };
  const canonical = JSON.stringify({
    provider,
    action,
    context,
    command,
  });
  return {
    type: "sandbox-command",
    idempotencyKey: `sandbox-command:${sha256(canonical)}`,
    provider,
    action,
    context: context ? { ...context } : null,
    command,
  };
}

export class SandboxRegistry {
  readonly #sessions = new Set<SandboxSession>();

  constructor(
    readonly store: SandboxLeaseStore,
    readonly policy?: SandboxCommandPolicy,
  ) {
    if (policy !== undefined && typeof policy !== "function") {
      throw new ConfigurationError("sandboxPolicy must be a function.");
    }
  }

  async get<Framework extends FrameworkId>(
    scope: UserScope,
    leaseId: string,
  ): Promise<SandboxLeaseData<Framework> | null> {
    return this.store.getSandboxLease<Framework>(scope, normalizeLeaseId(leaseId));
  }

  async open<Framework extends FrameworkId>(
    adapter: SandboxAdapter | undefined,
    scope: UserScope,
    version: {
      readonly id: string;
      readonly chatId: string;
      readonly framework: Framework;
    },
    files: readonly SandboxFile[],
    options: SandboxOpenOptions = {},
    resolvedActions: SandboxResolvedCommandActions = {},
  ): Promise<SandboxSession> {
    if (!adapter) {
      throw new SandboxUnavailableError(
        "No sandbox adapter is configured. Pass sandbox to createViby before running a version.",
      );
    }
    const normalized = normalizeOpenOptions(options);
    const createInput: SandboxCreateInput<Framework> = {
      context: {
        ...scope,
        chatId: version.chatId,
        versionId: version.id,
        framework: version.framework,
      },
      timeoutMs: normalized.timeoutMs,
      env: normalized.env,
      ports: normalized.ports,
      ...(normalized.signal ? { signal: normalized.signal } : {}),
    };
    const capabilities = sandboxCapabilities(adapter.capabilities);
    if (!capabilities.files || !capabilities.commands) {
      throw new ConfigurationError(
        "Sandbox adapters must support files and commands to materialize a Viby version.",
      );
    }
    const instance = await sandboxOperation(adapter.provider, "create sandbox", () => (
      adapter.create(createInput)
    ));
    const lease = await this.#createLease(scope, createInput, adapter.provider, instance);
    const session = this.#trackSession(
      adapter.provider,
      capabilities,
      instance,
      scope,
      lease.id,
      createInput.context,
      resolvedActions,
    );
    try {
      await session.writeFiles(files.map((file) => ({
        path: file.path,
        content: file.content,
      })), signalOptions(normalized.signal));
      return session;
    } catch (error) {
      try {
        await session.stop();
      } catch {
        // Preserve the materialization error; cleanup is best effort here.
      }
      throw error;
    }
  }

  async reconnect<Framework extends FrameworkId>(
    adapter: SandboxAdapter | undefined,
    scope: UserScope,
    leaseId: string,
    options: SandboxReconnectOptions = {},
  ): Promise<SandboxSession> {
    if (!adapter) {
      throw new SandboxUnavailableError(
        "No sandbox adapter is configured. Pass sandbox to createViby before reconnecting.",
      );
    }
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Sandbox reconnect options must be an object.");
    }
    const lease = await this.get<Framework>(scope, leaseId);
    if (!lease) throw new SandboxUnavailableError("The sandbox lease was not found.");
    if (lease.status !== "active") {
      throw new SandboxUnavailableError(`The sandbox lease is ${lease.status}.`);
    }
    if (lease.expiresAt.getTime() <= Date.now()) {
      await this.store.closeSandboxLease(scope, lease.id, "expired");
      throw new SandboxUnavailableError("The sandbox lease has expired.");
    }
    const provider = normalizeProvider(adapter.provider);
    if (provider !== lease.provider) {
      throw new SandboxUnavailableError(
        `Sandbox lease ${lease.id} belongs to ${lease.provider}, not ${provider}.`,
      );
    }
    const capabilities = sandboxCapabilities(adapter.capabilities);
    if (!capabilities.reconnect || !adapter.reconnect) {
      throw new SandboxUnavailableError(
        `Sandbox provider ${provider} does not support reconnecting by id.`,
      );
    }
    const instance = await sandboxOperation(provider, "reconnect sandbox", () => (
      adapter.reconnect!({
        sandboxId: lease.sandboxId,
        context: lease.context,
        ports: lease.ports,
        expiresAt: lease.expiresAt,
        ...(options.signal ? { signal: options.signal } : {}),
      })
    ));
    if (normalizeSandboxId(instance.id) !== lease.sandboxId) {
      throw new SandboxError(
        provider,
        "reconnect sandbox",
        "The adapter returned a different sandbox id than the persisted lease.",
      );
    }
    return this.#trackSession(
      provider,
      capabilities,
      instance,
      scope,
      lease.id,
      lease.context,
      {},
    );
  }

  async stopAll(): Promise<void> {
    const results = await Promise.allSettled([...this.#sessions].map((session) => session.stop()));
    const failure = results.find((result): result is PromiseRejectedResult => (
      result.status === "rejected"
    ));
    if (failure) throw failure.reason;
  }

  async #createLease<Framework extends FrameworkId>(
    scope: UserScope,
    input: SandboxCreateInput<Framework>,
    provider: string,
    instance: SandboxInstance,
  ): Promise<SandboxLeaseData<Framework>> {
    try {
      return await this.store.createSandboxLease(scope, {
        id: createId(),
        sandboxId: normalizeSandboxId(instance.id),
        provider: normalizeProvider(provider),
        context: input.context,
        ports: input.ports,
        expiresAt: new Date(Date.now() + input.timeoutMs),
      });
    } catch (error) {
      await sandboxOperation(provider, "stop sandbox", () => instance.stop()).catch(() => {});
      throw error;
    }
  }

  #trackSession(
    provider: string,
    capabilities: SandboxCapabilities,
    instance: SandboxInstance,
    scope: UserScope,
    leaseId: string,
    context: SandboxCreateContext,
    resolvedActions: SandboxResolvedCommandActions,
  ): SandboxSession {
    const session = new SandboxSession(provider, capabilities, instance, async () => {
      this.#sessions.delete(session);
      await this.store.closeSandboxLease(scope, leaseId, "stopped");
    }, leaseId, {
      policy: this.policy ?? (() => ({ decision: "allow" })),
      context,
      approvedActionKeys: new Set(resolvedActions.approvedActionKeys ?? []),
      deniedActionKeys: new Set(resolvedActions.deniedActionKeys ?? []),
    });
    this.#sessions.add(session);
    return session;
  }
}

function normalizeLeaseId(value: string): string {
  const normalized = normalizeSandboxId(value);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(normalized)) {
    throw new ConfigurationError("Sandbox lease id must be a UUID.");
  }
  return normalized;
}

function normalizePolicyStrings(
  values: readonly string[] | undefined,
  label: string,
): ReadonlySet<string> {
  if (values === undefined) return new Set();
  if (!Array.isArray(values)) {
    throw new ConfigurationError(`Sandbox command policy ${label} must be an array.`);
  }
  const normalized = values.map((value) => {
    const item = typeof value === "string" ? value.trim() : "";
    if (!item || item.length > 255 || /[\0\r\n]/.test(item)) {
      throw new ConfigurationError(`Sandbox command policy ${label} contains an invalid value.`);
    }
    return item;
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ConfigurationError(`Sandbox command policy ${label} cannot contain duplicates.`);
  }
  return new Set(normalized);
}

function normalizePolicyEnvironment(
  values: readonly string[] | undefined,
): ReadonlySet<string> | null {
  if (values === undefined) return null;
  const normalized = normalizePolicyStrings(values, "environment");
  for (const name of normalized) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new ConfigurationError(
        "Sandbox command policy environment contains an invalid variable name.",
      );
    }
  }
  return normalized;
}

function normalizePolicyLimit(
  value: number | undefined,
  minimum: number,
  maximum: number,
  label: string,
): number | null {
  if (value === undefined) return null;
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new ConfigurationError(
      `Sandbox command policy ${label} must be an integer between ${minimum} and ${maximum}.`,
    );
  }
  return value;
}

function normalizeOpenOptions(options: SandboxOpenOptions): {
  timeoutMs: number;
  env: Readonly<Record<string, string>>;
  ports: readonly number[];
  signal?: AbortSignal;
} {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Sandbox options must be an object.");
  }
  return {
    timeoutMs: normalizeTimeout(options.timeoutMs, "Sandbox timeout"),
    env: normalizeEnvironment(options.env),
    ports: normalizePorts(options.ports),
    ...(options.signal ? { signal: options.signal } : {}),
  };
}

function normalizeCommand(command: SandboxCommand): SandboxCommand {
  if (!command || typeof command !== "object") {
    throw new ConfigurationError("A sandbox command is required.");
  }
  const executable = command.command?.trim();
  if (!executable || executable.length > 512 || executable.includes("\0")) {
    throw new ConfigurationError("Sandbox command must contain between 1 and 512 characters.");
  }
  const args = command.args ?? [];
  if (!Array.isArray(args) || args.length > 1_000 || args.some((arg) => (
    typeof arg !== "string" || arg.length > 100_000 || arg.includes("\0")
  ))) {
    throw new ConfigurationError("Sandbox command arguments are invalid.");
  }
  if (command.onOutput !== undefined && typeof command.onOutput !== "function") {
    throw new ConfigurationError("Sandbox onOutput must be a function.");
  }
  const cwd = command.cwd === undefined || command.cwd === "."
    ? "."
    : normalizeProjectPath(command.cwd);
  return {
    command: executable,
    args: [...args],
    cwd,
    env: normalizeEnvironment(command.env),
    timeoutMs: normalizeTimeout(command.timeoutMs, "Command timeout"),
    ...(command.signal ? { signal: command.signal } : {}),
    ...(command.onOutput ? { onOutput: command.onOutput } : {}),
  };
}

function normalizeEnvironment(
  environment: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, string>> {
  if (environment === undefined) return {};
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new ConfigurationError("Sandbox environment variables must be an object.");
  }
  const entries = Object.entries(environment);
  if (entries.length > MAX_ENVIRONMENT_ENTRIES) {
    throw new ConfigurationError(
      `Sandbox environments cannot exceed ${MAX_ENVIRONMENT_ENTRIES} entries.`,
    );
  }
  const normalized: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof value !== "string" || value.includes("\0")) {
      throw new ConfigurationError(`Sandbox environment variable is invalid: ${key}`);
    }
    normalized[key] = value;
  }
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_ENVIRONMENT_BYTES) {
    throw new ConfigurationError(
      `Sandbox environments cannot exceed ${MAX_ENVIRONMENT_BYTES} bytes.`,
    );
  }
  return normalized;
}

function normalizePorts(ports: readonly number[] | undefined): readonly number[] {
  if (ports === undefined) return [];
  if (!Array.isArray(ports) || ports.length > MAX_PORTS) {
    throw new ConfigurationError(`Sandbox ports must contain at most ${MAX_PORTS} values.`);
  }
  const normalized = ports.map(normalizePort);
  if (new Set(normalized).size !== normalized.length) {
    throw new ConfigurationError("Sandbox ports cannot contain duplicates.");
  }
  return normalized;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigurationError("Sandbox ports must be integers between 1 and 65535.");
  }
  return port;
}

function normalizeTimeout(value: number | undefined, label: string): number {
  const timeout = value ?? DEFAULT_SANDBOX_TIMEOUT_MS;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_SANDBOX_TIMEOUT_MS) {
    throw new ConfigurationError(`${label} must be an integer between 1 and ${MAX_SANDBOX_TIMEOUT_MS} milliseconds.`);
  }
  return timeout;
}

function normalizeReadinessTimeout(value: number | undefined): number {
  const timeout = value ?? 30_000;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_SANDBOX_TIMEOUT_MS) {
    throw new ConfigurationError(
      `Sandbox readiness timeout must be an integer between 1 and ${MAX_SANDBOX_TIMEOUT_MS} milliseconds.`,
    );
  }
  return timeout;
}

function normalizeReadinessInterval(value: number | undefined): number {
  const interval = value ?? 250;
  if (!Number.isInteger(interval) || interval < 10 || interval > 60_000) {
    throw new ConfigurationError(
      "Sandbox readiness interval must be an integer between 10 and 60000 milliseconds.",
    );
  }
  return interval;
}

function normalizeReadinessPath(value: string | undefined): string {
  const path = value ?? "/";
  if (
    !path.startsWith("/")
    || path.startsWith("//")
    || path.includes("\\")
    || path.length > 2_000
    || path.includes("\0")
  ) {
    throw new ConfigurationError("Sandbox readiness path must be an absolute URL path.");
  }
  return path;
}

function normalizeFileContent(content: string | Uint8Array): string | Uint8Array {
  if (typeof content === "string") return content;
  if (content instanceof Uint8Array) return new Uint8Array(content);
  throw new ConfigurationError("Sandbox file content must be a string or Uint8Array.");
}

function normalizeProvider(value: string): string {
  const provider = value?.trim();
  if (!provider || provider.length > 100) {
    throw new ConfigurationError("Sandbox adapter provider must contain between 1 and 100 characters.");
  }
  return provider;
}

function normalizeSandboxId(value: string): string {
  const id = value?.trim();
  if (!id || id.length > 255) {
    throw new ConfigurationError("Sandbox instance ID must contain between 1 and 255 characters.");
  }
  return id;
}

function validateCommandResult(
  provider: string,
  operation: string,
  result: SandboxCommandResult,
): SandboxCommandResult {
  if (
    !result
    || !Number.isInteger(result.exitCode)
    || typeof result.stdout !== "string"
    || typeof result.stderr !== "string"
    || !Number.isFinite(result.durationMs)
    || result.durationMs < 0
  ) {
    throw new SandboxError(
      provider,
      operation,
      "The adapter returned an invalid command result.",
    );
  }
  return result;
}

async function defaultReadinessCheck(
  url: string,
  options: { readonly signal: AbortSignal },
): Promise<boolean> {
  const response = await fetch(url, {
    method: "GET",
    redirect: "manual",
    signal: options.signal,
  });
  await response.body?.cancel().catch(() => undefined);
  return response.status >= 200 && response.status < 400;
}

function waitForReadiness(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const timeout = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    const abort = () => {
      clearTimeout(timeout);
      reject(signal.reason);
    };
    signal.addEventListener("abort", abort, { once: true });
  });
}

function signalOptions(signal: AbortSignal | undefined): SandboxOperationOptions {
  return signal ? { signal } : {};
}

async function sandboxOperation<Value>(
  providerValue: string,
  operation: string,
  action: () => Value | Promise<Value>,
): Promise<Value> {
  const provider = normalizeProvider(providerValue);
  try {
    return await action();
  } catch (error) {
    if (error instanceof ConfigurationError || error instanceof SandboxError) throw error;
    throw new SandboxError(provider, operation, errorMessage(error), { cause: error });
  }
}
