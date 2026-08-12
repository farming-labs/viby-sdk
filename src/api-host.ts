import type {
  Chat,
  Generation,
  ScopedViby,
  Version,
  Viby,
} from "./client.js";
import {
  ConfigurationError,
  GenerationStateError,
  NotFoundError,
  VibyError,
} from "./errors.js";
import { generationEventStreamResponse } from "./http.js";
import type {
  AttachmentInput,
  ChatMetadata,
  FrameworkId,
  GenerateInput,
  GenerationTaskResolution,
  JsonValue,
  SkillGroups,
  UserScope,
} from "./types.js";

const DEFAULT_BASE_PATH = "/api/viby";
const DEFAULT_BODY_BYTES = 10 * 1024 * 1024;

export type VibyApiAuthenticationResult = UserScope | Response | null;

export interface VibyApiPreviewContext<Framework extends FrameworkId = FrameworkId> {
  readonly request: Request;
  readonly scope: UserScope;
  readonly viby: ScopedViby<Framework>;
  readonly chat: Chat<Framework>;
  readonly version: Version<Framework>;
}

export type VibyApiPreviewResult = JsonValue | Response;

export interface VibyApiOptions<Framework extends FrameworkId = FrameworkId> {
  readonly viby: Viby<Framework>;
  /** Authenticate the request or return a complete denial/redirect Response. */
  readonly authenticate: (
    request: Request,
  ) => VibyApiAuthenticationResult | Promise<VibyApiAuthenticationResult>;
  /** Defaults to /api/viby. */
  readonly basePath?: string;
  readonly maxBodyBytes?: number;
  readonly headers?: HeadersInit;
  /** Host-owned preview lifecycle. Omit to return preview_not_configured. */
  readonly preview?: (
    context: VibyApiPreviewContext<Framework>,
  ) => VibyApiPreviewResult | Promise<VibyApiPreviewResult>;
  readonly onError?: (error: unknown, request: Request) => void | Promise<void>;
}

export interface VibyApi {
  fetch(request: Request): Promise<Response>;
}

/** A framework-neutral Web Request/Response host for the common Viby product API. */
export function createVibyApi<Framework extends FrameworkId>(
  options: VibyApiOptions<Framework>,
): VibyApi {
  if (!options?.viby || typeof options.viby.forUser !== "function") {
    throw new ConfigurationError("createVibyApi requires a Viby client.");
  }
  if (typeof options.authenticate !== "function") {
    throw new ConfigurationError("createVibyApi requires authenticate(request).");
  }
  const basePath = normalizeBasePath(options.basePath);
  const maxBodyBytes = normalizeBodyLimit(options.maxBodyBytes);
  return Object.freeze({
    async fetch(request: Request): Promise<Response> {
      try {
        if (!(request instanceof Request)) {
          throw new ConfigurationError("Viby API fetch requires a Web Request.");
        }
        const path = routePath(new URL(request.url).pathname, basePath);
        if (path === null) return withHeaders(notFound(), options.headers);

        // OAuth callbacks authenticate through their single-use state and provider flow.
        if (path === "/integrations/callback" && (request.method === "GET" || request.method === "POST")) {
          const result = await options.viby.integrations.callback(request);
          return withHeaders(json(result), options.headers);
        }

        const authenticated = await options.authenticate(request);
        if (authenticated instanceof Response) return withHeaders(authenticated, options.headers);
        if (!authenticated) {
          return withHeaders(json({ error: "Authentication required.", code: "unauthorized" }, 401), options.headers);
        }
        const user = options.viby.forUser(authenticated);
        return withHeaders(await route(
          request,
          path,
          authenticated,
          user,
          options,
          maxBodyBytes,
        ), options.headers);
      } catch (error) {
        await options.onError?.(error, request);
        return withHeaders(errorResponse(error), options.headers);
      }
    },
  });
}

export const vibyApi = createVibyApi;

async function route<Framework extends FrameworkId>(
  request: Request,
  path: string,
  scope: UserScope,
  user: ScopedViby<Framework>,
  options: VibyApiOptions<Framework>,
  maxBodyBytes: number,
): Promise<Response> {
  const url = new URL(request.url);
  const segments = path.split("/").filter(Boolean).map(decodeSegment);

  if (segments.length === 1 && segments[0] === "chats") {
    if (request.method === "GET") {
      const page = await user.chats.list({
        ...pageOptions(url),
        ...(url.searchParams.has("metadata")
          ? { metadata: queryObject(url, "metadata") as ChatMetadata }
          : {}),
      });
      return json({ chats: page.items.map(chatValue), nextCursor: page.nextCursor });
    }
    if (request.method === "POST") {
      const body = await requestObject(request, maxBodyBytes);
      const chat = await user.chats.create({
        ...(body.title === undefined ? {} : { title: requiredString(body.title, "title", 200) }),
        ...(body.metadata === undefined ? {} : { metadata: jsonObject(body.metadata, "metadata") }),
      });
      if (body.prompt === undefined) return json({ chat: chatValue(chat) }, 201);
      const generation = await chat.start(generateInput(body));
      return json({ chat: chatValue(chat), generation: generationValue(generation) }, 201);
    }
    return methodNotAllowed("GET, POST");
  }

  if (segments[0] === "chats" && segments[1]) {
    const chat = await user.chats.get(segments[1]);
    if (segments.length === 2) {
      if (request.method === "GET") {
        const [messages, versions] = await Promise.all([
          chat.listMessages(pageOptions(url)),
          chat.listVersions(pageOptions(url)),
        ]);
        return json({
          chat: chatValue(chat),
          messages: messages.items,
          messagesNextCursor: messages.nextCursor,
          versions: versions.items.map(versionValue),
          versionsNextCursor: versions.nextCursor,
        });
      }
      if (request.method === "PATCH") {
        const body = await requestObject(request, maxBodyBytes);
        const updated = await chat.update({
          ...(body.title === undefined ? {} : { title: requiredString(body.title, "title", 200) }),
          ...(body.metadata === undefined ? {} : { metadata: jsonObject(body.metadata, "metadata") }),
        });
        return json({ chat: chatValue(updated) });
      }
      if (request.method === "DELETE") {
        const body = await optionalRequestObject(request, maxBodyBytes);
        const deleted = await chat.delete({
          ...(body.retentionMs === undefined
            ? {}
            : { retentionMs: nullableInteger(body.retentionMs, "retentionMs") }),
        });
        return json({ deletion: deleted });
      }
      return methodNotAllowed("GET, PATCH, DELETE");
    }

    if (segments[2] === "messages") {
      if (segments.length === 3 && request.method === "GET") {
        const page = await chat.listMessages(pageOptions(url));
        return json({ messages: page.items, nextCursor: page.nextCursor });
      }
      if (segments.length === 3 && request.method === "POST") {
        const generation = await chat.start(generateInput(await requestObject(request, maxBodyBytes)));
        return json({ generation: generationValue(generation) }, 202);
      }
      if (segments.length === 4 && request.method === "GET") {
        return json({ message: await chat.getMessage(segments[3]!) });
      }
      return methodNotAllowed("GET, POST");
    }

    if (segments[2] === "versions") {
      if (segments.length === 3 && request.method === "GET") {
        const page = await chat.listVersions(pageOptions(url));
        return json({ versions: page.items.map(versionValue), nextCursor: page.nextCursor });
      }
      if (!segments[3]) return methodNotAllowed("GET");
      const version = await chat.getVersion(segments[3]);
      if (segments.length === 4 && request.method === "GET") {
        return json({ version: versionValue(version), entries: await version.entries() });
      }
      if (segments[4] === "messages" && segments.length === 5 && request.method === "POST") {
        const generation = await version.startIteration(
          generateInput(await requestObject(request, maxBodyBytes)),
        );
        return json({ generation: generationValue(generation) }, 202);
      }
      if (segments[4] === "download" && segments.length === 5 && request.method === "GET") {
        return (await version.download()).toResponse({ headers: { "Cache-Control": "no-store" } });
      }
      if (segments[4] === "preview" && segments.length === 5 && request.method === "POST") {
        if (!options.preview) {
          return json({
            error: "Preview is not configured by this host.",
            code: "preview_not_configured",
          }, 501);
        }
        const result = await options.preview({ request, scope, viby: user, chat, version });
        return result instanceof Response ? result : json(result, 201);
      }
      return methodNotAllowed("GET, POST");
    }
  }

  if (segments[0] === "generations" && segments[1]) {
    const generation = await user.generations.get(segments[1]);
    if (segments.length === 2 && request.method === "GET") {
      const [data, attempts, tasks, toolCalls, artifacts] = await Promise.all([
        generation.data(),
        generation.attempts(),
        generation.tasks(),
        generation.toolCalls(),
        generation.artifacts(),
      ]);
      const version = data.status === "succeeded"
        ? await findGenerationVersion(user, generation.chatId, generation.id)
        : null;
      return json({
        generation: data,
        attempts,
        tasks,
        toolCalls,
        artifacts,
        version: version ? versionValue(version) : null,
      });
    }
    if (segments[2] === "events") {
      if (segments.length === 3 && request.method === "GET") {
        return generationEventStreamResponse(generation, { request });
      }
      if (segments[3] === "page" && segments.length === 4 && request.method === "GET") {
        return json(await generation.events({
          ...(url.searchParams.has("after") ? { after: url.searchParams.get("after")! } : {}),
          ...(url.searchParams.has("limit") ? { limit: queryInteger(url, "limit") } : {}),
        }));
      }
      return methodNotAllowed("GET");
    }
    if (segments.length === 3 && request.method === "POST") {
      if (segments[2] === "cancel") {
        const body = await optionalRequestObject(request, maxBodyBytes);
        return json({ generation: await generation.cancel(
          body.reason === undefined ? undefined : requiredString(body.reason, "reason", 2_000),
        ) });
      }
      if (segments[2] === "retry") {
        await generation.retry();
        return json({ generation: await generation.data() }, 202);
      }
      if (segments[2] === "resume") {
        await generation.resume();
        return json({ generation: await generation.data() }, 202);
      }
    }
    if (segments[2] === "tasks" && segments[3] && segments.length === 4 && request.method === "POST") {
      const body = await requestObject(request, maxBodyBytes);
      await generation.resolve({
        taskId: segments[3],
        resolution: jsonObject(body.resolution, "resolution") as unknown as GenerationTaskResolution,
      });
      return json({ generation: await generation.data() }, 202);
    }
    return methodNotAllowed("GET, POST");
  }

  // Compact version routes are aliases for hosts that keep chatId in UI state.
  if (segments[0] === "versions" && segments[1] && segments[2]) {
    const body = request.method === "POST"
      ? await requestObject(request, maxBodyBytes)
      : {};
    const chatId = request.method === "GET"
      ? requiredString(url.searchParams.get("chatId"), "chatId", 200)
      : requiredString(body.chatId, "chatId", 200);
    const chat = await user.chats.get(chatId);
    const version = await chat.getVersion(segments[1]);
    if (segments[2] === "iterations" && request.method === "POST") {
      const generation = await version.startIteration(generateInput(body));
      return json({ generation: generationValue(generation) }, 202);
    }
    if (segments[2] === "download" && request.method === "GET") {
      return (await version.download()).toResponse({ headers: { "Cache-Control": "no-store" } });
    }
    if (segments[2] === "preview" && request.method === "POST") {
      if (!options.preview) {
        return json({
          error: "Preview is not configured by this host.",
          code: "preview_not_configured",
        }, 501);
      }
      const result = await options.preview({ request, scope, viby: user, chat, version });
      return result instanceof Response ? result : json(result, 201);
    }
    return methodNotAllowed("GET, POST");
  }

  return notFound();
}

async function findGenerationVersion<Framework extends FrameworkId>(
  user: ScopedViby<Framework>,
  chatId: string,
  generationId: string,
): Promise<Version<Framework> | null> {
  const chat = await user.chats.get(chatId);
  let after: string | undefined;
  do {
    const page = await chat.listVersions({ limit: 100, ...(after ? { after } : {}) });
    const version = page.items.find((candidate) => candidate.generationId === generationId);
    if (version) return version;
    after = page.nextCursor ?? undefined;
  } while (after);
  return null;
}

function generateInput(body: Record<string, unknown>): GenerateInput {
  return {
    prompt: requiredString(body.prompt, "prompt", 100_000),
    ...(body.model === undefined ? {} : { model: requiredString(body.model, "model", 100) }),
    ...(body.instructions === undefined
      ? {}
      : { instructions: requiredString(body.instructions, "instructions", 100_000) }),
    ...(body.skills === undefined
      ? {}
      : { skills: jsonObject(body.skills, "skills") as unknown as SkillGroups }),
    ...(body.metadata === undefined
      ? {}
      : { metadata: jsonObject(body.metadata, "metadata") }),
    ...(body.attachments === undefined
      ? {}
      : { attachments: attachments(body.attachments) }),
  };
}

function attachments(value: unknown): readonly AttachmentInput[] {
  if (!Array.isArray(value)) throw new ConfigurationError("attachments must be an array.");
  return value.map((candidate, index) => {
    const input = jsonObject(candidate, `attachments[${index}]`) as Record<string, unknown>;
    return {
      filename: requiredString(input.filename, `attachments[${index}].filename`, 500),
      mediaType: requiredString(input.mediaType, `attachments[${index}].mediaType`, 200),
      bytes: decodeBase64(requiredString(input.base64, `attachments[${index}].base64`, 15_000_000)),
    };
  });
}

function decodeBase64(value: string): Uint8Array {
  try {
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
      throw new Error("invalid base64");
    }
    return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
  } catch (error) {
    throw new ConfigurationError("attachment base64 must be valid standard base64.", { cause: error });
  }
}

function chatValue<Framework extends FrameworkId>(chat: Chat<Framework>) {
  return {
    id: chat.id,
    title: chat.title,
    framework: chat.framework,
    metadata: chat.metadata,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
  };
}

function generationValue<Framework extends FrameworkId>(generation: Generation<Framework>) {
  return { id: generation.id, chatId: generation.chatId };
}

function versionValue<Framework extends FrameworkId>(version: Version<Framework>) {
  return {
    id: version.id,
    chatId: version.chatId,
    generationId: version.generationId,
    parentVersionId: version.parentVersionId,
    number: version.number,
    origin: version.origin,
    framework: version.framework,
    title: version.title,
    summary: version.summary,
    createdAt: version.createdAt,
  };
}

async function requestObject(request: Request, maxBytes: number): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new ApiBodyTooLargeError(maxBytes);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ApiBodyTooLargeError(maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigurationError("Request body must be valid JSON.", { cause: error });
  }
  return jsonObject(parsed, "Request body") as Record<string, unknown>;
}

async function optionalRequestObject(
  request: Request,
  maxBytes: number,
): Promise<Record<string, unknown>> {
  if (!request.body && !request.headers.get("content-length")) return {};
  const text = await request.text();
  if (!text.trim()) return {};
  if (new TextEncoder().encode(text).byteLength > maxBytes) throw new ApiBodyTooLargeError(maxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new ConfigurationError("Request body must be valid JSON.", { cause: error });
  }
  return jsonObject(parsed, "Request body") as Record<string, unknown>;
}

function pageOptions(url: URL): { readonly limit?: number; readonly after?: string } {
  return {
    ...(url.searchParams.has("limit") ? { limit: queryInteger(url, "limit") } : {}),
    ...(url.searchParams.has("after") ? { after: url.searchParams.get("after")! } : {}),
  };
}

function queryInteger(url: URL, name: string): number {
  const value = url.searchParams.get(name);
  if (!value || !/^\d+$/.test(value)) {
    throw new ConfigurationError(`${name} must be a non-negative integer.`);
  }
  return Number(value);
}

function queryObject(url: URL, name: string): Readonly<Record<string, JsonValue>> {
  try {
    return jsonObject(JSON.parse(url.searchParams.get(name)!), name);
  } catch (error) {
    if (error instanceof ConfigurationError) throw error;
    throw new ConfigurationError(`${name} must be a JSON-encoded object.`, { cause: error });
  }
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new ConfigurationError(`${name} cannot exceed ${max} characters.`);
  return normalized;
}

function jsonObject(value: unknown, name: string): Readonly<Record<string, JsonValue>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError(`${name} must be a JSON object.`);
  }
  try {
    return JSON.parse(JSON.stringify(value)) as Readonly<Record<string, JsonValue>>;
  } catch (error) {
    throw new ConfigurationError(`${name} must be JSON serializable.`, { cause: error });
  }
}

function nullableInteger(value: unknown, name: string): number | null {
  if (value === null) return null;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw new ConfigurationError(`${name} must be a non-negative integer or null.`);
  }
  return value as number;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch (error) {
    throw new ConfigurationError("Route contains an invalid encoded path segment.", { cause: error });
  }
}

function normalizeBasePath(value: string | undefined): string {
  const path = value ?? DEFAULT_BASE_PATH;
  if (!path.startsWith("/") || path.includes("?") || path.includes("#")) {
    throw new ConfigurationError("basePath must be an absolute URL path.");
  }
  return path === "/" ? "" : path.replace(/\/+$/, "");
}

function normalizeBodyLimit(value: number | undefined): number {
  const limit = value ?? DEFAULT_BODY_BYTES;
  if (!Number.isInteger(limit) || limit < 1_024 || limit > 100 * 1024 * 1024) {
    throw new ConfigurationError("maxBodyBytes must be between 1024 and 104857600.");
  }
  return limit;
}

function routePath(pathname: string, basePath: string): string | null {
  if (!basePath) return pathname;
  if (pathname === basePath) return "/";
  return pathname.startsWith(`${basePath}/`) ? pathname.slice(basePath.length) : null;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function notFound(): Response {
  return json({ error: "Route not found.", code: "not_found" }, 404);
}

function methodNotAllowed(allow: string): Response {
  const response = json({ error: "Method not allowed.", code: "method_not_allowed" }, 405);
  response.headers.set("Allow", allow);
  return response;
}

function withHeaders(response: Response, values: HeadersInit | undefined): Response {
  if (!values) return response;
  const headers = new Headers(response.headers);
  for (const [name, value] of new Headers(values)) headers.set(name, value);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

function errorResponse(error: unknown): Response {
  const status = error instanceof ApiBodyTooLargeError
    ? 413
    : error instanceof NotFoundError
      ? 404
      : error instanceof GenerationStateError
        ? 409
        : error instanceof ConfigurationError
          ? 400
          : 500;
  const message = error instanceof Error ? error.message : "Unexpected Viby API error.";
  const code = error instanceof ApiBodyTooLargeError
    ? "body_too_large"
    : error instanceof VibyError
      ? error.code
      : status === 500
        ? "internal_error"
        : "invalid_request";
  return json({ error: message, code }, status);
}

class ApiBodyTooLargeError extends Error {
  constructor(limit: number) {
    super(`Request body cannot exceed ${limit} bytes.`);
    this.name = "ApiBodyTooLargeError";
  }
}
