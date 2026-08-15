import type { GenerationEvent, GenerationStreamOptions } from "./types.js";
import type { PreviewEvent, PreviewEventListener } from "./preview.js";
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

export interface PreviewEventStreamOpenOptions {
  readonly onEvent: PreviewEventListener;
  readonly signal?: AbortSignal;
}

export type PreviewEventStreamOpen<Result> = (
  options: PreviewEventStreamOpenOptions,
) => Promise<Result>;

export interface PreviewEventStreamResponseOptions {
  readonly request?: Request;
  readonly signal?: AbortSignal;
  readonly headers?: HeadersInit;
}

export type PreviewEventStreamMessage<Result> =
  | PreviewEvent
  | { readonly type: "preview.result"; readonly result: Result }
  | { readonly type: "preview.error"; readonly error: string };

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

/**
 * Stream real provider-neutral preview lifecycle and terminal output events.
 * The final frame is `preview.result`; failures are delivered as
 * `preview.error` so a response can start immediately while setup continues.
 */
export function previewEventStreamResponse<Result>(
  open: PreviewEventStreamOpen<Result>,
  options: PreviewEventStreamResponseOptions = {},
): Response {
  if (typeof open !== "function") {
    throw new ConfigurationError("Preview event streams require an open function.");
  }
  const signal = combineSignals(options.signal, options.request?.signal);
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      let closed = false;
      const enqueue = (message: PreviewEventStreamMessage<Result>) => {
        if (closed) return;
        controller.enqueue(encoder.encode(serializePreviewEvent(message)));
      };
      void open({
        onEvent: (event) => enqueue(event),
        ...(signal ? { signal } : {}),
      }).then(
        (result) => {
          enqueue({ type: "preview.result", result });
          closed = true;
          controller.close();
        },
        (error) => {
          enqueue({ type: "preview.error", error: previewErrorMessage(error) });
          closed = true;
          controller.close();
        },
      );
    },
  });
  const headers = new Headers(options.headers);
  headers.set("Content-Type", "text/event-stream; charset=utf-8");
  headers.set("Cache-Control", "no-cache, no-transform");
  headers.set("X-Accel-Buffering", "no");
  return new Response(stream, { headers });
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

function serializePreviewEvent<Result>(event: PreviewEventStreamMessage<Result>): string {
  return [
    `event: ${event.type}`,
    `data: ${JSON.stringify(event, (_key, value) => (
      value instanceof Date ? value.toISOString() : value
    ))}`,
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

function previewErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message;
  return typeof error === "string" && error.trim() ? error : "Preview failed.";
}

function combineSignals(
  first: AbortSignal | undefined,
  second: AbortSignal | undefined,
): AbortSignal | undefined {
  if (!first) return second;
  if (!second || first === second) return first;
  return AbortSignal.any([first, second]);
}
