import { ConfigurationError } from "./errors.js";
import { normalizeChatMetadata } from "./metadata.js";
import type { ChatMetadata, SkillGroups } from "./types.js";

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
  readonly framework: string;
  readonly executor: "model" | "engine";
  readonly runtimeAlias: string;
  readonly skills: SkillGroups;
  readonly versionNumber: number | null;
  readonly rating: MessageFeedbackRating;
  readonly reasons: readonly MessageFeedbackReason[];
  readonly comment: string | null;
  readonly metadata: ChatMetadata;
  readonly idempotencyKey: string | null;
  readonly createdAt: Date;
}

export const FEEDBACK_ANALYTICS_DIMENSIONS = Object.freeze([
  "model",
  "engine",
  "skill-set",
  "framework",
  "generation-version",
] as const);

export type FeedbackAnalyticsDimension = (typeof FEEDBACK_ANALYTICS_DIMENSIONS)[number];

export interface FeedbackAnalyticsQuery {
  /** Defaults to model. Multiple values produce compound buckets. */
  readonly groupBy?: readonly FeedbackAnalyticsDimension[];
  readonly from?: Date | string;
  readonly to?: Date | string;
  readonly framework?: string;
  readonly modelProvider?: string;
  readonly modelId?: string;
  readonly runtimeAlias?: string;
  /** Maximum buckets returned after sorting by total feedback. Defaults to 50. */
  readonly limit?: number;
}

export interface NormalizedFeedbackAnalyticsQuery {
  readonly groupBy: readonly FeedbackAnalyticsDimension[];
  readonly from: Date | null;
  readonly to: Date | null;
  readonly framework: string | null;
  readonly modelProvider: string | null;
  readonly modelId: string | null;
  readonly runtimeAlias: string | null;
  readonly limit: number;
}

export interface FeedbackAnalyticsDimensions {
  readonly model?: { readonly provider: string; readonly id: string };
  readonly engine?: { readonly executor: "model" | "engine"; readonly alias: string };
  readonly skillSet?: SkillGroups;
  readonly framework?: string;
  readonly generationVersion?: { readonly id: string | null; readonly number: number | null };
}

export interface FeedbackAnalyticsBucket {
  /** Stable JSON key for this exact dimension combination. */
  readonly key: string;
  readonly dimensions: FeedbackAnalyticsDimensions;
  readonly positive: number;
  readonly negative: number;
  readonly total: number;
  /** Ratio from 0 through 1, or null when the bucket is empty. */
  readonly positiveRate: number | null;
}

export interface FeedbackAnalyticsData {
  readonly groupBy: readonly FeedbackAnalyticsDimension[];
  readonly buckets: readonly FeedbackAnalyticsBucket[];
  readonly totals: {
    readonly positive: number;
    readonly negative: number;
    readonly total: number;
    readonly positiveRate: number | null;
  };
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

export function normalizeFeedbackAnalyticsQuery(
  input: FeedbackAnalyticsQuery = {},
): NormalizedFeedbackAnalyticsQuery {
  if (!input || typeof input !== "object") {
    throw new ConfigurationError("Feedback analytics query must be an object.");
  }
  const groupBy: FeedbackAnalyticsDimension[] = [
    ...new Set(input.groupBy ?? (["model"] as const)),
  ];
  if (groupBy.length === 0 || groupBy.length > FEEDBACK_ANALYTICS_DIMENSIONS.length) {
    throw new ConfigurationError("Feedback analytics groupBy must contain 1-5 dimensions.");
  }
  for (const dimension of groupBy) {
    if (!(FEEDBACK_ANALYTICS_DIMENSIONS as readonly string[]).includes(dimension)) {
      throw new ConfigurationError(`Unsupported feedback analytics dimension: ${dimension}`);
    }
  }
  const from = analyticsDate(input.from, "from");
  const to = analyticsDate(input.to, "to");
  if (from && to && from > to) {
    throw new ConfigurationError("Feedback analytics from must not be after to.");
  }
  const limit = input.limit ?? 50;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
    throw new ConfigurationError("Feedback analytics limit must be an integer from 1 through 200.");
  }
  return {
    groupBy,
    from,
    to,
    framework: analyticsFilter(input.framework, "framework"),
    modelProvider: analyticsFilter(input.modelProvider, "model provider"),
    modelId: analyticsFilter(input.modelId, "model id"),
    runtimeAlias: analyticsFilter(input.runtimeAlias, "runtime alias"),
    limit,
  };
}

export function feedbackAnalyticsDimensions(
  feedback: MessageFeedbackData,
  groupBy: readonly FeedbackAnalyticsDimension[],
): FeedbackAnalyticsDimensions {
  const dimensions: {
    model?: { provider: string; id: string };
    engine?: { executor: "model" | "engine"; alias: string };
    skillSet?: SkillGroups;
    framework?: string;
    generationVersion?: { id: string | null; number: number | null };
  } = {};
  if (groupBy.includes("model")) {
    dimensions.model = { provider: feedback.modelProvider, id: feedback.modelId };
  }
  if (groupBy.includes("engine")) {
    dimensions.engine = { executor: feedback.executor, alias: feedback.runtimeAlias };
  }
  if (groupBy.includes("skill-set")) dimensions.skillSet = canonicalSkillGroups(feedback.skills);
  if (groupBy.includes("framework")) dimensions.framework = feedback.framework;
  if (groupBy.includes("generation-version")) {
    dimensions.generationVersion = {
      id: feedback.versionId,
      number: feedback.versionNumber,
    };
  }
  return dimensions;
}

export function feedbackAnalyticsKey(dimensions: FeedbackAnalyticsDimensions): string {
  return JSON.stringify(sortJsonKeys(dimensions));
}

function sortJsonKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJsonKeys);
  if (!value || typeof value !== "object" || value instanceof Date) return value;
  return Object.fromEntries(
    Object.entries(value)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, sortJsonKeys(entry)]),
  );
}

function canonicalSkillGroups(skills: SkillGroups): SkillGroups {
  return Object.fromEntries(
    Object.entries(skills)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([category, values]) => [category, [...(values ?? [])]]),
  );
}

function analyticsDate(value: Date | string | undefined, label: string): Date | null {
  if (value === undefined) return null;
  const date = value instanceof Date ? new Date(value) : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new ConfigurationError(`Feedback analytics ${label} must be a valid date.`);
  }
  return date;
}

function analyticsFilter(value: string | undefined, label: string): string | null {
  return value === undefined ? null : normalizeOptionalText(value, label, 500);
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
