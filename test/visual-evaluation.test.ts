import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  BrowserAdapter,
  BrowserInstance,
  BrowserNavigationInput,
} from "../src/browser.js";
import { createViby } from "../src/client.js";
import { NotFoundError } from "../src/errors.js";
import { accessibilityGate, consoleErrorGate } from "../src/visual-evaluation.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

class FixtureBrowser implements BrowserAdapter {
  readonly provider = "fixture-browser";
  closed = false;

  async open(input: { readonly baseUrl: string }): Promise<BrowserInstance> {
    const owner = this;
    let url = input.baseUrl;
    const errors: Array<{
      message: string;
      url: string;
      line: number;
      column: number;
      timestamp: Date;
    }> = [];
    return {
      id: "fixture-session",
      async navigate(navigation: BrowserNavigationInput) {
        url = navigation.url;
        if (new URL(url).pathname === "/settings") {
          errors.push({
            message: "Settings failed to load",
            url,
            line: 12,
            column: 3,
            timestamp: new Date(),
          });
        }
        return { url, title: "Fixture", status: 200 };
      },
      async screenshot() {
        return {
          bytes: new Uint8Array([137, 80, 78, 71, new URL(url).pathname.length]),
          mediaType: "image/png" as const,
          width: 1280,
          height: 720,
          url,
        };
      },
      async inspect() {
        return { url, title: "Fixture", html: "<main>Ready</main>", text: "Ready" };
      },
      async consoleErrors() { return errors; },
      async accessibility() {
        const broken = new URL(url).pathname === "/settings";
        return {
          url,
          passed: !broken,
          issues: broken ? [{
            id: "button-name",
            impact: "serious" as const,
            message: "Buttons must have discernible text",
            helpUrl: "https://example.com/button-name",
            nodes: [],
          }] : [],
        };
      },
      async waitForReady() { return { url, readyAt: new Date() }; },
      async close() { owner.closed = true; },
    };
  }
}

function createFixture(browser?: BrowserAdapter) {
  return createViby({
    framework: "farm",
    persistence: new MemoryRepository(),
    ...(browser ? { browser } : {}),
    engine: {
      identity: { provider: "fixture", model: "unused" },
      async generate() { throw new Error("Generation is not used by this fixture."); },
    },
  });
}

test("captures preview pages, persists screenshots, and records configurable gates", async () => {
  const browser = new FixtureBrowser();
  const viby = createFixture(browser);
  const version = await (await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.import({
    title: "Visual fixture",
    source: { type: "files", files: [{ path: "index.html", content: "<main>Ready</main>" }] },
  })).latestVersion();
  assert.ok(version);

  const result = await version.evaluateVisual({
    evaluator: "product-quality@1",
    preview: { type: "url", url: "https://preview.example.test/" },
    pages: [
      { id: "home", path: "/", readiness: { selector: "main" }, screenshot: { fullPage: true } },
      { id: "settings", path: "/settings" },
    ],
    gates: [
      consoleErrorGate(),
      accessibilityGate(),
      {
        id: "custom-vision",
        label: "Custom vision runtime",
        async evaluate({ captures }) {
          assert.equal(captures.length, 2);
          assert.ok(captures.every((capture) => capture.screenshot.bytes.byteLength > 0));
          return {
            status: "warning",
            score: 80,
            summary: "A consumer-owned vision runtime requested review.",
            captureIds: ["home"],
          };
        },
      },
    ],
    metadata: { release: "candidate" },
  });

  assert.equal(result.evaluation.status, "failed");
  assert.equal(result.evaluation.criteria.length, 3);
  assert.equal(result.evaluation.metadata.release, "candidate");
  assert.equal(result.artifacts.length, 2);
  assert.equal(result.evaluation.evidence[0]?.type, "artifact");
  assert.equal((await version.visualArtifacts()).length, 2);
  const stored = await version.getVisualArtifact(result.artifacts[0]!.id);
  assert.equal(stored.checksum, result.artifacts[0]!.checksum);
  assert.deepEqual(stored.bytes, result.captures[0]!.screenshot.bytes);
  assert.equal(browser.closed, true);
  await viby.close();
});

test("requires a configured browser and keeps artifact evidence version-scoped", async () => {
  const viby = createFixture();
  const chat = await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.import({
    source: { type: "files", files: [{ path: "index.html", content: "ok" }] },
  });
  const version = await chat.latestVersion();
  assert.ok(version);
  await assert.rejects(() => version.evaluateVisual({
    evaluator: "test",
    preview: { type: "url", url: "https://example.test" },
    gates: [consoleErrorGate()],
  }), /browser adapter/);
  await assert.rejects(() => version.getVisualArtifact(crypto.randomUUID()), NotFoundError);
  await viby.close();
});
