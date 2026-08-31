import { ConfigurationError } from "./errors.js";
import { normalizeChatMetadata } from "./metadata.js";
import type { ChatMetadata } from "./types.js";

export type MessageFeedbackRating = "positive" | "negative";

export type MessageFeedbackReason =
  | "helpful"
  | "accurate"
  | "well-designed"
  | "incorrect"
  | "incomplete"
  | "poor-design"
  | "unsafe"
  | "other"
  | (string & {});

export interface SubmitMessageFeedbackInput {
  readonly rating: MessageFeedbackRating;
  readonly reasons?: readonly MessageFeedbackReason[];
  readonly comment?: string | null;
  readonly metadata?: ChatMetadata;
  /** Reusing a key for the same message returns the original immutable record. */
  readonly idempotencyKey?: string;
}

export interface MessageFeedbackData {
  readonly id: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly generationId: string;
  readonly attemptId: string;
  readonly versionId: string | null;
  readonly modelProvider: string;
  readonly modelId: string;
  readonly rating: MessageFeedbackRating;
  readonly reasons: readonly MessageFeedbackReason[];
  readonly comment: string | null;
  readonly metadata: ChatMetadata;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

export interface CreateMessageFeedbackRecord {
  readonly id: string;
  readonly chatId: string;
  readonly messageId: string;
  readonly rating: MessageFeedbackRating;
  readonly reasons: readonly MessageFeedbackReason[];
  readonly comment: string | null;
  readonly metadata: ChatMetadata;
  readonly idempotencyKey: string | null;
}

export function normalizeMessageFeedback(
  input: SubmitMessageFeedbackInput,
): Omit<CreateMessageFeedbackRecord, "id" | "chatId" | "messageId"> {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Message feedback must be an object.");
  }
  if (input.rating !== "positive" && input.rating !== "negative") {
    throw new ConfigurationError("Message feedback rating must be positive or negative.");
  }
  const reasons = [...new Set((input.reasons ?? []).map(normalizeReason))];
  if (reasons.length > 10) {
    throw new ConfigurationError("Message feedback can include at most 10 reasons.");
  }
  const comment = input.comment === undefined || input.comment === null
    ? null
    : normalizeOptionalText(input.comment, "comment", 4_000);
  const idempotencyKey = input.idempotencyKey === undefined
    ? null
    : normalizeOptionalText(input.idempotencyKey, "idempotency key", 200);
  return {
    rating: input.rating,
    reasons,
    comment,
    metadata: normalizeChatMetadata(input.metadata),
    idempotencyKey,
  };
}

function normalizeReason(value: MessageFeedbackReason): MessageFeedbackReason {
  if (typeof value !== "string") {
    throw new ConfigurationError("Message feedback reasons must be strings.");
  }
  return normalizeOptionalText(value, "reason", 100);
}

function normalizeOptionalText(value: string, label: string, maxLength: number): string {
  if (typeof value !== "string") {
    throw new ConfigurationError(`Message feedback ${label} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized || normalized.length > maxLength) {
    throw new ConfigurationError(
      `Message feedback ${label} must contain 1-${maxLength} characters.`,
    );
  }
  return normalized;
}
