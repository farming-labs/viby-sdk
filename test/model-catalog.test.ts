import assert from "node:assert/strict";
import { test } from "node:test";
import type { LanguageModel } from "ai";
import { ConfigurationError, modelsFrom } from "../src/index.js";

function fixtureModel(modelId: string): LanguageModel {
  return {
    provider: "fixture",
    modelId,
  } as LanguageModel;
}

test("constructs a default model and typed request aliases from one provider", () => {
  const calls: string[] = [];
  const models = new Map<string, LanguageModel>();
  const provider = {
    languageModel(modelId: "gpt-default" | "gpt-fast" | "gpt-quality") {
      calls.push(modelId);
      const model = fixtureModel(modelId);
      models.set(modelId, model);
      return model;
    },
  };

  const result = modelsFrom(provider, {
    default: "gpt-default",
    fast: "gpt-fast",
    quality: "gpt-quality",
  });
  const typedAliases: Readonly<{
    fast: LanguageModel;
    quality: LanguageModel;
  }> = result.models;

  assert.equal(result.model, models.get("gpt-default"));
  assert.equal(typedAliases.fast, models.get("gpt-fast"));
  assert.equal(typedAliases.quality, models.get("gpt-quality"));
  assert.deepEqual(calls, ["gpt-default", "gpt-fast", "gpt-quality"]);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.models), true);
});

test("supports a catalog containing only the default model", () => {
  const model = fixtureModel("claude-default");
  const result = modelsFrom(
    { languageModel: () => model },
    { default: "claude-default" },
  );

  assert.equal(result.model, model);
  assert.deepEqual(result.models, {});
});

test("rejects invalid catalogs before constructing any provider models", () => {
  let calls = 0;
  const provider = {
    languageModel(modelId: string) {
      calls += 1;
      return fixtureModel(modelId);
    },
  };

  assert.throws(
    () => modelsFrom(provider, { default: "gpt-default", "not an alias": "gpt-fast" }),
    ConfigurationError,
  );
  assert.throws(
    () => modelsFrom(provider, { default: "gpt-default", fast: "" }),
    ConfigurationError,
  );
  assert.throws(
    () => modelsFrom(provider, { default: "gpt-default", fast: "gpt fast" }),
    ConfigurationError,
  );
  assert.throws(
    () => modelsFrom(provider, {} as { default: string }),
    ConfigurationError,
  );
  assert.equal(calls, 0);
});

test("rejects providers without a language-model factory", () => {
  assert.throws(
    () => modelsFrom({} as never, { default: "gpt-default" }),
    ConfigurationError,
  );
});
