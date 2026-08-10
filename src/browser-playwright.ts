import { AxeBuilder } from "@axe-core/playwright";
import {
  chromium,
  firefox,
  webkit,
  type Browser,
  type BrowserContext,
  type BrowserType,
  type Page,
} from "playwright";
import type {
  BrowserAccessibilityImpact,
  BrowserAccessibilityOptions,
  BrowserAccessibilityReport,
  BrowserAdapter,
  BrowserConsoleError,
  BrowserDomInspectionOptions,
  BrowserDomSnapshot,
  BrowserInstance,
  BrowserNavigationInput,
  BrowserNavigationResult,
  BrowserOpenInput,
  BrowserReadinessOptions,
  BrowserReadinessResult,
  BrowserScreenshot,
  BrowserScreenshotOptions,
} from "./browser.js";
import { ConfigurationError } from "./errors.js";

export type PlaywrightBrowserName = "chromium" | "firefox" | "webkit";

export interface PlaywrightLaunchOptions {
  readonly headless?: boolean;
  readonly executablePath?: string;
  readonly channel?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

export interface PlaywrightContextOptions {
  readonly ignoreHTTPSErrors?: boolean;
  readonly locale?: string;
  readonly timezoneId?: string;
  readonly colorScheme?: "light" | "dark" | "no-preference";
  readonly reducedMotion?: "reduce" | "no-preference";
}

export interface PlaywrightBrowserAdapterOptions {
  readonly browserName?: PlaywrightBrowserName;
  /** Host-owned shared browser. Viby closes only the isolated context it creates. */
  readonly browser?: Browser;
  readonly launch?: PlaywrightLaunchOptions;
  readonly context?: PlaywrightContextOptions;
  /** Optional axe tags applied before request-specific rule selection. */
  readonly accessibilityTags?: readonly string[];
}

/** Creates a practical adapter for the provider-neutral browser contract. */
export function playwrightBrowser(
  options: PlaywrightBrowserAdapterOptions = {},
): BrowserAdapter {
  const normalized = normalizeOptions(options);
  return {
    provider: `playwright-${normalized.browserName}`,
    async open(input) {
      input.signal?.throwIfAborted();
      const owned = normalized.browser === undefined;
      const browser = normalized.browser ?? await launchBrowser(normalized);
      let context: BrowserContext | undefined;
      try {
        input.signal?.throwIfAborted();
        context = await browser.newContext({
          baseURL: input.baseUrl,
          ...(input.viewport ? {
            viewport: { width: input.viewport.width, height: input.viewport.height },
            deviceScaleFactor: input.viewport.deviceScaleFactor,
          } : {}),
          ...normalized.context,
        });
        const page = await context.newPage();
        input.signal?.throwIfAborted();
        await enforceNavigationOrigin(page, input.baseUrl, input.allowExternalNavigation === true);
        return new PlaywrightBrowserInstance(
          browser,
          context,
          page,
          owned,
          normalized.accessibilityTags,
        );
      } catch (error) {
        await context?.close().catch(() => undefined);
        if (owned) await browser.close().catch(() => undefined);
        throw error;
      }
    },
  };
}

interface NormalizedPlaywrightOptions {
  readonly browserName: PlaywrightBrowserName;
  readonly browser?: Browser;
  readonly launch: {
    readonly headless: boolean;
    readonly executablePath?: string;
    readonly channel?: string;
    readonly args?: string[];
    readonly timeout?: number;
  };
  readonly context: PlaywrightContextOptions;
  readonly accessibilityTags?: readonly string[];
}

class PlaywrightBrowserInstance implements BrowserInstance {
  readonly id = crypto.randomUUID();
  readonly #browser: Browser;
  readonly #context: BrowserContext;
  readonly #page: Page;
  readonly #owned: boolean;
  readonly #accessibilityTags: readonly string[] | undefined;
  readonly #consoleErrors: BrowserConsoleError[] = [];
  #closePromise: Promise<void> | null = null;

  constructor(
    browser: Browser,
    context: BrowserContext,
    page: Page,
    owned: boolean,
    accessibilityTags: readonly string[] | undefined,
  ) {
    this.#browser = browser;
    this.#context = context;
    this.#page = page;
    this.#owned = owned;
    this.#accessibilityTags = accessibilityTags;
    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const location = message.location();
      this.#consoleErrors.push({
        message: message.text(),
        url: httpUrlOrNull(location.url),
        line: coordinateOrNull(location.line),
        column: coordinateOrNull(location.column),
        timestamp: new Date(message.timestamp()),
      });
    });
    page.on("pageerror", (error) => {
      this.#consoleErrors.push({
        message: error.message,
        url: httpUrlOrNull(page.url()),
        line: null,
        column: null,
        timestamp: new Date(),
      });
    });
  }

  async navigate(input: BrowserNavigationInput): Promise<BrowserNavigationResult> {
    const response = await this.#page.goto(input.url, {
      ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
      ...(input.timeoutMs === undefined ? {} : { timeout: input.timeoutMs }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return {
      url: this.#page.url(),
      title: await this.#page.title(),
      status: response?.status() ?? null,
    };
  }

  async screenshot(options: BrowserScreenshotOptions = {}): Promise<BrowserScreenshot> {
    options.signal?.throwIfAborted();
    const format = options.format ?? "png";
    const screenshotOptions = {
      type: format,
      ...(options.quality === undefined ? {} : { quality: options.quality }),
      ...(options.signal ? { signal: options.signal } : {}),
    } as const;
    const bytes = options.selector
      ? await this.#page.locator(options.selector).first().screenshot(screenshotOptions)
      : await this.#page.screenshot({
        ...screenshotOptions,
        ...(options.fullPage === undefined ? {} : { fullPage: options.fullPage }),
      });
    const dimensions = imageDimensions(bytes, format);
    return {
      bytes: Uint8Array.from(bytes),
      mediaType: format === "png" ? "image/png" : "image/jpeg",
      ...dimensions,
      url: this.#page.url(),
    };
  }

  async inspect(options: BrowserDomInspectionOptions = {}): Promise<BrowserDomSnapshot> {
    options.signal?.throwIfAborted();
    const locator = options.selector
      ? this.#page.locator(options.selector).first()
      : this.#page.locator("html");
    await locator.waitFor({
      state: "attached",
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const snapshot = await locator.evaluate<{ html: string; text: string }, undefined>((element) => ({
      html: element.outerHTML,
      text: element.textContent ?? "",
    }), undefined, options.signal ? { signal: options.signal } : {});
    const maxChars = options.maxChars ?? 2_000_000;
    return {
      url: this.#page.url(),
      title: await this.#page.title(),
      html: snapshot.html.slice(0, maxChars),
      text: snapshot.text.slice(0, maxChars),
    };
  }

  async consoleErrors(options: { readonly signal?: AbortSignal } = {}): Promise<readonly BrowserConsoleError[]> {
    options.signal?.throwIfAborted();
    return this.#consoleErrors.map((error) => ({ ...error, timestamp: new Date(error.timestamp) }));
  }

  async accessibility(options: BrowserAccessibilityOptions = {}): Promise<BrowserAccessibilityReport> {
    options.signal?.throwIfAborted();
    let builder = new AxeBuilder({ page: this.#page });
    if (this.#accessibilityTags) builder = builder.withTags([...this.#accessibilityTags]);
    if (options.selector) builder = builder.include(options.selector);
    if (options.rules) builder = builder.withRules([...options.rules]);
    const result = await builder.analyze();
    options.signal?.throwIfAborted();
    const issues = result.violations.map((violation) => ({
      id: violation.id,
      impact: normalizeImpact(violation.impact),
      message: violation.help,
      helpUrl: violation.helpUrl || null,
      nodes: violation.nodes.map((node) => ({
        selector: axeTarget(node.target),
        html: node.html || null,
        summary: node.failureSummary || violation.description,
      })),
    }));
    return { url: this.#page.url(), passed: issues.length === 0, issues };
  }

  async waitForReady(options: BrowserReadinessOptions = {}): Promise<BrowserReadinessResult> {
    if (options.url) {
      await this.#page.goto(options.url, {
        ...(options.waitUntil ? { waitUntil: options.waitUntil } : {}),
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } else if (options.waitUntil && options.waitUntil !== "commit") {
      await this.#page.waitForLoadState(options.waitUntil, {
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    } else {
      options.signal?.throwIfAborted();
    }
    if (options.selector) {
      await this.#page.locator(options.selector).first().waitFor({
        state: options.state ?? "visible",
        ...(options.timeoutMs === undefined ? {} : { timeout: options.timeoutMs }),
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    return { url: this.#page.url(), readyAt: new Date() };
  }

  close(): Promise<void> {
    if (this.#closePromise) return this.#closePromise;
    this.#closePromise = this.#context.close().finally(async () => {
      if (this.#owned) await this.#browser.close();
    });
    return this.#closePromise;
  }
}

async function launchBrowser(options: NormalizedPlaywrightOptions): Promise<Browser> {
  const browserType: BrowserType = { chromium, firefox, webkit }[options.browserName];
  return browserType.launch(options.launch);
}

async function enforceNavigationOrigin(
  page: Page,
  baseUrl: string,
  allowExternalNavigation: boolean,
): Promise<void> {
  if (allowExternalNavigation) return;
  const origin = new URL(baseUrl).origin;
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (
      request.isNavigationRequest()
      && request.frame() === page.mainFrame()
      && new URL(request.url()).origin !== origin
    ) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}

function normalizeOptions(options: PlaywrightBrowserAdapterOptions): NormalizedPlaywrightOptions {
  if (!options || typeof options !== "object") {
    throw new ConfigurationError("Playwright browser options must be an object.");
  }
  const browserName = options.browserName ?? "chromium";
  if (!(["chromium", "firefox", "webkit"] as const).includes(browserName)) {
    throw new ConfigurationError("Playwright browserName must be chromium, firefox, or webkit.");
  }
  if (options.browser && options.launch) {
    throw new ConfigurationError("Playwright launch options cannot be used with a shared browser.");
  }
  if (options.browser && (
    typeof options.browser.newContext !== "function" || !options.browser.isConnected()
  )) throw new ConfigurationError("The supplied Playwright browser must be connected.");
  const launch = normalizeLaunchOptions(options.launch);
  const context = normalizeContextOptions(options.context);
  const accessibilityTags = normalizeStringList(
    options.accessibilityTags,
    "Playwright accessibilityTags",
  );
  return {
    browserName,
    ...(options.browser ? { browser: options.browser } : {}),
    launch,
    context,
    ...(accessibilityTags ? { accessibilityTags } : {}),
  };
}

function normalizeLaunchOptions(value: PlaywrightLaunchOptions | undefined): NormalizedPlaywrightOptions["launch"] {
  if (value !== undefined && (!value || typeof value !== "object")) {
    throw new ConfigurationError("Playwright launch options must be an object.");
  }
  const timeout = value?.timeoutMs;
  if (timeout !== undefined && (!Number.isInteger(timeout) || timeout < 1 || timeout > 300_000)) {
    throw new ConfigurationError("Playwright launch timeoutMs must be an integer between 1 and 300000.");
  }
  const args = normalizeStringList(value?.args, "Playwright launch args", 200);
  if (value?.headless !== undefined && typeof value.headless !== "boolean") {
    throw new ConfigurationError("Playwright launch headless must be a boolean.");
  }
  for (const [label, option] of [
    ["executablePath", value?.executablePath],
    ["channel", value?.channel],
  ] as const) {
    if (option !== undefined && (typeof option !== "string" || option.trim().length === 0)) {
      throw new ConfigurationError(`Playwright launch ${label} must be a non-empty string.`);
    }
  }
  return {
    headless: value?.headless ?? true,
    ...(value?.executablePath ? { executablePath: value.executablePath.trim() } : {}),
    ...(value?.channel ? { channel: value.channel.trim() } : {}),
    ...(args ? { args: [...args] } : {}),
    ...(timeout === undefined ? {} : { timeout }),
  };
}

function normalizeContextOptions(value: PlaywrightContextOptions | undefined): PlaywrightContextOptions {
  if (value !== undefined && (!value || typeof value !== "object")) {
    throw new ConfigurationError("Playwright context options must be an object.");
  }
  if (value?.ignoreHTTPSErrors !== undefined && typeof value.ignoreHTTPSErrors !== "boolean") {
    throw new ConfigurationError("Playwright ignoreHTTPSErrors must be a boolean.");
  }
  if (value?.colorScheme !== undefined && !["light", "dark", "no-preference"].includes(value.colorScheme)) {
    throw new ConfigurationError("Playwright colorScheme is invalid.");
  }
  if (value?.reducedMotion !== undefined && !["reduce", "no-preference"].includes(value.reducedMotion)) {
    throw new ConfigurationError("Playwright reducedMotion is invalid.");
  }
  const locale = normalizeOptionalContextString(value?.locale, "locale");
  const timezoneId = normalizeOptionalContextString(value?.timezoneId, "timezoneId");
  return Object.freeze({
    ...(value?.ignoreHTTPSErrors === undefined ? {} : { ignoreHTTPSErrors: value.ignoreHTTPSErrors }),
    ...(locale ? { locale } : {}),
    ...(timezoneId ? { timezoneId } : {}),
    ...(value?.colorScheme ? { colorScheme: value.colorScheme } : {}),
    ...(value?.reducedMotion ? { reducedMotion: value.reducedMotion } : {}),
  });
}

function normalizeOptionalContextString(value: string | undefined, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || value.trim().length === 0 || value.length > 200) {
    throw new ConfigurationError(`Playwright ${label} must contain 1-200 characters.`);
  }
  return value.trim();
}

function normalizeStringList(
  value: readonly string[] | undefined,
  label: string,
  max = 100,
): readonly string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0 || value.length > max) {
    throw new ConfigurationError(`${label} must contain 1-${max} values.`);
  }
  const normalized = value.map((item) => {
    if (typeof item !== "string" || item.trim().length === 0 || item.length > 1_000) {
      throw new ConfigurationError(`${label} contains an invalid value.`);
    }
    return item.trim();
  });
  if (new Set(normalized).size !== normalized.length) {
    throw new ConfigurationError(`${label} cannot contain duplicates.`);
  }
  return Object.freeze(normalized);
}

function normalizeImpact(value: string | null | undefined): BrowserAccessibilityImpact {
  return value === "minor" || value === "moderate" || value === "serious" || value === "critical"
    ? value
    : "unknown";
}

function axeTarget(value: unknown): string | null {
  if (!Array.isArray(value) || value.length === 0) return null;
  return value.map((part) => typeof part === "string" ? part : JSON.stringify(part)).join(" ");
}

function coordinateOrNull(value: number | undefined): number | null {
  return Number.isInteger(value) && value! >= 0 ? value! : null;
}

function httpUrlOrNull(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function imageDimensions(
  bytes: Uint8Array,
  format: "png" | "jpeg",
): { readonly width: number; readonly height: number } {
  if (format === "png") {
    if (bytes.length < 24 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
      throw new Error("Playwright returned an invalid PNG screenshot.");
    }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    throw new Error("Playwright returned an invalid JPEG screenshot.");
  }
  let offset = 2;
  while (offset + 8 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1]!;
    if (marker === 0xd9 || marker === 0xda) break;
    const length = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (length < 2 || offset + 2 + length > bytes.length) break;
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return {
        height: (bytes[offset + 5]! << 8) | bytes[offset + 6]!,
        width: (bytes[offset + 7]! << 8) | bytes[offset + 8]!,
      };
    }
    offset += 2 + length;
  }
  throw new Error("Playwright returned a JPEG without dimensions.");
}
