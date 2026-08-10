import { ConfigurationError } from "./errors.js";

interface ChatCursor {
  readonly updatedAt: Date;
  readonly id: string;
}

interface MessageCursor {
  readonly createdAt: Date;
  readonly id: string;
}

interface VersionCursor {
  readonly number: number;
}

interface DesignEvaluationCursor {
  readonly createdAt: Date;
  readonly id: string;
}

export function encodeChatCursor(cursor: ChatCursor): string {
  return encode({ v: 1, k: "chat", at: cursor.updatedAt.toISOString(), id: cursor.id });
}

export function decodeChatCursor(cursor: string | undefined): ChatCursor | null {
  if (!cursor) return null;
  const value = decode(cursor);
  if (value.k !== "chat" || typeof value.at !== "string" || typeof value.id !== "string") {
    throw invalidCursor();
  }
  return { updatedAt: parseDate(value.at), id: parseId(value.id) };
}

export function encodeMessageCursor(cursor: MessageCursor): string {
  return encode({ v: 1, k: "message", at: cursor.createdAt.toISOString(), id: cursor.id });
}

export function decodeMessageCursor(cursor: string | undefined): MessageCursor | null {
  if (!cursor) return null;
  const value = decode(cursor);
  if (value.k !== "message" || typeof value.at !== "string" || typeof value.id !== "string") {
    throw invalidCursor();
  }
  return { createdAt: parseDate(value.at), id: parseId(value.id) };
}

export function encodeVersionCursor(cursor: VersionCursor): string {
  return encode({ v: 1, k: "version", number: cursor.number });
}

export function decodeVersionCursor(cursor: string | undefined): VersionCursor | null {
  if (!cursor) return null;
  const value = decode(cursor);
  if (value.k !== "version" || !Number.isInteger(value.number) || Number(value.number) < 1) {
    throw invalidCursor();
  }
  return { number: Number(value.number) };
}

export function encodeDesignEvaluationCursor(cursor: DesignEvaluationCursor): string {
  return encode({
    v: 1,
    k: "design-evaluation",
    at: cursor.createdAt.toISOString(),
    id: cursor.id,
  });
}

export function decodeDesignEvaluationCursor(
  cursor: string | undefined,
): DesignEvaluationCursor | null {
  if (!cursor) return null;
  const value = decode(cursor);
  if (
    value.k !== "design-evaluation"
    || typeof value.at !== "string"
    || typeof value.id !== "string"
  ) {
    throw invalidCursor();
  }
  return { createdAt: parseDate(value.at), id: parseId(value.id) };
}

function encode(value: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decode(cursor: string): Record<string, unknown> {
  if (cursor.length > 2_048 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw invalidCursor();
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidCursor();
    const record = value as Record<string, unknown>;
    if (record.v !== 1 || typeof record.k !== "string") throw invalidCursor();
    return record;
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError("Pagination cursor is invalid.", { cause: error });
  }
}

function parseDate(value: string): Date {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== value) throw invalidCursor();
  return date;
}

function parseId(value: string): string {
  if (value.length === 0 || value.length > 255) throw invalidCursor();
  return value;
}

function invalidCursor(): ConfigurationError {
  return new ConfigurationError("Pagination cursor is invalid.");
}
