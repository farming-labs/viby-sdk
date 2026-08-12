import { ConfigurationError } from "./errors.js";
import type {
  ChatData,
  ChatDeletionData,
  ChatMetadata,
  FrameworkId,
  GeneratedArtifactData,
  GenerationAttemptData,
  GenerationData,
  GenerationEvent,
  GenerationEventPage,
  GenerationTaskData,
  GenerationTaskResolution,
  JsonValue,
  MessageData,
  PageOptions,
  SkillGroups,
  ToolCallData,
  VersionData,
  VersionEntry,
} from "./types.js";

const DEFAULT_BASE_URL = "/api/viby";
const DEFAULT_MAX_RECONNECTS = 5;
const DEFAULT_RETRY_MS = 1_000;

export type VibyApiJson<Value> =
  Value extends Date ? string
    : Value extends Uint8Array ? never
      : Value extends readonly (infer Item)[] ? readonly VibyApiJson<Item>[]
        : Value extends object ? { readonly [Key in keyof Value]: VibyApiJson<Value[Key]> }
          : Value;

export type VibyApiChat<Framework extends FrameworkId = FrameworkId> = VibyApiJson<
  Omit<ChatData<Framework>, "tenantId" | "userId">
>;
export type VibyApiVersion<Framework extends FrameworkId = FrameworkId> = VibyApiJson<
  VersionData<Framework>
>;
export type VibyApiMessage = VibyApiJson<MessageData>;
export type VibyApiGeneration = VibyApiJson<GenerationData>;
export type VibyApiGenerationAttempt = VibyApiJson<GenerationAttemptData>;
export type VibyApiGenerationTask = VibyApiJson<GenerationTaskData>;
export type VibyApiGenerationEvent = VibyApiJson<GenerationEvent>;
export type VibyApiGeneratedArtifact = VibyApiJson<GeneratedArtifactData>;
export type VibyApiToolCall = VibyApiJson<ToolCallData>;

export interface VibyWebClientOptions {
  /** Absolute or browser-relative API URL. Defaults to /api/viby. */
  readonly baseUrl?: string | URL;
  readonly fetch?: typeof globalThis.fetch;
  readonly headers?: HeadersInit | (() => HeadersInit | Promise<HeadersInit>);
  readonly credentials?: RequestCredentials;
}

export interface VibyWebRequestOptions {
  readonly signal?: AbortSignal;
}

export interface VibyWebPageOptions extends PageOptions, VibyWebRequestOptions {}

export interface VibyWebListChatsOptions extends VibyWebPageOptions {
  readonly metadata?: ChatMetadata;
}

export interface VibyWebAttachmentInput {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
}

export interface VibyWebGenerationInput {
  readonly prompt: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly skills?: SkillGroups;
  readonly metadata?: ChatMetadata;
  readonly attachments?: readonly VibyWebAttachmentInput[];
}

export interface VibyWebCreateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
  readonly prompt?: string;
  readonly model?: string;
  readonly instructions?: string;
  readonly skills?: SkillGroups;
  readonly attachments?: readonly VibyWebAttachmentInput[];
}

export interface VibyWebUpdateChatInput {
  readonly title?: string;
  readonly metadata?: ChatMetadata;
}

export interface VibyWebDeleteChatInput {
  readonly retentionMs?: number | null;
}

export interface VibyWebGenerationReference {
  readonly id: string;
  readonly chatId: string;
}

export interface VibyWebChatPage<Framework extends FrameworkId = FrameworkId> {
  readonly chats: readonly VibyApiChat<Framework>[];
  readonly nextCursor: string | null;
}

export interface VibyWebCreateChatResult<Framework extends FrameworkId = FrameworkId> {
  readonly chat: VibyApiChat<Framework>;
  readonly generation?: VibyWebGenerationReference;
}

export interface VibyWebChatDetail<Framework extends FrameworkId = FrameworkId> {
  readonly chat: VibyApiChat<Framework>;
  readonly messages: readonly VibyApiMessage[];
  readonly messagesNextCursor: string | null;
  readonly versions: readonly VibyApiVersion<Framework>[];
  readonly versionsNextCursor: string | null;
}

export interface VibyWebMessagePage {
  readonly messages: readonly VibyApiMessage[];
  readonly nextCursor: string | null;
}

export interface VibyWebVersionPage<Framework extends FrameworkId = FrameworkId> {
  readonly versions: readonly VibyApiVersion<Framework>[];
  readonly nextCursor: string | null;
}

export interface VibyWebVersionDetail<Framework extends FrameworkId = FrameworkId> {
  readonly version: VibyApiVersion<Framework>;
  readonly entries: readonly VibyApiJson<VersionEntry>[];
}

export interface VibyWebGenerationDetail<Framework extends FrameworkId = FrameworkId> {
  readonly generation: VibyApiGeneration;
  readonly attempts: readonly VibyApiGenerationAttempt[];
  readonly tasks: readonly VibyApiGenerationTask[];
  readonly toolCalls: readonly VibyApiToolCall[];
  readonly artifacts: readonly VibyApiGeneratedArtifact[];
  readonly version: VibyApiVersion<Framework> | null;
}

export interface VibyWebStreamOptions extends VibyWebRequestOptions {
  /** Last durably handled event cursor. Sent as Last-Event-ID on every connection. */
  readonly after?: string;
  /** Consecutive premature disconnects to retry. Defaults to 5. */
  readonly maxReconnects?: number;
  /** Fallback delay when the server has not sent an SSE retry field. */
  readonly retryMs?: number;
}

export interface VibyWebChatsClient<Framework extends FrameworkId = FrameworkId> {
  list(options?: VibyWebListChatsOptions): Promise<VibyWebChatPage<Framework>>;
  create(
    input: VibyWebCreateChatInput & { readonly prompt: string },
    options?: VibyWebRequestOptions,
  ): Promise<VibyWebCreateChatResult<Framework> & { readonly generation: VibyWebGenerationReference }>;
  create(
    input?: VibyWebCreateChatInput,
    options?: VibyWebRequestOptions,
  ): Promise<VibyWebCreateChatResult<Framework>>;
  get(chatId: string, options?: VibyWebPageOptions): Promise<VibyWebChatDetail<Framework>>;
  update(
    chatId: string,
    input: VibyWebUpdateChatInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly chat: VibyApiChat<Framework> }>;
  delete(
    chatId: string,
    input?: VibyWebDeleteChatInput,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly deletion: VibyApiJson<ChatDeletionData> }>;
  readonly messages: {
    list(chatId: string, options?: VibyWebPageOptions): Promise<VibyWebMessagePage>;
    get(
      chatId: string,
      messageId: string,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly message: VibyApiMessage }>;
    create(
      chatId: string,
      input: VibyWebGenerationInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly generation: VibyWebGenerationReference }>;
  };
  readonly versions: {
    list(chatId: string, options?: VibyWebPageOptions): Promise<VibyWebVersionPage<Framework>>;
    get(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<VibyWebVersionDetail<Framework>>;
    iterate(
      chatId: string,
      versionId: string,
      input: VibyWebGenerationInput,
      options?: VibyWebRequestOptions,
    ): Promise<{ readonly generation: VibyWebGenerationReference }>;
    download(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<Response>;
    preview<Result extends JsonValue = JsonValue>(
      chatId: string,
      versionId: string,
      options?: VibyWebRequestOptions,
    ): Promise<Result>;
  };
}

export interface VibyWebGenerationsClient<Framework extends FrameworkId = FrameworkId> {
  get(generationId: string, options?: VibyWebRequestOptions): Promise<VibyWebGenerationDetail<Framework>>;
  events(
    generationId: string,
    options?: VibyWebPageOptions,
  ): Promise<VibyApiJson<GenerationEventPage>>;
  stream(
    generationId: string,
    options?: VibyWebStreamOptions,
  ): AsyncGenerator<VibyApiGenerationEvent>;
  cancel(
    generationId: string,
    reason?: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
  retry(
    generationId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
  resume(
    generationId: string,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
  resolveTask(
    generationId: string,
    taskId: string,
    resolution: GenerationTaskResolution,
    options?: VibyWebRequestOptions,
  ): Promise<{ readonly generation: VibyApiGeneration }>;
}

export interface VibyWebClient<Framework extends FrameworkId = FrameworkId> {
  readonly chats: VibyWebChatsClient<Framework>;
  readonly generations: VibyWebGenerationsClient<Framework>;
}

export class VibyApiClientError extends Error {
  readonly status: number;
  readonly code: string;
  readonly body: unknown;

  constructor(status: number, code: string, message: string, body: unknown) {
    super(message);
    this.name = "VibyApiClientError";
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

export class VibyStreamDisconnectedError extends Error {
  readonly cursor: string | undefined;
  readonly reconnects: number;

  constructor(cursor: string | undefined, reconnects: number, options?: ErrorOptions) {
    super(`Generation event stream disconnected after ${reconnects} reconnect attempts.`, options);
    this.name = "VibyStreamDisconnectedError";
    this.cursor = cursor;
    this.reconnects = reconnects;
  }
}

export class VibyStreamProtocolError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "VibyStreamProtocolError";
  }
}

/** A browser-, Worker-, Bun-, and Node-compatible client for createVibyApi(). */
export function createVibyWebClient<Framework extends FrameworkId = FrameworkId>(
  options: VibyWebClientOptions = {},
): VibyWebClient<Framework> {
  const transport = new WebClientTransport(options);
  const createChat = (input: VibyWebCreateChatInput = {}, request: VibyWebRequestOptions = {}) => (
    transport.json<VibyWebCreateChatResult<Framework>>(
      "POST",
      "/chats",
      generationBody(input),
      undefined,
      request,
    )
  );
  const chats: VibyWebChatsClient<Framework> = {
    list: (input = {}) => transport.json<VibyWebChatPage<Framework>>(
      "GET",
      "/chats",
      undefined,
      input,
      input,
    ),
    create: createChat as VibyWebChatsClient<Framework>["create"],
    get: (chatId, input = {}) => transport.json(
      "GET",
      `/chats/${segment(chatId)}`,
      undefined,
      input,
      input,
    ),
    update: (chatId, input, request = {}) => transport.json(
      "PATCH",
      `/chats/${segment(chatId)}`,
      input,
      undefined,
      request,
    ),
    delete: (chatId, input = {}, request = {}) => transport.json(
      "DELETE",
      `/chats/${segment(chatId)}`,
      input,
      undefined,
      request,
    ),
    messages: Object.freeze({
      list: (chatId: string, input: VibyWebPageOptions = {}) => transport.json<VibyWebMessagePage>(
        "GET",
        `/chats/${segment(chatId)}/messages`,
        undefined,
        input,
        input,
      ),
      get: (chatId: string, messageId: string, request: VibyWebRequestOptions = {}) => (
        transport.json<{ readonly message: VibyApiMessage }>(
          "GET",
          `/chats/${segment(chatId)}/messages/${segment(messageId)}`,
          undefined,
          undefined,
          request,
        )
      ),
      create: (chatId: string, input: VibyWebGenerationInput, request: VibyWebRequestOptions = {}) => (
        transport.json<{ readonly generation: VibyWebGenerationReference }>(
          "POST",
          `/chats/${segment(chatId)}/messages`,
          generationBody(input),
          undefined,
          request,
        )
      ),
    }),
    versions: Object.freeze({
      list: (chatId: string, input: VibyWebPageOptions = {}) => transport.json<VibyWebVersionPage<Framework>>(
        "GET",
        `/chats/${segment(chatId)}/versions`,
        undefined,
        input,
        input,
      ),
      get: (chatId: string, versionId: string, request: VibyWebRequestOptions = {}) => (
        transport.json<VibyWebVersionDetail<Framework>>(
          "GET",
          `/chats/${segment(chatId)}/versions/${segment(versionId)}`,
          undefined,
          undefined,
          request,
        )
      ),
      iterate: (
        chatId: string,
        versionId: string,
        input: VibyWebGenerationInput,
        request: VibyWebRequestOptions = {},
      ) => transport.json<{ readonly generation: VibyWebGenerationReference }>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/messages`,
        generationBody(input),
        undefined,
        request,
      ),
      download: (chatId: string, versionId: string, request: VibyWebRequestOptions = {}) => (
        transport.response(
          "GET",
          `/chats/${segment(chatId)}/versions/${segment(versionId)}/download`,
          undefined,
          undefined,
          request,
        )
      ),
      preview: <Result extends JsonValue = JsonValue>(
        chatId: string,
        versionId: string,
        request: VibyWebRequestOptions = {},
      ) => transport.json<Result>(
        "POST",
        `/chats/${segment(chatId)}/versions/${segment(versionId)}/preview`,
        undefined,
        undefined,
        request,
      ),
    }),
  };
  const generations: VibyWebGenerationsClient<Framework> = {
    get: (generationId, request = {}) => transport.json(
      "GET",
      `/generations/${segment(generationId)}`,
      undefined,
      undefined,
      request,
    ),
    events: (generationId, input = {}) => transport.json(
      "GET",
      `/generations/${segment(generationId)}/events/page`,
      undefined,
      input,
      input,
    ),
    stream: (generationId, input = {}) => generationStream(transport, generationId, input),
    cancel: (generationId, reason, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/cancel`,
      reason === undefined ? {} : { reason },
      undefined,
      request,
    ),
    retry: (generationId, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/retry`,
      {},
      undefined,
      request,
    ),
    resume: (generationId, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/resume`,
      {},
      undefined,
      request,
    ),
    resolveTask: (generationId, taskId, resolution, request = {}) => transport.json(
      "POST",
      `/generations/${segment(generationId)}/tasks/${segment(taskId)}`,
      { resolution },
      undefined,
      request,
    ),
  };
  return Object.freeze({ chats: Object.freeze(chats), generations: Object.freeze(generations) });
}

class WebClientTransport {
  readonly #baseUrl: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #headers: VibyWebClientOptions["headers"];
  readonly #credentials: RequestCredentials | undefined;

  constructor(options: VibyWebClientOptions) {
    this.#baseUrl = normalizeBaseUrl(options.baseUrl);
    this.#fetch = options.fetch ?? globalThis.fetch;
    if (typeof this.#fetch !== "function") {
      throw new ConfigurationError("createVibyWebClient requires a Web-compatible fetch implementation.");
    }
    this.#headers = options.headers;
    this.#credentials = options.credentials;
  }

  async json<Result>(
    method: string,
    path: string,
    body: unknown,
    query: object | undefined,
    options: VibyWebRequestOptions,
  ): Promise<Result> {
    const response = await this.response(method, path, body, query, options);
    try {
      return await response.json() as Result;
    } catch (error) {
      throw new VibyApiClientError(
        response.status,
        "invalid_response",
        "Viby API returned an invalid JSON response.",
        null,
      );
    }
  }

  async response(
    method: string,
    path: string,
    body: unknown,
    query: object | undefined,
    options: VibyWebRequestOptions,
    headers?: HeadersInit,
  ): Promise<Response> {
    const resolvedHeaders = new Headers(
      typeof this.#headers === "function" ? await this.#headers() : this.#headers,
    );
    for (const [name, value] of new Headers(headers)) resolvedHeaders.set(name, value);
    const init: RequestInit = {
      method,
      headers: resolvedHeaders,
      ...(this.#credentials === undefined ? {} : { credentials: this.#credentials }),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    if (body !== undefined) {
      resolvedHeaders.set("Content-Type", "application/json");
      init.body = JSON.stringify(body);
    }
    const response = await this.#fetch(this.url(path, query), init);
    if (!response.ok) throw await apiError(response);
    return response;
  }

  url(path: string, query: object | undefined): string {
    const search = queryString(query);
    return `${this.#baseUrl}${path}${search}`;
  }
}

async function* generationStream(
  transport: WebClientTransport,
  generationId: string,
  options: VibyWebStreamOptions,
): AsyncGenerator<VibyApiGenerationEvent> {
  const maxReconnects = integerOption(options.maxReconnects, "maxReconnects", DEFAULT_MAX_RECONNECTS, 0, 100);
  let retryMs = integerOption(options.retryMs, "retryMs", DEFAULT_RETRY_MS, 0, 60_000);
  let reconnects = 0;
  let cursor = options.after;
  let lastError: unknown;
  while (true) {
    options.signal?.throwIfAborted();
    let received = false;
    try {
      const response = await transport.response(
        "GET",
        `/generations/${segment(generationId)}/events`,
        undefined,
        undefined,
        options,
        {
          Accept: "text/event-stream",
          ...(cursor === undefined ? {} : { "Last-Event-ID": cursor }),
        },
      );
      if (!response.body) throw new VibyStreamProtocolError("Generation event response has no body.");
      for await (const frame of sseFrames(response.body, options.signal)) {
        if (frame.retry !== undefined) retryMs = frame.retry;
        if (frame.data === undefined) continue;
        const event = parseGenerationEvent(frame.data);
        if (frame.id !== undefined && frame.id !== event.cursor) {
          throw new VibyStreamProtocolError("Generation event cursor does not match its SSE id.");
        }
        if (cursor !== undefined && compareCursors(event.cursor, cursor) <= 0) continue;
        cursor = event.cursor;
        received = true;
        reconnects = 0;
        yield event;
        if (isTerminalEvent(event.type)) return;
      }
      lastError = undefined;
    } catch (error) {
      if (options.signal?.aborted) throw options.signal.reason;
      if (error instanceof VibyStreamProtocolError) throw error;
      if (error instanceof VibyApiClientError && !isRetryableStatus(error.status)) throw error;
      lastError = error;
    }
    if (!received) reconnects += 1;
    if (reconnects > maxReconnects) {
      throw new VibyStreamDisconnectedError(cursor, reconnects - 1, { cause: lastError });
    }
    await abortableDelay(retryMs, options.signal);
  }
}

interface SseFrame {
  readonly id?: string;
  readonly event?: string;
  readonly data?: string;
  readonly retry?: number;
}

async function* sseFrames(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let id: string | undefined;
  let event: string | undefined;
  let retry: number | undefined;
  let data: string[] = [];
  const dispatch = (): SseFrame | null => {
    if (data.length === 0 && id === undefined && event === undefined && retry === undefined) return null;
    const frame: SseFrame = {
      ...(id === undefined ? {} : { id }),
      ...(event === undefined ? {} : { event }),
      ...(data.length === 0 ? {} : { data: data.join("\n") }),
      ...(retry === undefined ? {} : { retry }),
    };
    id = undefined;
    event = undefined;
    retry = undefined;
    data = [];
    return frame;
  };
  const consume = (line: string): SseFrame | null => {
    if (line === "") return dispatch();
    if (line.startsWith(":")) return null;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const raw = separator < 0 ? "" : line.slice(separator + 1);
    const value = raw.startsWith(" ") ? raw.slice(1) : raw;
    if (field === "id" && !value.includes("\0")) id = value;
    if (field === "event") event = value;
    if (field === "data") data.push(value);
    if (field === "retry" && /^\d+$/.test(value)) retry = Math.min(Number(value), 60_000);
    return null;
  };
  try {
    while (true) {
      signal?.throwIfAborted();
      const result = await reader.read();
      buffer += decoder.decode(result.value, { stream: !result.done });
      let newline = buffer.indexOf("\n");
      while (newline >= 0) {
        const rawLine = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = consume(rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine);
        if (frame) yield frame;
        newline = buffer.indexOf("\n");
      }
      if (result.done) break;
    }
    if (buffer.length > 0) {
      const frame = consume(buffer.endsWith("\r") ? buffer.slice(0, -1) : buffer);
      if (frame) yield frame;
    }
    const frame = dispatch();
    if (frame) yield frame;
  } finally {
    reader.releaseLock();
  }
}

function parseGenerationEvent(data: string): VibyApiGenerationEvent {
  let value: Partial<VibyApiGenerationEvent> | null;
  try {
    value = JSON.parse(data) as Partial<VibyApiGenerationEvent> | null;
  } catch (error) {
    throw new VibyStreamProtocolError("Generation stream returned invalid JSON.", { cause: error });
  }
  if (!value || typeof value !== "object" || typeof value.cursor !== "string"
    || typeof value.type !== "string" || typeof value.generationId !== "string") {
    throw new VibyStreamProtocolError("Generation stream returned an invalid event.");
  }
  return value as VibyApiGenerationEvent;
}

function generationBody(input: VibyWebCreateChatInput | VibyWebGenerationInput): object {
  return {
    ...input,
    ...(input.attachments === undefined ? {} : {
      attachments: input.attachments.map((attachment) => ({
        filename: attachment.filename,
        mediaType: attachment.mediaType,
        base64: encodeBase64(attachment.bytes),
      })),
    }),
  };
}

function encodeBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.byteLength; offset += chunkSize) {
    const chunk = bytes.subarray(offset, Math.min(offset + chunkSize, bytes.byteLength));
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

function normalizeBaseUrl(value: string | URL | undefined): string {
  const url = value === undefined ? DEFAULT_BASE_URL : String(value);
  if (!url.trim() || url.includes("?") || url.includes("#")) {
    throw new ConfigurationError("baseUrl must be a URL without query parameters or a fragment.");
  }
  return url.replace(/\/+$/, "");
}

function queryString(input: object | undefined): string {
  if (!input) return "";
  const values = input as Record<string, unknown>;
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(values)) {
    if (name === "signal" || value === undefined) continue;
    query.set(name, name === "metadata" ? JSON.stringify(value) : String(value));
  }
  const result = query.toString();
  return result ? `?${result}` : "";
}

async function apiError(response: Response): Promise<VibyApiClientError> {
  let body: unknown = null;
  try {
    body = await response.clone().json();
  } catch {
    body = await response.text().catch(() => null);
  }
  const object = body && typeof body === "object" && !Array.isArray(body)
    ? body as Record<string, unknown>
    : null;
  const code = typeof object?.code === "string" ? object.code : `http_${response.status}`;
  const message = typeof object?.error === "string"
    ? object.error
    : response.statusText || `Viby API request failed with status ${response.status}.`;
  return new VibyApiClientError(response.status, code, message, body);
}

function segment(value: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigurationError("API resource ids must be non-empty strings.");
  }
  return encodeURIComponent(value);
}

function integerOption(
  value: number | undefined,
  name: string,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const result = value ?? fallback;
  if (!Number.isInteger(result) || result < minimum || result > maximum) {
    throw new ConfigurationError(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return result;
}

function compareCursors(left: string, right: string): number {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return left.localeCompare(right);
  const leftValue = BigInt(left);
  const rightValue = BigInt(right);
  return leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0;
}

function isTerminalEvent(type: string): boolean {
  return type === "generation.succeeded"
    || type === "generation.failed"
    || type === "generation.cancelled";
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429 || status >= 500;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms === 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timeout);
      reject(signal?.reason);
    };
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}
