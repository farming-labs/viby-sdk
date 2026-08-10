import { createHmac, timingSafeEqual } from "node:crypto";
import {
  ConfigurationError,
  OutboundEventSignatureError,
  OutboundEventSinkError,
} from "./errors.js";
import type { GenerationEvent, JsonValue, UserScope } from "./types.js";

const DEFAULT_SIGNATURE_TOLERANCE_MS = 5 * 60 * 1_000;
const MIN_SECRET_BYTES = 32;

export interface OutboundEventEnvelope {
  readonly specversion: "1.0";
  readonly id: string;
  readonly type: string;
  readonly source: string;
  readonly subject: string;
  readonly time: string;
  readonly data: {
    readonly cursor: string;
    readonly tenantId: string;
    readonly userId: string;
    readonly chatId: string;
    readonly generationId: string;
    readonly attemptId: string | null;
    readonly event: JsonValue;
  };
}

export interface OutboundEventRequest {
  readonly sinkId: string;
  readonly event: OutboundEventEnvelope;
  readonly body: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}

export interface OutboundEventReceipt {
  readonly sinkId: string;
  readonly eventId: string;
  readonly cursor: string;
  readonly deliveredAt: Date;
}

export type OutboundEventDeliveryStatus =
  | "pending"
  | "delivering"
  | "delivered"
  | "dead_lettered";

export interface OutboundEventDeliveryData {
  readonly generationId: string;
  readonly eventCursor: string;
  readonly eventId: string;
  readonly sinkId: string;
  readonly status: OutboundEventDeliveryStatus;
  readonly attemptCount: number;
  readonly maxAttempts: number;
  readonly nextAttemptAt: Date;
  readonly leaseExpiresAt: Date | null;
  readonly lastError: string | null;
  readonly deliveredAt: Date | null;
  readonly deadLetteredAt: Date | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface OutboundEventRetryPolicy {
  readonly maxAttempts?: number;
  readonly initialDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly multiplier?: number;
  readonly leaseMs?: number;
}

export interface OutboundEventContext extends UserScope {
  readonly chatId: string;
  readonly generationId: string;
  readonly signal?: AbortSignal;
}

export interface OutboundEventSink {
  readonly id: string;
  deliver(event: GenerationEvent, context: OutboundEventContext): Promise<OutboundEventReceipt>;
}

export interface SignedOutboundEventSinkOptions {
  readonly id: string;
  readonly secret: string | Uint8Array;
  readonly keyId?: string;
  readonly source?: string;
  readonly send: (request: OutboundEventRequest) => void | Promise<void>;
  readonly now?: () => Date;
}

export interface VerifySignedOutboundEventOptions {
  readonly secret: string | Uint8Array;
  readonly keyId?: string;
  readonly now?: Date;
  readonly toleranceMs?: number;
}

export class SignedOutboundEventSink implements OutboundEventSink {
  readonly id: string;
  readonly #secret: Uint8Array;
  readonly #keyId: string;
  readonly #source: string;
  readonly #send: SignedOutboundEventSinkOptions["send"];
  readonly #now: () => Date;

  constructor(options: SignedOutboundEventSinkOptions) {
    if (!options || typeof options !== "object") {
      throw new ConfigurationError("Signed outbound event sink options must be an object.");
    }
    this.id = normalizeToken(options.id, "Outbound event sink id");
    this.#keyId = normalizeToken(options.keyId ?? "default", "Outbound event key id");
    this.#source = normalizeSource(options.source);
    this.#secret = normalizeSecret(options.secret);
    if (typeof options.send !== "function") {
      throw new ConfigurationError("Signed outbound event sink requires a send function.");
    }
    if (options.now !== undefined && typeof options.now !== "function") {
      throw new ConfigurationError("Signed outbound event sink now must be a function.");
    }
    this.#send = options.send;
    this.#now = options.now ?? (() => new Date());
  }

  async deliver(
    event: GenerationEvent,
    context: OutboundEventContext,
  ): Promise<OutboundEventReceipt> {
    const envelope = createOutboundEventEnvelope(event, context, this.#source);
    const body = JSON.stringify(envelope);
    const deliveredAt = this.#now();
    if (!Number.isFinite(deliveredAt.getTime())) {
      throw new ConfigurationError("Signed outbound event sink now returned an invalid date.");
    }
    const timestamp = deliveredAt.getTime().toString();
    const signature = sign(this.#secret, timestamp, envelope.id, body);
    const request: OutboundEventRequest = Object.freeze({
      sinkId: this.id,
      event: envelope,
      body,
      headers: Object.freeze({
        "content-type": "application/cloudevents+json; charset=utf-8",
        "viby-event-id": envelope.id,
        "viby-event-key-id": this.#keyId,
        "viby-event-timestamp": timestamp,
        "viby-event-signature": `v1=${signature}`,
      }),
      ...(context.signal ? { signal: context.signal } : {}),
    });
    context.signal?.throwIfAborted();
    try {
      await this.#send(request);
      context.signal?.throwIfAborted();
    } catch (error) {
      throw new OutboundEventSinkError(this.id, envelope.id, { cause: error });
    }
    return Object.freeze({
      sinkId: this.id,
      eventId: envelope.id,
      cursor: event.cursor,
      deliveredAt,
    });
  }
}

export function signedOutboundEventSink(
  options: SignedOutboundEventSinkOptions,
): OutboundEventSink {
  return new SignedOutboundEventSink(options);
}

export function verifySignedOutboundEvent(
  request: Pick<OutboundEventRequest, "body" | "headers">,
  options: VerifySignedOutboundEventOptions,
): OutboundEventEnvelope {
  if (!request || typeof request.body !== "string" || !request.headers) {
    throw new OutboundEventSignatureError("Signed event request is malformed.");
  }
  const secret = normalizeSecret(options?.secret);
  const expectedKeyId = normalizeToken(options?.keyId ?? "default", "Outbound event key id");
  const keyId = request.headers["viby-event-key-id"];
  const eventId = request.headers["viby-event-id"];
  const timestamp = request.headers["viby-event-timestamp"];
  const provided = request.headers["viby-event-signature"];
  if (!keyId || !eventId || !timestamp || !provided || keyId !== expectedKeyId) {
    throw new OutboundEventSignatureError("Signed event headers are missing or use an unknown key.");
  }
  if (!/^\d+$/.test(timestamp)) {
    throw new OutboundEventSignatureError("Signed event timestamp is invalid.");
  }
  const signedAt = Number(timestamp);
  const now = (options.now ?? new Date()).getTime();
  const toleranceMs = options.toleranceMs ?? DEFAULT_SIGNATURE_TOLERANCE_MS;
  if (!Number.isInteger(toleranceMs) || toleranceMs < 0 || toleranceMs > 24 * 60 * 60 * 1_000) {
    throw new ConfigurationError("Signature tolerance must be between 0 and 86400000 milliseconds.");
  }
  if (!Number.isFinite(signedAt) || !Number.isFinite(now) || Math.abs(now - signedAt) > toleranceMs) {
    throw new OutboundEventSignatureError("Signed event timestamp is outside the accepted window.");
  }
  const match = /^v1=([A-Za-z0-9_-]+)$/.exec(provided);
  if (!match) throw new OutboundEventSignatureError("Signed event signature is malformed.");
  const expected = Buffer.from(sign(secret, timestamp, eventId, request.body), "base64url");
  const actual = Buffer.from(match[1]!, "base64url");
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new OutboundEventSignatureError("Signed event signature does not match.");
  }
  let envelope: unknown;
  try {
    envelope = JSON.parse(request.body);
  } catch (error) {
    throw new OutboundEventSignatureError("Signed event body is not valid JSON.", { cause: error });
  }
  if (!isOutboundEventEnvelope(envelope) || envelope.id !== eventId) {
    throw new OutboundEventSignatureError("Signed event envelope is invalid.");
  }
  return envelope;
}

function createOutboundEventEnvelope(
  event: GenerationEvent,
  context: OutboundEventContext,
  source: string,
): OutboundEventEnvelope {
  return Object.freeze({
    specversion: "1.0",
    id: `${context.generationId}:${event.cursor}`,
    type: `dev.viby.generation.${event.type}`,
    source,
    subject: context.generationId,
    time: event.createdAt.toISOString(),
    data: Object.freeze({
      cursor: event.cursor,
      tenantId: context.tenantId,
      userId: context.userId,
      chatId: context.chatId,
      generationId: context.generationId,
      attemptId: event.attemptId,
      event: event.data as JsonValue,
    }),
  });
}

function sign(secret: Uint8Array, timestamp: string, eventId: string, body: string): string {
  return createHmac("sha256", secret)
    .update(timestamp)
    .update(".")
    .update(eventId)
    .update(".")
    .update(body)
    .digest("base64url");
}

function normalizeSecret(value: string | Uint8Array | undefined): Uint8Array {
  const secret = typeof value === "string"
    ? new TextEncoder().encode(value)
    : value instanceof Uint8Array
      ? new Uint8Array(value)
      : new Uint8Array();
  if (secret.byteLength < MIN_SECRET_BYTES) {
    throw new ConfigurationError(`Outbound event signing secret must contain at least ${MIN_SECRET_BYTES} bytes.`);
  }
  return secret;
}

function normalizeToken(value: string, label: string): string {
  const token = typeof value === "string" ? value.trim() : "";
  if (!/^[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/i.test(token)) {
    throw new ConfigurationError(`${label} must contain 1-64 letters, numbers, dots, dashes, or underscores.`);
  }
  return token;
}

function normalizeSource(value: string | undefined): string {
  const source = value?.trim() || "viby://sdk";
  if (source.length > 500) throw new ConfigurationError("Outbound event source cannot exceed 500 characters.");
  return source;
}

function isOutboundEventEnvelope(value: unknown): value is OutboundEventEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return record.specversion === "1.0"
    && typeof record.id === "string"
    && typeof record.type === "string"
    && typeof record.source === "string"
    && typeof record.subject === "string"
    && typeof record.time === "string"
    && !!record.data
    && typeof record.data === "object";
}
