import { ConfigurationError } from "./errors.js";
import type { JsonValue } from "./types.js";

export const REDACTED_VALUE = "[REDACTED]";

const SECRET_KEY = /(?:^|[_-])(?:api[_-]?key|authorization|cookie|credential|password|passwd|private[_-]?key|secret|token)(?:$|[_-])/i;
const MAX_REDACTION_DEPTH = 32;
const MAX_TOOL_PAYLOAD_BYTES = 512_000;
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function normalizeAndRedactToolPayload(value: unknown): JsonValue {
  const normalized = normalize(value, 0, new Set());
  if (Buffer.byteLength(JSON.stringify(normalized)) > MAX_TOOL_PAYLOAD_BYTES) {
    throw new ConfigurationError(`Tool payloads cannot exceed ${MAX_TOOL_PAYLOAD_BYTES} bytes.`);
  }
  return redactJsonSecrets(normalized);
}

export function redactJsonSecrets(value: JsonValue): JsonValue {
  return redact(value, 0);
}

function redact(value: JsonValue, depth: number): JsonValue {
  if (depth > MAX_REDACTION_DEPTH) return REDACTED_VALUE;
  if (Array.isArray(value)) return value.map((item) => redact(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      isSecretKey(key) ? REDACTED_VALUE : redact(item, depth + 1),
    ]));
  }
  return value;
}

function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key.replace(/([a-z\d])([A-Z])/g, "$1_$2"));
}

function normalize(value: unknown, depth: number, ancestors: Set<object>): JsonValue {
  if (depth > MAX_REDACTION_DEPTH) {
    throw new ConfigurationError(`Tool payloads cannot exceed ${MAX_REDACTION_DEPTH} levels.`);
  }
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new ConfigurationError("Tool payload numbers must be finite.");
    return value;
  }
  if (typeof value !== "object") {
    throw new ConfigurationError("Tool payloads must contain only JSON values.");
  }
  if (ancestors.has(value)) throw new ConfigurationError("Tool payloads cannot contain cycles.");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      return value.map((item) => normalize(item, depth + 1, ancestors));
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new ConfigurationError("Tool payloads must contain only plain JSON objects.");
    }
    const output: Record<string, JsonValue> = {};
    for (const [key, item] of Object.entries(value)) {
      if (!key || key.length > 200 || UNSAFE_KEYS.has(key)) {
        throw new ConfigurationError(`Tool payload key is invalid: ${key}`);
      }
      output[key] = normalize(item, depth + 1, ancestors);
    }
    return output;
  } finally {
    ancestors.delete(value);
  }
}
