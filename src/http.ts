import type { GenerationEvent, GenerationStreamOptions } from "./types.js";
import { ConfigurationError } from "./errors.js";

const DEFAULT_RETRY_MS = 1_000;
const encoder = new TextEncoder();

export interface GenerationEventStreamSource {
  stream(options?: GenerationStreamOptions): AsyncGenerator<GenerationEvent>;
}

export interface GenerationEventStreamResponseOptions extends GenerationStreamOptions {
  readonly request?: Request;
  readonly headers?: HeadersInit;
  readonly retryMs?: number;
}

/** Read a resumable generation cursor from the standard SSE Last-Event-ID header. */
export function generationEventCursor(
  source: Request | Headers | HeadersInit,
): string | undefined {
  const headers = source instanceof Request
    ? source.headers
    : source instanceof Headers
      ? source
      : new Headers(source);
  const cursor = headers.get("last-event-id")?.trim();
  if (!cursor) return undefined;
  if (!/^\d+$/.test(cursor)) {
    throw new ConfigurationError("Last-Event-ID must be a non-negative integer cursor.");
  }
  return cursor;
}

/** Convert Viby generation events into a Web-standard SSE ReadableStream. */
export function generationEventStream(
  generation: GenerationEventStreamSource,
  options: GenerationEventStreamResponseOptions = {},
): ReadableStream<Uint8Array> {
  const retryMs = normalizeRetryMs(options.retryMs);
  const signal = combineSignals(options.signal, options.request?.signal);
  const after = options.after ?? (options.request
    ? generationEventCursor(options.request)
    : undefined);
  const iterator = generation.stream({
    ...(after === undefined ? {} : { after }),
    ...(options.pollIntervalMs === undefined ? {} : { pollIntervalMs: options.pollIntervalMs }),
    ...(signal ? { signal } : {}),
  });
  let started = false;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!started) {
        started = true;
        controller.enqueue(encoder.encode(`retry: ${retryMs}\n\n`));
        return;
      }
      try {
        const result = await iterator.next();
        if (result.done) {
          controller.close();
          return;
        }
        controller.enqueue(encoder.encode(serializeGenerationEvent(result.value)));
      } catch (error) {
        controller.error(error);
      }
    },
    async cancel(reason) {
      await iterator.return?.(reason);
    },
  });
}

/** Return a portable Web Response suitable for Node, Bun, Deno, Workers, and web frameworks. */
export function generationEventStreamResponse(
  generation: GenerationEventStreamSource,
  options: GenerationEventStreamResponseOptions = {},
): Response {
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  return new Response(generationEventStream(generation, options), { headers });
}

function serializeGenerationEvent(event: GenerationEvent): string {
  return [
    `id: ${event.cursor}`,
    `event: ${event.type}`,
    `data: ${JSON.stringify({
      ...event,
      createdAt: event.createdAt.toISOString(),
    })}`,
    "",
    "",
  ].join("\n");
}

function normalizeRetryMs(value: number | undefined): number {
  const retryMs = value ?? DEFAULT_RETRY_MS;
  if (!Number.isInteger(retryMs) || retryMs < 100 || retryMs > 60_000) {
    throw new ConfigurationError("SSE retryMs must be an integer between 100 and 60000.");
  }
  return retryMs;
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}
