import {
  openBrowserSession,
  type BrowserAdapter,
  type BrowserOwnershipContext,
} from "./browser.js";
import { ConfigurationError } from "./errors.js";

export interface BrowserConformanceInput {
  readonly adapter: BrowserAdapter;
  readonly url: string;
  readonly selector: string;
  readonly context?: BrowserOwnershipContext;
}

export interface BrowserConformanceReport {
  readonly provider: string;
  readonly checks: readonly (
    | "navigation"
    | "readiness"
    | "dom-inspection"
    | "screenshot"
    | "console-errors"
    | "accessibility"
    | "idempotent-close"
  )[];
}

export class BrowserConformanceError extends Error {
  override readonly name = "BrowserConformanceError";
}

/** Runs the portable browser lifecycle against a caller-owned reachable page. */
export async function verifyBrowserAdapter(
  input: BrowserConformanceInput,
): Promise<BrowserConformanceReport> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Browser conformance input is required.");
  }
  const session = await openBrowserSession(input.adapter, {
    baseUrl: input.url,
    ...(input.context ? { context: input.context } : {}),
  });
  const checks: BrowserConformanceReport["checks"][number][] = [];
  try {
    const navigation = await session.navigate(input.url);
    if (!navigation.url.startsWith("http")) throw new BrowserConformanceError("Navigation returned no URL.");
    checks.push("navigation");

    await session.waitForReady({ selector: input.selector, state: "visible" });
    checks.push("readiness");
    const dom = await session.inspect({ selector: input.selector });
    if (!dom.html || !dom.text) throw new BrowserConformanceError("DOM inspection returned empty content.");
    checks.push("dom-inspection");
    const screenshot = await session.screenshot({ format: "png" });
    if (screenshot.bytes.length === 0) throw new BrowserConformanceError("Screenshot is empty.");
    checks.push("screenshot");
    await session.consoleErrors();
    checks.push("console-errors");
    await session.accessibility({ selector: input.selector });
    checks.push("accessibility");
  } finally {
    await session.close();
    await session.close();
  }
  checks.push("idempotent-close");
  return Object.freeze({ provider: session.provider, checks: Object.freeze(checks) });
}
