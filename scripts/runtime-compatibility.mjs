import assert from "node:assert/strict";
import { builtinModules } from "node:module";
import { readFile } from "node:fs/promises";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const entry = join(root, "dist", "core.js");
const builtins = new Set(builtinModules.flatMap((name) => [name, `node:${name}`]));
const visited = new Set();
const pending = [entry];
const importPattern = /(?:import|export)\s+(?:[^"']*?\s+from\s+)?["']([^"']+)["']|import\s*\(\s*["']([^"']+)["']\s*\)/g;

while (pending.length > 0) {
  const path = pending.pop();
  if (!path || visited.has(path)) continue;
  visited.add(path);
  const source = await readFile(path, "utf8");
  for (const match of source.matchAll(importPattern)) {
    const specifier = match[1] ?? match[2];
    assert.ok(specifier);
    assert.equal(
      builtins.has(specifier) || specifier.startsWith("node:"),
      false,
      `Portable core transitively imports Node.js module ${specifier} from ${path}`,
    );
    if (!specifier.startsWith(".")) continue;
    const target = resolve(dirname(path), specifier);
    pending.push(extname(target) ? target : `${target}.js`);
  }
}

const core = await import(pathToFileURL(entry).href);
assert.equal(typeof core.generationEventStreamResponse, "function");
assert.equal(typeof core.defineSkillResolver, "function");
assert.equal(typeof core.createVibyWebClient, "function");

const source = {
  async *stream() {
    yield {
      cursor: "1",
      generationId: "generation",
      attemptId: "attempt",
      type: "generation.completed",
      data: { versionId: "version" },
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
    };
  },
};
const response = core.generationEventStreamResponse(source, {
  request: new Request("https://example.test", { headers: { "Last-Event-ID": "0" } }),
});
assert.ok(response instanceof Response);
assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
assert.match(await response.text(), /event: generation\.completed/);

const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("viby"));
assert.equal(new Uint8Array(digest).byteLength, 32);

console.log(`Verified portable core across ${visited.size} runtime modules and Web APIs.`);
