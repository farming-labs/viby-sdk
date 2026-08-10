import {
  openBrowserSession,
  type BrowserAdapter,
  type BrowserOpenInput,
  type BrowserSession,
  type BrowserWaitUntil,
} from "./browser.js";
import type { SandboxReadinessOptions, SandboxSession } from "./sandbox.js";
import { ConfigurationError } from "./errors.js";

export interface OpenSandboxPreviewInput extends Omit<BrowserOpenInput, "baseUrl"> {
  readonly port: number;
  readonly path?: string;
  readonly waitUntil?: BrowserWaitUntil;
  readonly readiness?: SandboxReadinessOptions;
}

/** Resolves a ready sandbox port, opens a browser session, and navigates to the preview. */
export async function openSandboxPreview(
  adapter: BrowserAdapter,
  sandbox: SandboxSession,
  input: OpenSandboxPreviewInput,
): Promise<BrowserSession> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Sandbox preview browser input is required.");
  }
  const path = input.path ?? "/";
  const target = await sandbox.waitForPort(input.port, {
    ...(input.readiness ?? {}),
    path: input.readiness?.path ?? path,
    ...(input.signal ? { signal: input.signal } : {}),
  });
  const session = await openBrowserSession(adapter, {
    baseUrl: target,
    ...(input.context ? { context: { ...input.context, sandboxId: sandbox.id } } : {}),
    ...(input.viewport ? { viewport: input.viewport } : {}),
    ...(input.allowExternalNavigation ? { allowExternalNavigation: true } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
  });
  try {
    await session.navigate({
      url: target,
      ...(input.waitUntil ? { waitUntil: input.waitUntil } : {}),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    return session;
  } catch (error) {
    await session.close().catch(() => undefined);
    throw error;
  }
}
