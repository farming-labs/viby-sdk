import { ConfigurationError, SourceImportError } from "./errors.js";
import type {
  FrameworkId,
  ImportProjectInput,
  ImportProjectSource,
  UserScope,
} from "./types.js";

export interface SourceImportContext<Framework extends FrameworkId = FrameworkId>
extends UserScope {
  readonly framework: Framework;
  readonly signal?: AbortSignal;
}

export interface SourceImportResult {
  readonly source: ImportProjectSource;
  readonly title?: string;
  readonly summary?: string;
}

export interface SourceImportAdapter<
  Input = unknown,
  Framework extends FrameworkId = FrameworkId,
> {
  readonly name: string;
  import(input: Input, context: SourceImportContext<Framework>): Promise<SourceImportResult>;
}

export type AdapterProjectImportInput<
  Input,
  Framework extends FrameworkId = FrameworkId,
> = Omit<ImportProjectInput, "source"> & {
  readonly signal?: AbortSignal;
  readonly source: {
    readonly type: "adapter";
    readonly adapter: SourceImportAdapter<Input, Framework>;
    readonly input: Input;
  };
};

export async function resolveSourceImport<Input, Framework extends FrameworkId>(
  input: AdapterProjectImportInput<Input, Framework>,
  context: Omit<SourceImportContext<Framework>, "signal">,
): Promise<SourceImportResult> {
  const { source } = input;
  if (!source || source.type !== "adapter" || !source.adapter) {
    throw new ConfigurationError("Adapter project import requires a source import adapter.");
  }
  const adapter = source.adapter;
  if (!adapter || typeof adapter !== "object" || typeof adapter.import !== "function") {
    throw new ConfigurationError("Source import adapter must provide an import function.");
  }
  const name = normalizeSourceImportAdapterName(adapter.name);
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    throw new ConfigurationError("Source import signal must be an AbortSignal.");
  }
  input.signal?.throwIfAborted();
  let result: SourceImportResult;
  try {
    result = await adapter.import(source.input, {
      ...context,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    if (input.signal?.aborted) throw input.signal.reason;
    throw new SourceImportError(name, { cause: error });
  }
  input.signal?.throwIfAborted();
  if (!result || typeof result !== "object" || !result.source) {
    throw new ConfigurationError(`Source import adapter ${name} returned no source.`);
  }
  if (result.title !== undefined && typeof result.title !== "string") {
    throw new ConfigurationError(`Source import adapter ${name} returned an invalid title.`);
  }
  if (result.summary !== undefined && typeof result.summary !== "string") {
    throw new ConfigurationError(`Source import adapter ${name} returned an invalid summary.`);
  }
  if (result.source.type !== "files" && result.source.type !== "zip") {
    throw new ConfigurationError(`Source import adapter ${name} returned an invalid source type.`);
  }
  return result;
}

function normalizeSourceImportAdapterName(value: string): string {
  const name = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(name)) {
    throw new ConfigurationError(
      "Source import adapter name must contain 1-64 letters, numbers, dots, dashes, or underscores.",
    );
  }
  return name;
}
