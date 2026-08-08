import { ConfigurationError } from "./errors.js";
import type { ChatMetadata, JsonValue } from "./types.js";

const MAX_METADATA_BYTES = 64_000;
const MAX_METADATA_DEPTH = 20;
const MAX_METADATA_KEY_LENGTH = 200;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeChatMetadata(value: ChatMetadata | undefined): ChatMetadata {
  if (value === undefined) return {};
  if (!isPlainObject(value)) {
    throw new ConfigurationError("Chat metadata must be a JSON object.");
  }
  const normalized = normalizeObject(value, 0);
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_METADATA_BYTES) {
    throw new ConfigurationError(`Chat metadata cannot exceed ${MAX_METADATA_BYTES} bytes.`);
  }
  return normalized;
}

function normalizeObject(value: Record<string, unknown>, depth: number): ChatMetadata {
  if (depth > MAX_METADATA_DEPTH) {
    throw new ConfigurationError(`Chat metadata cannot exceed ${MAX_METADATA_DEPTH} levels.`);
  }
  const normalized: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length === 0 || key.length > MAX_METADATA_KEY_LENGTH || UNSAFE_KEYS.has(key)) {
      throw new ConfigurationError(`Chat metadata key is invalid: ${key}`);
    }
    normalized[key] = normalizeValue(entry, depth + 1);
  }
  return normalized;
}

function normalizeValue(value: unknown, depth: number): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigurationError("Chat metadata numbers must be finite.");
    return value;
  }
  if (Array.isArray(value)) {
    if (depth > MAX_METADATA_DEPTH) {
      throw new ConfigurationError(`Chat metadata cannot exceed ${MAX_METADATA_DEPTH} levels.`);
    }
    return value.map((entry) => normalizeValue(entry, depth + 1));
  }
  if (isPlainObject(value)) return normalizeObject(value, depth);
  throw new ConfigurationError("Chat metadata must contain only JSON values.");
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
