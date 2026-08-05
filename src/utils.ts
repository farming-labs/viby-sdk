import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { ConfigurationError } from "./errors.js";

export function createId(): string {
  return randomUUID();
}

export function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertIdentifier(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0 || normalized.length > 255) {
    throw new ConfigurationError(`${label} must contain between 1 and 255 characters.`);
  }
  return normalized;
}

export function assertPrompt(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new ConfigurationError("A generation prompt cannot be empty.");
  }
  if (normalized.length > 100_000) {
    throw new ConfigurationError("A generation prompt cannot exceed 100,000 characters.");
  }
  return normalized;
}

export function normalizeProjectPath(value: string): string {
  const withForwardSlashes = value.replaceAll("\\", "/").replace(/^\.\//, "");
  const normalized = posix.normalize(withForwardSlashes);

  if (
    normalized.length === 0 ||
    normalized === "." ||
    normalized.startsWith("/") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    normalized.includes("\0")
  ) {
    throw new ConfigurationError(`Generated file path is unsafe: ${value}`);
  }

  return normalized;
}

export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || "viby-project";
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown error occurred.";
}
