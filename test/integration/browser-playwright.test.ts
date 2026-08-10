import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { verifyBrowserAdapter } from "../../src/browser-conformance.js";
import { BrowserError } from "../../src/errors.js";
import { playwrightBrowser } from "../../src/browser-playwright.js";
import { openSandboxPreview } from "../../src/browser-preview.js";
import { createViby } from "../../src/client.js";
import { accessibilityGate, consoleErrorGate } from "../../src/visual-evaluation.js";
import { MemoryRepository } from "../helpers/memory-repository.js";
import {
  SandboxSession,
  sandboxCapabilities,
  type SandboxInstance,
} from "../../src/sandbox.js";

const html = `<!doctype html>
<html lang="en">
  <head><title>Playwright fixture</title></head>
  <body>
    <main data-ready="true">
      <h1>Browser adapter</h1>
      <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" />
    </main>
    <script>console.error("fixture console error")</script>
  </body>
</html>`;

test("runs the Playwright adapter against a real Chromium page and sandbox preview", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/redirect") {
      response.writeHead(302, { location: "https://example.com/" });
      response.end();
      return;
    }
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(html);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Fixture server has no port.");
  const url = `http://127.0.0.1:${address.port}/`;
  const adapter = playwrightBrowser({
    browserName: "chromium",
    context: { reducedMotion: "reduce", colorScheme: "light" },
  });

  try {
    const report = await verifyBrowserAdapter({ adapter, url, selector: "main" });
    assert.equal(report.provider, "playwright-chromium");

    const sandboxInstance: SandboxInstance = {
      id: "playwright-preview",
      async writeFiles() {},
      async run() { return { exitCode: 0, stdout: "", stderr: "", durationMs: 1 }; },
      async readFile() { return new Uint8Array(); },
      getUrl() { return url; },
      async stop() {},
    };
    const sandbox = new SandboxSession(
      "fixture-sandbox",
      sandboxCapabilities({ files: true, commands: true, portUrls: true }),
      sandboxInstance,
    );
    const browser = await openSandboxPreview(adapter, sandbox, {
      port: 3000,
      path: "/",
      context: { tenantId: "tenant", userId: "user", versionId: "version" },
    });
    try {
      assert.equal((await browser.inspect({ selector: "main" })).text.includes("Browser adapter"), true);
      const screenshot = await browser.screenshot({ format: "png", fullPage: true });
      assert.equal(screenshot.mediaType, "image/png");
      assert.ok(screenshot.width > 0 && screenshot.height > 0);
      const jpeg = await browser.screenshot({ format: "jpeg", quality: 80, selector: "main" });
      assert.equal(jpeg.mediaType, "image/jpeg");
      assert.ok(jpeg.width > 0 && jpeg.height > 0);
      assert.ok((await browser.consoleErrors()).some((error) => error.message.includes("fixture console error")));
      const accessibility = await browser.accessibility({ rules: ["image-alt"] });
      assert.equal(accessibility.passed, false);
      assert.equal(accessibility.issues[0]?.id, "image-alt");
      await assert.rejects(() => browser.navigate("/redirect"), BrowserError);

      const viby = createViby({
        framework: "farm",
        persistence: new MemoryRepository(),
        browser: adapter,
        engine: {
          identity: { provider: "fixture", model: "unused" },
          async generate() { throw new Error("Generation is not used by this fixture."); },
        },
      });
      try {
        const imported = await viby.forUser({ tenantId: "tenant", userId: "user" }).chats.import({
          source: { type: "files", files: [{ path: "index.html", content: html }] },
        });
        const version = await imported.latestVersion();
        assert.ok(version);
        const visual = await version.evaluateVisual({
          evaluator: "playwright-integration@1",
          preview: { type: "sandbox", sandbox, port: 3000 },
          pages: [{ id: "home", path: "/", readiness: { selector: "main" } }],
          gates: [consoleErrorGate(), accessibilityGate()],
        });
        assert.equal(visual.evaluation.status, "failed");
        assert.equal(visual.artifacts[0]?.mediaType, "image/png");
        assert.ok((await version.getVisualArtifact(visual.artifacts[0]!.id)).bytes.byteLength > 0);
      } finally {
        await viby.close();
      }
    } finally {
      await browser.close();
      await sandbox.stop();
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
