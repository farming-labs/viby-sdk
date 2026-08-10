import assert from "node:assert/strict";
import { test } from "node:test";
import {
  generationEventCursor,
  generationEventStreamResponse,
  type GenerationEventStreamSource,
} from "../src/http.js";
import { ConfigurationError } from "../src/errors.js";
import type { GenerationEvent, GenerationStreamOptions } from "../src/types.js";

const events: GenerationEvent[] = [
  {
    cursor: "8",
    generationId: "generation-1",
    attemptId: "attempt-1",
    type: "output.delta",
    data: { delta: "hello" },
    createdAt: new Date("2026-08-10T10:00:00.000Z"),
  },
  {
    cursor: "9",
    generationId: "generation-1",
    attemptId: "attempt-1",
    type: "generation.succeeded",
    data: { versionId: "version-1" },
    createdAt: new Date("2026-08-10T10:00:01.000Z"),
  },
];

test("creates a resumable Web-standard SSE response", async () => {
  let received: GenerationStreamOptions | undefined;
  const source: GenerationEventStreamSource = {
    async *stream(options) {
      received = options;
      for (const event of events) yield event;
    },
  };
  const request = new Request("https://example.test/events", {
    headers: { "Last-Event-ID": "7" },
  });
  const response = generationEventStreamResponse(source, {
    request,
    retryMs: 2_000,
    pollIntervalMs: 25,
    headers: { "x-product": "reference" },
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream; charset=utf-8");
  assert.equal(response.headers.get("cache-control"), "no-cache, no-transform");
  assert.equal(response.headers.get("x-accel-buffering"), "no");
  assert.equal(response.headers.get("x-product"), "reference");

  const body = await response.text();
  assert.match(body, /^retry: 2000\n\n/);
  assert.match(body, /id: 8\nevent: output\.delta\n/);
  assert.match(body, /"createdAt":"2026-08-10T10:00:00\.000Z"/);
  assert.match(body, /id: 9\nevent: generation\.succeeded\n/);
  assert.equal(received?.after, "7");
  assert.equal(received?.pollIntervalMs, 25);
  assert.equal(received?.signal, request.signal);
});

test("prefers an explicit cursor and validates Last-Event-ID", async () => {
  let after: string | undefined;
  const source: GenerationEventStreamSource = {
    async *stream(options) {
      after = options?.after;
    },
  };
  const request = new Request("https://example.test/events", {
    headers: { "Last-Event-ID": "5" },
  });
  await generationEventStreamResponse(source, { request, after: "12" }).text();
  assert.equal(after, "12");
  assert.equal(generationEventCursor(new Headers({ "Last-Event-ID": "0" })), "0");
  assert.throws(
    () => generationEventCursor({ "Last-Event-ID": "cursor-seven" }),
    ConfigurationError,
  );
});

test("validates the SSE retry interval", () => {
  const source: GenerationEventStreamSource = {
    async *stream() {},
  };
  assert.throws(
    () => generationEventStreamResponse(source, { retryMs: 99 }),
    ConfigurationError,
  );
});
