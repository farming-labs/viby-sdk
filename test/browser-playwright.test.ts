import assert from "node:assert/strict";
import { test } from "node:test";
import { playwrightBrowser } from "../src/browser-playwright.js";
import { ConfigurationError } from "../src/errors.js";

test("validates Playwright adapter configuration without launching a browser", () => {
  assert.equal(playwrightBrowser().provider, "playwright-chromium");
  assert.equal(playwrightBrowser({ browserName: "webkit" }).provider, "playwright-webkit");
  assert.throws(
    () => playwrightBrowser({ browserName: "chrome" as never }),
    ConfigurationError,
  );
  assert.throws(
    () => playwrightBrowser({ launch: { args: [] } }),
    /launch args/,
  );
  assert.throws(
    () => playwrightBrowser({ context: { colorScheme: "sepia" as never } }),
    /colorScheme/,
  );
  assert.throws(
    () => playwrightBrowser({ accessibilityTags: ["wcag2aa", "wcag2aa"] }),
    /duplicates/,
  );
});
