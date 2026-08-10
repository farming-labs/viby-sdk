import { ConfigurationError, BrowserError } from "./errors.js";
import type { UserScope } from "./types.js";
import { assertIdentifier, errorMessage } from "./utils.js";

const MAX_BROWSER_TIMEOUT_MS = 300_000;
const MAX_DOM_CHARS = 2_000_000;

export interface BrowserOwnershipContext extends UserScope {
  readonly chatId?: string;
  readonly versionId?: string;
  readonly sandboxId?: string;
}

export interface BrowserViewport {
  readonly width: number;
  readonly height: number;
  readonly deviceScaleFactor?: number;
}

export interface BrowserOpenInput {
  readonly baseUrl: string;
  readonly context?: BrowserOwnershipContext;
  readonly viewport?: BrowserViewport;
  readonly allowExternalNavigation?: boolean;
  readonly signal?: AbortSignal;
}

export type BrowserWaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

export interface BrowserNavigationInput {
  /** Absolute HTTP(S) URL or a path resolved against the session base URL. */
  readonly url: string;
  readonly waitUntil?: BrowserWaitUntil;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserNavigationResult {
  readonly url: string;
  readonly title: string;
  readonly status: number | null;
}

export interface BrowserScreenshotOptions {
  readonly format?: "png" | "jpeg";
  readonly fullPage?: boolean;
  readonly quality?: number;
  readonly selector?: string;
  readonly signal?: AbortSignal;
}

export interface BrowserScreenshot {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly url: string;
}

export interface BrowserDomInspectionOptions {
  readonly selector?: string;
  readonly maxChars?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserDomSnapshot {
  readonly url: string;
  readonly title: string;
  readonly html: string;
  readonly text: string;
}

export interface BrowserConsoleError {
  readonly message: string;
  readonly url: string | null;
  readonly line: number | null;
  readonly column: number | null;
  readonly timestamp: Date;
}

export interface BrowserAccessibilityNode {
  readonly selector: string | null;
  readonly html: string | null;
  readonly summary: string;
}

export type BrowserAccessibilityImpact =
  | "minor"
  | "moderate"
  | "serious"
  | "critical"
  | "unknown";

export interface BrowserAccessibilityIssue {
  readonly id: string;
  readonly impact: BrowserAccessibilityImpact;
  readonly message: string;
  readonly helpUrl: string | null;
  readonly nodes: readonly BrowserAccessibilityNode[];
}

export interface BrowserAccessibilityReport {
  readonly url: string;
  readonly passed: boolean;
  readonly issues: readonly BrowserAccessibilityIssue[];
}

export interface BrowserAccessibilityOptions {
  readonly selector?: string;
  readonly rules?: readonly string[];
  readonly signal?: AbortSignal;
}

export interface BrowserReadinessOptions {
  readonly url?: string;
  readonly selector?: string;
  readonly state?: "attached" | "visible";
  readonly waitUntil?: BrowserWaitUntil;
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface BrowserReadinessResult {
  readonly url: string;
  readonly readyAt: Date;
}

export interface BrowserInstance {
  readonly id: string;
  navigate(input: BrowserNavigationInput): Promise<BrowserNavigationResult>;
  screenshot(options?: BrowserScreenshotOptions): Promise<BrowserScreenshot>;
  inspect(options?: BrowserDomInspectionOptions): Promise<BrowserDomSnapshot>;
  consoleErrors(options?: { readonly signal?: AbortSignal }): Promise<readonly BrowserConsoleError[]>;
  accessibility(options?: BrowserAccessibilityOptions): Promise<BrowserAccessibilityReport>;
  waitForReady(options?: BrowserReadinessOptions): Promise<BrowserReadinessResult>;
  close(options?: { readonly signal?: AbortSignal }): Promise<void>;
}

export interface BrowserAdapter {
  readonly provider: string;
  open(input: BrowserOpenInput): Promise<BrowserInstance>;
}

/** Validated provider-neutral browser session with same-origin navigation by default. */
export class BrowserSession {
  readonly provider: string;
  readonly id: string;
  readonly baseUrl: string;
  readonly #instance: BrowserInstance;
  readonly #allowExternalNavigation: boolean;
  #closePromise: Promise<void> | null = null;

  constructor(provider: string, input: BrowserOpenInput, instance: BrowserInstance) {
    this.provider = normalizeBrowserId(provider, "provider");
    this.id = normalizeBrowserId(instance?.id, "session id");
    this.baseUrl = normalizeHttpUrl(input.baseUrl, "Browser base URL");
    this.#allowExternalNavigation = input.allowExternalNavigation === true;
    assertBrowserInstance(instance);
    this.#instance = instance;
  }

  get closed(): boolean { return this.#closePromise !== null; }

  async navigate(input: BrowserNavigationInput | string): Promise<BrowserNavigationResult> {
    this.#assertOpen();
    const normalized = normalizeNavigationInput(input, this.baseUrl, this.#allowExternalNavigation);
    const result = validateNavigation(await browserOperation(this.provider, "navigate", () => (
      this.#instance.navigate(normalized)
    )));
    this.#assertAllowedResultUrl(result.url, "navigation redirected outside the session origin");
    return result;
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshot> {
    this.#assertOpen();
    const normalized = normalizeScreenshotOptions(options);
    const result = validateScreenshot(await browserOperation(this.provider, "capture a screenshot", () => (
      this.#instance.screenshot(normalized)
    )), normalized.format ?? "png");
    this.#assertAllowedResultUrl(result.url, "screenshot resolved outside the session origin");
    return result;
  }

  async inspect(options: BrowserDomInspectionOptions = {}): Promise<BrowserDomSnapshot> {
    this.#assertOpen();
    const normalized = normalizeInspectionOptions(options);
    const result = validateDomSnapshot(await browserOperation(this.provider, "inspect the DOM", () => (
      this.#instance.inspect(normalized)
    )), normalized.maxChars ?? MAX_DOM_CHARS);
    this.#assertAllowedResultUrl(result.url, "DOM inspection resolved outside the session origin");
    return result;
  }

  async consoleErrors(options: { readonly signal?: AbortSignal } = {}): Promise<readonly BrowserConsoleError[]> {
    this.#assertOpen();
    const errors = await browserOperation(this.provider, "read console errors", () => (
      this.#instance.consoleErrors(signalOptions(options.signal))
    ));
    if (!Array.isArray(errors) || errors.length > 1_000) {
      throw new BrowserError(this.provider, "read console errors", "The adapter returned an invalid error list.");
    }
    return Object.freeze(errors.map(validateConsoleError));
  }

  async accessibility(options: BrowserAccessibilityOptions = {}): Promise<BrowserAccessibilityReport> {
    this.#assertOpen();
    const normalized = normalizeAccessibilityOptions(options);
    const result = validateAccessibilityReport(await browserOperation(
      this.provider,
      "run accessibility checks",
      () => this.#instance.accessibility(normalized),
    ));
    this.#assertAllowedResultUrl(result.url, "accessibility checks resolved outside the session origin");
    return result;
  }

  async waitForReady(options: BrowserReadinessOptions = {}): Promise<BrowserReadinessResult> {
    this.#assertOpen();
    const normalized = normalizeReadinessOptions(
      options,
      this.baseUrl,
      this.#allowExternalNavigation,
    );
    const result = validateReadiness(await browserOperation(this.provider, "wait for readiness", () => (
      this.#instance.waitForReady(normalized)
    )));
    this.#assertAllowedResultUrl(result.url, "readiness resolved outside the session origin");
    return result;
  }

  close(options: { readonly signal?: AbortSignal } = {}): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = browserOperation(this.provider, "close the browser", () => (
      this.#instance.close(signalOptions(options.signal))
    ));
    return this.#closePromise;
  }

  #assertOpen(): void {
    if (this.closed) throw new BrowserError(this.provider, "use the browser", "The session is closed.");
  }

  #assertAllowedResultUrl(value: string, operation: string): void {
    if (!this.#allowExternalNavigation && new URL(value).origin !== new URL(this.baseUrl).origin) {
      throw new BrowserError(this.provider, operation, "External navigation is disabled.");
    }
  }
}

export async function openBrowserSession(
  adapter: BrowserAdapter,
  input: BrowserOpenInput,
): Promise<BrowserSession> {
  if (!adapter || typeof adapter !== "object" || typeof adapter.open !== "function") {
    throw new ConfigurationError("A browser adapter with open(input) is required.");
  }
  const provider = normalizeBrowserId(adapter.provider, "provider");
  const normalized = normalizeOpenInput(input);
  const instance = await browserOperation(provider, "open a browser", () => adapter.open(normalized));
  try {
    return new BrowserSession(provider, normalized, instance);
  } catch (error) {
    await Promise.resolve(instance?.close?.()).catch(() => undefined);
    throw error;
  }
}

function normalizeOpenInput(input: BrowserOpenInput): BrowserOpenInput {
  if (!input || typeof input !== "object") throw new ConfigurationError("Browser open input is required.");
  const viewport = input.viewport ? normalizeViewport(input.viewport) : undefined;
  return {
    baseUrl: normalizeHttpUrl(input.baseUrl, "Browser base URL"),
    ...(input.context ? { context: normalizeOwnershipContext(input.context) } : {}),
    ...(viewport ? { viewport } : {}),
    ...(input.allowExternalNavigation ? { allowExternalNavigation: true } : {}),
    ...signalOptions(input.signal),
  };
}

function normalizeNavigationInput(
  value: BrowserNavigationInput | string,
  baseUrl: string,
  allowExternal: boolean,
): BrowserNavigationInput {
  const input = typeof value === "string" ? { url: value } : value;
  if (!input || typeof input !== "object") throw new ConfigurationError("Browser navigation input is required.");
  return {
    url: resolveNavigationUrl(input.url, baseUrl, allowExternal),
    ...(input.waitUntil ? { waitUntil: normalizeWaitUntil(input.waitUntil) } : {}),
    ...(input.timeoutMs === undefined ? {} : { timeoutMs: normalizeTimeout(input.timeoutMs) }),
    ...signalOptions(input.signal),
  };
}

function normalizeScreenshotOptions(options: BrowserScreenshotOptions): BrowserScreenshotOptions {
  if (!options || typeof options !== "object") throw new ConfigurationError("Screenshot options must be an object.");
  const format = options.format ?? "png";
  if (format !== "png" && format !== "jpeg") throw new ConfigurationError("Screenshot format must be png or jpeg.");
  if (options.quality !== undefined && (
    !Number.isInteger(options.quality) || options.quality < 1 || options.quality > 100 || format !== "jpeg"
  )) throw new ConfigurationError("Screenshot quality must be 1-100 and is only valid for jpeg.");
  if (options.fullPage && options.selector) {
    throw new ConfigurationError("Screenshot selector and fullPage cannot be used together.");
  }
  return {
    format,
    fullPage: options.fullPage === true,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.selector ? { selector: normalizeSelector(options.selector) } : {}),
    ...signalOptions(options.signal),
  };
}

function normalizeInspectionOptions(options: BrowserDomInspectionOptions): BrowserDomInspectionOptions {
  if (!options || typeof options !== "object") throw new ConfigurationError("DOM inspection options must be an object.");
  const maxChars = options.maxChars ?? MAX_DOM_CHARS;
  if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > MAX_DOM_CHARS) {
    throw new ConfigurationError(`DOM maxChars must be an integer between 1 and ${MAX_DOM_CHARS}.`);
  }
  return {
    maxChars,
    ...(options.selector ? { selector: normalizeSelector(options.selector) } : {}),
    ...signalOptions(options.signal),
  };
}

function normalizeAccessibilityOptions(options: BrowserAccessibilityOptions): BrowserAccessibilityOptions {
  if (!options || typeof options !== "object") throw new ConfigurationError("Accessibility options must be an object.");
  if (options.rules !== undefined && (!Array.isArray(options.rules) || options.rules.length > 100)) {
    throw new ConfigurationError("Accessibility rules must contain at most 100 ids.");
  }
  const rules = options.rules?.map((rule) => normalizeBrowserId(rule, "accessibility rule"));
  if (rules && new Set(rules).size !== rules.length) {
    throw new ConfigurationError("Accessibility rules cannot contain duplicates.");
  }
  return {
    ...(options.selector ? { selector: normalizeSelector(options.selector) } : {}),
    ...(rules ? { rules: Object.freeze(rules) } : {}),
    ...signalOptions(options.signal),
  };
}

function normalizeReadinessOptions(
  options: BrowserReadinessOptions,
  baseUrl: string,
  allowExternal: boolean,
): BrowserReadinessOptions {
  if (!options || typeof options !== "object") throw new ConfigurationError("Browser readiness options must be an object.");
  if (options.state !== undefined && options.state !== "attached" && options.state !== "visible") {
    throw new ConfigurationError("Browser readiness state must be attached or visible.");
  }
  return {
    ...(options.url ? { url: resolveNavigationUrl(options.url, baseUrl, allowExternal) } : {}),
    ...(options.selector ? { selector: normalizeSelector(options.selector) } : {}),
    ...(options.state ? { state: options.state } : {}),
    ...(options.waitUntil ? { waitUntil: normalizeWaitUntil(options.waitUntil) } : {}),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: normalizeTimeout(options.timeoutMs) }),
    ...signalOptions(options.signal),
  };
}

function normalizeViewport(value: BrowserViewport): BrowserViewport {
  if (!Number.isInteger(value.width) || value.width < 1 || value.width > 10_000) {
    throw new ConfigurationError("Browser viewport width must be an integer between 1 and 10000.");
  }
  if (!Number.isInteger(value.height) || value.height < 1 || value.height > 10_000) {
    throw new ConfigurationError("Browser viewport height must be an integer between 1 and 10000.");
  }
  const scale = value.deviceScaleFactor ?? 1;
  if (!Number.isFinite(scale) || scale < 0.1 || scale > 10) {
    throw new ConfigurationError("Browser deviceScaleFactor must be between 0.1 and 10.");
  }
  return Object.freeze({ width: value.width, height: value.height, deviceScaleFactor: scale });
}

function normalizeOwnershipContext(value: BrowserOwnershipContext): BrowserOwnershipContext {
  if (!value || typeof value !== "object") {
    throw new ConfigurationError("Browser ownership context must be an object.");
  }
  return Object.freeze({
    tenantId: assertIdentifier(value.tenantId, "Browser context tenantId"),
    userId: assertIdentifier(value.userId, "Browser context userId"),
    ...(value.chatId ? { chatId: assertIdentifier(value.chatId, "Browser context chatId") } : {}),
    ...(value.versionId ? { versionId: assertIdentifier(value.versionId, "Browser context versionId") } : {}),
    ...(value.sandboxId ? { sandboxId: assertIdentifier(value.sandboxId, "Browser context sandboxId") } : {}),
  });
}

function resolveNavigationUrl(value: string, baseUrl: string, allowExternal: boolean): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError("Browser navigation URL is required.");
  }
  let url: URL;
  try { url = new URL(value, baseUrl); } catch { throw new ConfigurationError("Browser navigation URL is invalid."); }
  if (!allowExternal && url.origin !== new URL(baseUrl).origin) {
    throw new ConfigurationError("Browser navigation must remain on the session origin.");
  }
  return normalizeHttpUrl(url.toString(), "Browser navigation URL");
}

function normalizeHttpUrl(value: string, label: string): string {
  if (typeof value !== "string") throw new ConfigurationError(`${label} must be a string.`);
  let url: URL;
  try { url = new URL(value); } catch { throw new ConfigurationError(`${label} is invalid.`); }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) {
    throw new ConfigurationError(`${label} must be an HTTP(S) URL without embedded credentials.`);
  }
  url.hash = "";
  return url.toString();
}

function normalizeWaitUntil(value: BrowserWaitUntil): BrowserWaitUntil {
  if (!["commit", "domcontentloaded", "load", "networkidle"].includes(value)) {
    throw new ConfigurationError("Browser waitUntil is invalid.");
  }
  return value;
}

function normalizeTimeout(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > MAX_BROWSER_TIMEOUT_MS) {
    throw new ConfigurationError(`Browser timeout must be an integer between 1 and ${MAX_BROWSER_TIMEOUT_MS}.`);
  }
  return value;
}

function normalizeSelector(value: string): string {
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 2_000) {
    throw new ConfigurationError("Browser selector must contain 1-2000 characters.");
  }
  return value.trim();
}

function normalizeBrowserId(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/.test(value.trim())) {
    throw new ConfigurationError(`Browser ${label} must contain 1-200 safe identifier characters.`);
  }
  return value.trim();
}

function assertBrowserInstance(instance: BrowserInstance): void {
  const methods: Array<keyof BrowserInstance> = [
    "navigate", "screenshot", "inspect", "consoleErrors", "accessibility", "waitForReady", "close",
  ];
  if (!instance || methods.some((method) => typeof instance[method] !== "function")) {
    throw new ConfigurationError("A browser instance must implement every portable browser operation.");
  }
}

function validateNavigation(value: BrowserNavigationResult): BrowserNavigationResult {
  const status = value?.status;
  if (status !== null && (!Number.isInteger(status) || status < 100 || status > 599)) {
    throw new ConfigurationError("Browser adapter returned an invalid navigation status.");
  }
  return Object.freeze({
    url: normalizeHttpUrl(value?.url, "Browser navigation result URL"),
    title: typeof value?.title === "string" ? value.title : "",
    status,
  });
}

function validateScreenshot(value: BrowserScreenshot, format: "png" | "jpeg"): BrowserScreenshot {
  const mediaType = format === "png" ? "image/png" : "image/jpeg";
  if (!(value?.bytes instanceof Uint8Array) || value.bytes.byteLength === 0 || value.mediaType !== mediaType) {
    throw new ConfigurationError("Browser adapter returned invalid screenshot bytes or media type.");
  }
  if (!Number.isInteger(value.width) || value.width < 1 || !Number.isInteger(value.height) || value.height < 1) {
    throw new ConfigurationError("Browser adapter returned invalid screenshot dimensions.");
  }
  return Object.freeze({
    bytes: Uint8Array.from(value.bytes),
    mediaType,
    width: value.width,
    height: value.height,
    url: normalizeHttpUrl(value.url, "Screenshot URL"),
  });
}

function validateDomSnapshot(value: BrowserDomSnapshot, maxChars: number): BrowserDomSnapshot {
  if (typeof value?.html !== "string" || typeof value.text !== "string") {
    throw new ConfigurationError("Browser adapter returned an invalid DOM snapshot.");
  }
  if (value.html.length > maxChars || value.text.length > maxChars) {
    throw new ConfigurationError(`Browser adapter exceeded the requested DOM limit of ${maxChars} characters.`);
  }
  return Object.freeze({
    url: normalizeHttpUrl(value.url, "DOM snapshot URL"),
    title: typeof value.title === "string" ? value.title : "",
    html: value.html,
    text: value.text,
  });
}

function validateConsoleError(value: BrowserConsoleError): BrowserConsoleError {
  if (typeof value?.message !== "string" || value.message.length === 0 || !(value.timestamp instanceof Date)) {
    throw new ConfigurationError("Browser adapter returned an invalid console error.");
  }
  return Object.freeze({
    message: value.message,
    url: value.url === null ? null : normalizeHttpUrl(value.url, "Console error URL"),
    line: normalizeNullableCoordinate(value.line),
    column: normalizeNullableCoordinate(value.column),
    timestamp: new Date(value.timestamp),
  });
}

function validateAccessibilityReport(value: BrowserAccessibilityReport): BrowserAccessibilityReport {
  if (!value || typeof value !== "object" || !Array.isArray(value.issues)) {
    throw new ConfigurationError("Browser adapter returned an invalid accessibility report.");
  }
  const issues = value.issues.map((issue) => {
    if (
      typeof issue.id !== "string" || issue.id.length === 0
      || typeof issue.message !== "string" || issue.message.length === 0
      || !["minor", "moderate", "serious", "critical", "unknown"].includes(issue.impact)
      || !Array.isArray(issue.nodes) || issue.nodes.length > 1_000
    ) throw new ConfigurationError("Browser adapter returned an invalid accessibility issue.");
    const nodes = issue.nodes.map((node: BrowserAccessibilityNode) => {
      if (
        !node || typeof node !== "object"
        || (node.selector !== null && typeof node.selector !== "string")
        || (node.html !== null && typeof node.html !== "string")
        || typeof node.summary !== "string" || node.summary.length === 0
      ) throw new ConfigurationError("Browser adapter returned an invalid accessibility node.");
      return Object.freeze({ ...node });
    });
    return Object.freeze({
      id: normalizeBrowserId(issue.id, "accessibility issue"),
      impact: issue.impact,
      message: issue.message,
      helpUrl: issue.helpUrl === null
        ? null
        : normalizeHttpUrl(issue.helpUrl, "Accessibility help URL"),
      nodes: Object.freeze(nodes),
    });
  });
  return Object.freeze({
    url: normalizeHttpUrl(value.url, "Accessibility report URL"),
    passed: issues.length === 0,
    issues: Object.freeze(issues),
  });
}

function validateReadiness(value: BrowserReadinessResult): BrowserReadinessResult {
  if (!(value?.readyAt instanceof Date) || Number.isNaN(value.readyAt.getTime())) {
    throw new ConfigurationError("Browser adapter returned an invalid readiness timestamp.");
  }
  return Object.freeze({
    url: normalizeHttpUrl(value.url, "Browser readiness URL"),
    readyAt: new Date(value.readyAt),
  });
}

function normalizeNullableCoordinate(value: number | null): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || value < 0) {
    throw new ConfigurationError("Browser console coordinates must be non-negative integers.");
  }
  return value;
}

function signalOptions(signal: AbortSignal | undefined): { readonly signal?: AbortSignal } {
  signal?.throwIfAborted();
  return signal ? { signal } : {};
}

async function browserOperation<T>(
  provider: string,
  operation: string,
  run: () => Promise<T>,
): Promise<T> {
  try { return await run(); } catch (error) {
    if (error instanceof BrowserError || error instanceof ConfigurationError) throw error;
    throw new BrowserError(provider, operation, errorMessage(error), { cause: error });
  }
}
