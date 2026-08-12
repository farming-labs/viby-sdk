import { SkillResolutionError } from "./errors.js";
import type {
  ChatMetadata,
  InlineSkillReference,
  ResolverSkillReference,
  SkillFile,
  SkillResolverAdapter,
} from "./types.js";

/** Define a portable resolver for host-owned skill catalogs and storage systems. */
export function defineSkillResolver<const Adapter extends SkillResolverAdapter>(
  adapter: Adapter,
): Adapter {
  if (!adapter || typeof adapter !== "object") {
    throw new SkillResolutionError("skillResolver", "the resolver must be an object");
  }
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,99}$/.test(adapter.id)) {
    throw new SkillResolutionError(adapter.id, "the resolver ID is invalid");
  }
  if (typeof adapter.resolve !== "function") {
    throw new SkillResolutionError(adapter.id, "the resolver must implement resolve(input)");
  }
  return adapter;
}

/** Create an immutable skill snapshot that needs no filesystem or network access. */
export function skillInline(input: {
  readonly name: string;
  readonly description?: string;
  readonly files: readonly SkillFile[];
}): InlineSkillReference {
  return {
    source: "inline",
    name: input.name,
    ...(input.description === undefined ? {} : { description: input.description }),
    files: input.files.map((file) => ({ ...file })),
  };
}

/** Create a durable opaque reference owned by a configured skill resolver. */
export function skillFrom(
  resolver: string,
  locator: string,
  metadata?: ChatMetadata,
): ResolverSkillReference {
  if (resolver.trim().length === 0) {
    throw new SkillResolutionError(resolver, "the resolver ID cannot be empty");
  }
  if (locator.trim().length === 0) {
    throw new SkillResolutionError(locator, "the locator cannot be empty");
  }
  return {
    source: "resolver",
    resolver,
    locator,
    ...(metadata === undefined ? {} : { metadata: structuredClone(metadata) }),
  };
}
