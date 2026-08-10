import {
  ConfigurationError,
  NotFoundError,
  generationEventStreamResponse,
  type FrameworkId,
  type SandboxCommand,
  type SandboxProcess,
  type SandboxReadinessOptions,
  type SandboxSession,
  type ScopedViby,
  type UserScope,
  type Version,
  type Viby,
} from "@viby/sdk";

export interface ReferenceAsset {
  readonly body: string;
  readonly contentType: string;
}

export interface ReferencePreviewRecipe {
  readonly port: number;
  readonly install?: SandboxCommand;
  readonly start: SandboxCommand;
  readonly readyPath?: string;
  readonly timeoutMs?: number;
  readonly readinessCheck?: SandboxReadinessOptions["check"];
}

export interface ReferenceAppOptions<Framework extends FrameworkId> {
  readonly viby: Viby<Framework>;
  readonly scope: UserScope;
  readonly assets?: Readonly<Record<string, ReferenceAsset>>;
  readonly preview?: ReferencePreviewRecipe;
}

export interface ReferenceApp {
  fetch(request: Request): Promise<Response>;
}

interface ActivePreview {
  readonly session: SandboxSession;
  readonly process: SandboxProcess;
  readonly url: string;
}

export function createReferenceApp<Framework extends FrameworkId>(
  options: ReferenceAppOptions<Framework>,
): ReferenceApp {
  const user = options.viby.forUser(options.scope);
  const previews = new Map<string, ActivePreview>();

  return {
    async fetch(request) {
      try {
        return await route(request, user, options, previews);
      } catch (error) {
        return errorResponse(error);
      }
    },
  };
}

async function route<Framework extends FrameworkId>(
  request: Request,
  user: ScopedViby<Framework>,
  options: ReferenceAppOptions<Framework>,
  previews: Map<string, ActivePreview>,
): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname;

  if (request.method === "GET" && path === "/api/chats") {
    const page = await user.chats.list({ limit: 30 });
    return json({
      chats: page.items.map((chat) => ({
        id: chat.id,
        title: chat.title,
        framework: chat.framework,
        metadata: chat.metadata,
        updatedAt: chat.updatedAt,
      })),
      nextCursor: page.nextCursor,
    });
  }

  if (request.method === "POST" && path === "/api/chats") {
    const body = await requestObject(request);
    const prompt = requiredString(body.prompt, "prompt", 12_000);
    const title = optionalString(body.title, "title", 200) ?? promptTitle(prompt);
    const chat = await user.chats.create({
      title,
      metadata: { surface: "reference-app" },
    });
    const generation = await chat.start({ prompt });
    return json({
      chat: { id: chat.id, title: chat.title, framework: chat.framework },
      generation: { id: generation.id, chatId: generation.chatId },
    }, 201);
  }

  const chatMatch = path.match(/^\/api\/chats\/([^/]+)$/);
  if (request.method === "GET" && chatMatch) {
    const chat = await user.chats.get(decodeURIComponent(chatMatch[1]!));
    const [messages, versions] = await Promise.all([
      chat.listMessages({ limit: 100 }),
      chat.listVersions({ limit: 100 }),
    ]);
    return json({
      chat: {
        id: chat.id,
        title: chat.title,
        framework: chat.framework,
        metadata: chat.metadata,
        updatedAt: chat.updatedAt,
      },
      messages: messages.items,
      versions: versions.items.map(versionValue),
    });
  }

  const eventsMatch = path.match(/^\/api\/generations\/([^/]+)\/events$/);
  if (request.method === "GET" && eventsMatch) {
    const generation = await user.generations.get(decodeURIComponent(eventsMatch[1]!));
    return generationEventStreamResponse(generation, { request });
  }

  const generationMatch = path.match(/^\/api\/generations\/([^/]+)$/);
  if (request.method === "GET" && generationMatch) {
    const generation = await user.generations.get(decodeURIComponent(generationMatch[1]!));
    const [data, tasks, attempts, toolCalls] = await Promise.all([
      generation.data(),
      generation.tasks(),
      generation.attempts(),
      generation.toolCalls(),
    ]);
    const version = data.status === "succeeded"
      ? await findGenerationVersion(user, generation.chatId, generation.id)
      : null;
    return json({
      generation: data,
      tasks,
      attempts,
      toolCalls,
      version: version ? versionValue(version) : null,
    });
  }

  const iterationMatch = path.match(/^\/api\/versions\/([^/]+)\/iterations$/);
  if (request.method === "POST" && iterationMatch) {
    const body = await requestObject(request);
    const chatId = requiredString(body.chatId, "chatId", 200);
    const prompt = requiredString(body.prompt, "prompt", 12_000);
    const chat = await user.chats.get(chatId);
    const version = await chat.getVersion(decodeURIComponent(iterationMatch[1]!));
    const generation = await version.startIteration({ prompt });
    return json({ generation: { id: generation.id, chatId: generation.chatId } }, 202);
  }

  const previewMatch = path.match(/^\/api\/versions\/([^/]+)\/preview$/);
  if (request.method === "POST" && previewMatch) {
    if (!options.preview) {
      return json({
        error: "Preview is not configured. Add a sandbox adapter and preview recipe in the host.",
        code: "preview_not_configured",
      }, 501);
    }
    const body = await requestObject(request);
    const chatId = requiredString(body.chatId, "chatId", 200);
    const versionId = decodeURIComponent(previewMatch[1]!);
    const existing = previews.get(versionId);
    if (existing) {
      return json({ url: existing.url, provider: existing.session.provider, cached: true });
    }
    const version = await (await user.chats.get(chatId)).getVersion(versionId);
    const active = await startPreview(version, options.preview);
    previews.set(versionId, active);
    return json({
      url: active.url,
      provider: active.session.provider,
      leaseId: active.session.leaseId,
      cached: false,
    }, 201);
  }

  const downloadMatch = path.match(/^\/api\/versions\/([^/]+)\/download$/);
  if (request.method === "GET" && downloadMatch) {
    const chatId = requiredString(url.searchParams.get("chatId"), "chatId", 200);
    const version = await (await user.chats.get(chatId)).getVersion(
      decodeURIComponent(downloadMatch[1]!),
    );
    const artifact = await version.download();
    return artifact.toResponse({
      headers: {
        "Cache-Control": "no-store",
      },
    });
  }

  if (request.method === "GET") {
    const key = path === "/" ? "/index.html" : path;
    const asset = options.assets?.[key];
    if (asset) {
      return new Response(asset.body, {
        headers: { "Content-Type": asset.contentType, "Cache-Control": "no-cache" },
      });
    }
  }

  return json({ error: "Route not found.", code: "not_found" }, 404);
}

async function startPreview<Framework extends FrameworkId>(
  version: Version<Framework>,
  recipe: ReferencePreviewRecipe,
): Promise<ActivePreview> {
  const session = await version.sandbox({ ports: [recipe.port] });
  try {
    if (!session.capabilities.commands || !session.capabilities.backgroundProcesses
      || !session.capabilities.portUrls) {
      throw new ConfigurationError(
        `Sandbox provider ${session.provider} needs commands, backgroundProcesses, and portUrls for previews.`,
      );
    }
    if (recipe.install) {
      const installation = await session.run(recipe.install);
      if (installation.exitCode !== 0) {
        throw new Error(`Dependency installation failed: ${installation.stderr || installation.stdout}`);
      }
    }
    const process = await session.start(recipe.start);
    const url = await session.waitForPort(recipe.port, {
      path: recipe.readyPath ?? "/",
      timeoutMs: recipe.timeoutMs ?? 120_000,
      ...(recipe.readinessCheck ? { check: recipe.readinessCheck } : {}),
    });
    return { session, process, url };
  } catch (error) {
    await session.stop().catch(() => undefined);
    throw error;
  }
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

async function requestObject(request: Request): Promise<Record<string, unknown>> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > 128_000) {
    throw new ConfigurationError("Request body cannot exceed 128 KB.");
  }
  let value: unknown;
  try {
    value = await request.json();
  } catch {
    throw new ConfigurationError("Request body must be valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ConfigurationError("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, name: string, max: number): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new ConfigurationError(`${name} must be a non-empty string.`);
  }
  const normalized = value.trim();
  if (normalized.length > max) throw new ConfigurationError(`${name} cannot exceed ${max} characters.`);
  return normalized;
}

function optionalString(value: unknown, name: string, max: number): string | undefined {
  return value === undefined ? undefined : requiredString(value, name, max);
}

function promptTitle(prompt: string): string {
  const line = prompt.split(/\r?\n/, 1)[0]!.trim();
  return line.length <= 72 ? line : `${line.slice(0, 69).trimEnd()}…`;
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

function errorResponse(error: unknown): Response {
  const message = error instanceof Error ? error.message : "Unexpected application error.";
  const status = error instanceof NotFoundError
    ? 404
    : error instanceof ConfigurationError
      ? 400
      : 500;
  return json({ error: message, code: status === 500 ? "internal_error" : "invalid_request" }, status);
}
