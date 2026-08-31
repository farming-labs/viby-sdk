import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModelUsage } from "ai";
import type { GeneratorInput } from "../src/generator.js";
import {
  ScriptedGenerationEngineExhaustedError,
  createScriptedGenerationEngine,
  verifyArtifactStore,
  verifyBrowserAdapter,
  verifyDeploymentIntegration,
  verifyGenerationEngine,
  verifyIntegrationStores,
  verifyPersistenceAdapter,
  verifyRepositoryIntegration,
  verifySandboxAdapter,
  verifyToolSourceAdapter,
} from "../src/testing.js";

const usage: LanguageModelUsage = {
  inputTokens: 1,
  inputTokenDetails: { noCacheTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 1,
  outputTokenDetails: { textTokens: 1, reasoningTokens: 0 },
  totalTokens: 2,
};

const input: GeneratorInput<"farmjs"> = {
  framework: "farmjs",
  prompt: "Build a dashboard",
  messages: [],
  previousFiles: [],
  skills: [],
  tasks: [],
};

test("publishes every provider-neutral conformance suite through one testing entry point", () => {
  for (const verifier of [
    verifyArtifactStore,
    verifyBrowserAdapter,
    verifyDeploymentIntegration,
    verifyGenerationEngine,
    verifyIntegrationStores,
    verifyPersistenceAdapter,
    verifyRepositoryIntegration,
    verifySandboxAdapter,
    verifyToolSourceAdapter,
  ]) {
    assert.equal(typeof verifier, "function");
  }
});

test("runs deterministic scripted generation steps and exposes exact calls", async () => {
  const scripted = createScriptedGenerationEngine<"farmjs">({
    steps: [{ kind: "message", content: "First result", usage, finishReason: "stop" }],
  });
  assert.deepEqual(scripted.engine.identity, { provider: "viby-testing", model: "scripted" });
  assert.equal(scripted.remaining, 1);

  const first = await scripted.engine.generate(input, {
    run: {
      tenantId: "tenant-test",
      userId: "user-test",
      chatId: "chat-test",
      generationId: "generation-test",
      attemptId: "attempt-test",
    },
  });
  assert.equal(first.kind, "message");
  assert.equal(scripted.calls.length, 1);
  assert.equal(scripted.calls[0]?.prompt, "Build a dashboard");
  assert.equal(scripted.remaining, 0);

  await assert.rejects(
    () => scripted.engine.generate(input),
    ScriptedGenerationEngineExhaustedError,
  );
  scripted.enqueue(async (generationInput) => ({
    kind: "message",
    content: `Handled ${generationInput.prompt}`,
    usage,
    finishReason: "stop",
  }));
  assert.equal((await scripted.engine.generate(input)).kind, "message");

  const cancelled = new AbortController();
  cancelled.abort(new DOMException("Cancelled", "AbortError"));
  scripted.enqueue({ kind: "message", content: "Unused", usage, finishReason: "stop" });
  await assert.rejects(() => scripted.engine.generate(input, { signal: cancelled.signal }), {
    name: "AbortError",
  });
  assert.equal(scripted.remaining, 1);
  scripted.clear();
  assert.equal(scripted.calls.length, 0);
  assert.equal(scripted.remaining, 0);
});
