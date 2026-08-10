import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BrowserSession,
  openBrowserSession,
  type BrowserAdapter,
  type BrowserInstance,
  type BrowserNavigationInput,
  type BrowserReadinessOptions,
  type BrowserScreenshotOptions,
} from "../src/browser.js";
import { verifyBrowserAdapter } from "../src/browser-conformance.js";
import { BrowserError, ConfigurationError } from "../src/errors.js";

class FakeBrowserInstance implements BrowserInstance {
  readonly id = "browser-fixture";
  readonly navigations: BrowserNavigationInput[] = [];
  closeCalls = 0;
  bytes = new Uint8Array([137, 80, 78, 71]);

  async navigate(input: BrowserNavigationInput) {
    this.navigations.push(input);
    return { url: input.url, title: "Fixture", status: 200 };
  }

  async screenshot(options: BrowserScreenshotOptions = {}) {
    return {
      bytes: this.bytes,
      mediaType: options.format === "jpeg" ? "image/jpeg" as const : "image/png" as const,
      width: 1280,
      height: 720,
      url: this.navigations.at(-1)?.url ?? "https://preview.example/",
    };
  }

  async inspect() {
    return {
      url: this.navigations.at(-1)?.url ?? "https://preview.example/",
      title: "Fixture",
      html: '<main data-ready="true">Ready</main>',
      text: "Ready",
    };
  }

  async consoleErrors() {
    return [{
      message: "Fixture console error",
      url: "https://preview.example/app",
      line: 4,
      column: 2,
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
    }];
  }

  async accessibility() {
    return { url: "https://preview.example/app", passed: true, issues: [] };
  }

  async waitForReady(options: BrowserReadinessOptions = {}) {
    return {
      url: options.url ?? this.navigations.at(-1)?.url ?? "https://preview.example/",
      readyAt: new Date(),
    };
  }

  async close() { this.closeCalls += 1; }
}

function fakeAdapter(instance = new FakeBrowserInstance()): BrowserAdapter {
  return { provider: "fixture-browser", async open() { return instance; } };
}

test("runs portable browser operations without provider-specific values", async () => {
  const instance = new FakeBrowserInstance();
  const session = await openBrowserSession(fakeAdapter(instance), {
    baseUrl: "https://preview.example/",
    context: { tenantId: "tenant", userId: "user", versionId: "version" },
    viewport: { width: 1280, height: 720 },
  });

  assert.ok(session instanceof BrowserSession);
  assert.equal((await session.navigate("/app")).url, "https://preview.example/app");
  assert.equal((await session.waitForReady({ selector: "[data-ready]" })).url, "https://preview.example/app");
  assert.equal((await session.inspect({ selector: "main" })).text, "Ready");
  const screenshot = await session.screenshot();
  instance.bytes.fill(0);
  assert.deepEqual(screenshot.bytes, new Uint8Array([137, 80, 78, 71]));
  assert.equal((await session.consoleErrors())[0]?.line, 4);
  assert.equal((await session.accessibility()).passed, true);

  await session.close();
  await session.close();
  assert.equal(instance.closeCalls, 1);
  await assert.rejects(() => session.navigate("/closed"), BrowserError);
});

test("keeps navigation on the preview origin unless explicitly allowed", async () => {
  const session = await openBrowserSession(fakeAdapter(), { baseUrl: "https://preview.example/" });
  await assert.rejects(() => session.navigate("https://external.example/"), ConfigurationError);
  await session.close();

  const external = await openBrowserSession(fakeAdapter(), {
    baseUrl: "https://preview.example/",
    allowExternalNavigation: true,
  });
  assert.equal(
    (await external.navigate("https://external.example/page#fragment")).url,
    "https://external.example/page",
  );
  await external.close();
});

test("rejects a provider-reported cross-origin redirect", async () => {
  const instance = new FakeBrowserInstance();
  instance.navigate = async () => ({
    url: "https://external.example/redirected",
    title: "External",
    status: 200,
  });
  const session = await openBrowserSession(fakeAdapter(instance), {
    baseUrl: "https://preview.example/",
  });
  await assert.rejects(() => session.navigate("/redirect"), BrowserError);
  await session.close();
});

test("wraps provider failures in a portable browser error", async () => {
  const adapter = fakeAdapter();
  adapter.open = async () => { throw new Error("provider unavailable"); };
  await assert.rejects(
    () => openBrowserSession(adapter, { baseUrl: "https://preview.example/" }),
    (error: unknown) => error instanceof BrowserError
      && error.provider === "fixture-browser"
      && error.operation === "open a browser",
  );
});

test("cleans up an invalid provider instance during open", async () => {
  let closeCalls = 0;
  await assert.rejects(() => openBrowserSession({
    provider: "broken-browser",
    async open() {
      return {
        id: "broken",
        async close() { closeCalls += 1; },
      } as unknown as BrowserInstance;
    },
  }, { baseUrl: "https://preview.example/" }), ConfigurationError);
  assert.equal(closeCalls, 1);
});

test("passes the provider-neutral browser conformance suite", async () => {
  const report = await verifyBrowserAdapter({
    adapter: fakeAdapter(),
    url: "https://preview.example/",
    selector: "main",
  });
  assert.deepEqual(report.checks, [
    "navigation",
    "readiness",
    "dom-inspection",
    "screenshot",
    "console-errors",
    "accessibility",
    "idempotent-close",
  ]);
});
