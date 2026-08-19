import type { LanguageModel } from "ai";
import { ConfigurationError } from "./errors.js";

const MODEL_ALIAS_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;

/** Minimal AI SDK provider surface needed to construct language models by ID. */
export interface LanguageModelProvider<ModelId extends string = string> {
  languageModel(modelId: ModelId): LanguageModel;
}

/** Declarative model IDs keyed by the stable aliases exposed to generation requests. */
export type ModelCatalog<ModelId extends string = string> = Readonly<
  { readonly default: ModelId } & Record<string, ModelId>
>;

/** `createViby()` model configuration produced from a declarative provider catalog. */
export type ModelsFromResult<Catalog extends ModelCatalog> = Readonly<{
  model: LanguageModel;
  models: Readonly<{
    [Alias in Exclude<keyof Catalog, "default">]: LanguageModel;
  }>;
}>;

/**
 * Construct Viby model bindings from one provider instance and a declarative ID catalog.
 *
 * The `default` entry becomes the top-level `model`; every other key remains a stable,
 * request-selectable alias under `models`.
 */
export function modelsFrom<
  const ModelId extends string,
  const Catalog extends ModelCatalog<ModelId>,
>(
  provider: LanguageModelProvider<ModelId>,
  catalog: Catalog,
): ModelsFromResult<Catalog> {
  if (!provider || typeof provider.languageModel !== "function") {
    throw new ConfigurationError("modelsFrom() requires a provider with languageModel(modelId).");
  }
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new ConfigurationError("modelsFrom() requires a model catalog object.");
  }
  if (!Object.prototype.hasOwnProperty.call(catalog, "default")) {
    throw new ConfigurationError("modelsFrom() requires a default model ID.");
  }

  const entries = Object.entries(catalog);
  for (const [alias, modelId] of entries) {
    if (alias !== "default" && !MODEL_ALIAS_PATTERN.test(alias)) {
      throw new ConfigurationError(
        `Model alias ${JSON.stringify(alias)} must match ${MODEL_ALIAS_PATTERN.source}.`,
      );
    }
    if (
      typeof modelId !== "string"
      || modelId.length === 0
      || modelId.length > 200
      || /\s/.test(modelId)
    ) {
      throw new ConfigurationError(
        `Model ${JSON.stringify(alias)} must have a 1-200 character string ID without whitespace.`,
      );
    }
  }

  const model = provider.languageModel(catalog.default);
  const models = Object.fromEntries(
    entries
      .filter(([alias]) => alias !== "default")
      .map(([alias, modelId]) => [alias, provider.languageModel(modelId)]),
  ) as ModelsFromResult<Catalog>["models"];

  return Object.freeze({
    model,
    models: Object.freeze(models),
  });
}
