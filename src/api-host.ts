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
  ImportFilePolicy,
  ImportProjectInput,
  JsonValue,
  SkillGroups,
  SourceEntryInput,
  UserScope,
} from "./types.js";
import type { IntegrationCategory, IntegrationSourceFile } from "./integrations.js";

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

  if (segments[0] === "integrations") {
    return integrationRoute(request, segments, url, user, maxBodyBytes);
  }

  if (segments.length === 2 && segments[0] === "chats" && segments[1] === "imports") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const imported = await importChat(user, await requestObject(request, maxBodyBytes), request.signal);
    return json({ chat: chatValue(imported.chat), version: versionValue(imported.version) }, 201);
  }

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

    if (segments[2] === "attachments" && segments[3] && segments.length === 4) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return binaryResponse(await chat.getAttachment(segments[3]));
    }

    if (segments[2] === "environment") {
      if (segments.length === 3 && request.method === "GET") {
        return json({ variables: await chat.environment.list({
          ...(url.searchParams.has("environment")
            ? { environment: requiredString(url.searchParams.get("environment"), "environment", 100) }
            : {}),
        }) });
      }
      if (segments[3] && segments[4] && segments.length === 5) {
        const environment = segments[3];
        const name = segments[4];
        if (request.method === "PUT") {
          const body = await requestObject(request, maxBodyBytes);
          return json({ variable: await chat.environment.set({
            environment,
            name,
            value: stringValue(body.value, "value", 64_000),
            ...(body.secret === undefined ? {} : { secret: booleanValue(body.secret, "secret") }),
          }) });
        }
        if (request.method === "DELETE") {
          return json({ deleted: await chat.environment.delete({ environment, name }) });
        }
        return methodNotAllowed("PUT, DELETE");
      }
      return methodNotAllowed("GET, PUT, DELETE");
    }

    if (segments.length === 3 && request.method === "GET") {
      if (segments[2] === "repository-links") {
        return json({ links: await chat.repositoryLinks() });
      }
      if (segments[2] === "repository-pushes") {
        return json({ pushes: await chat.repositoryPushes() });
      }
      if (segments[2] === "deployment-projects") {
        return json({ projects: await chat.deploymentProjects() });
      }
      if (segments[2] === "deployments") {
        return json({ deployments: await chat.deployments() });
      }
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
      if (segments[4] === "artifacts" && segments[5] && segments.length === 6) {
        if (request.method !== "GET") return methodNotAllowed("GET");
        const artifact = await version.projectArtifact(segments[5]);
        return binaryResponse({ ...artifact, filename: segments[5] });
      }
      if (segments[4] === "visual-artifacts") {
        if (segments.length === 5 && request.method === "GET") {
          return json({ artifacts: await version.visualArtifacts() });
        }
        if (segments[5] && segments.length === 6 && request.method === "GET") {
          return binaryResponse(await version.getVisualArtifact(segments[5]));
        }
        return methodNotAllowed("GET");
      }
      if (segments[4] === "repository-pushes") {
        if (segments.length === 5 && request.method === "GET") {
          return json({ pushes: await version.repositoryPushes() });
        }
        if (segments.length === 5 && request.method === "POST") {
          const result = await pushVersion(
            user,
            version,
            await requestObject(request, maxBodyBytes),
            request.signal,
          );
          return json({ result }, result.status === "conflict" ? 409 : 201);
        }
        return methodNotAllowed("GET, POST");
      }
      if (segments[4] === "deployments") {
        if (segments.length === 5 && request.method === "GET") {
          return json({ deployments: await version.deployments() });
        }
        if (segments.length === 5 && request.method === "POST") {
          const deployment = await deployVersion(
            user,
            version,
            await requestObject(request, maxBodyBytes),
            request.signal,
          );
          return json({ deployment }, 201);
        }
        if (segments[5] && segments[6] === "artifact" && segments.length === 7) {
          if (request.method !== "GET") return methodNotAllowed("GET");
          const artifact = await version.deploymentArtifact(segments[5]);
          if (!artifact) throw new NotFoundError("Deployment artifact");
          return binaryResponse({ ...artifact, filename: `${segments[5]}.zip` });
        }
        return methodNotAllowed("GET, POST");
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
    if (segments[2] === "artifacts" && segments[3] && segments.length === 4) {
      if (request.method !== "GET") return methodNotAllowed("GET");
      return binaryResponse(await generation.getArtifact(segments[3]));
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

async function importChat<Framework extends FrameworkId>(
  user: ScopedViby<Framework>,
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<{ readonly chat: Chat<Framework>; readonly version: Version<Framework> }> {
  const source = jsonObject(body.source, "source") as Record<string, unknown>;
  const common = {
    ...(body.title === undefined ? {} : { title: requiredString(body.title, "title", 200) }),
    ...(body.summary === undefined ? {} : { summary: requiredString(body.summary, "summary", 2_000) }),
    ...(body.metadata === undefined ? {} : { metadata: jsonObject(body.metadata, "metadata") }),
    ...(body.filePolicy === undefined ? {} : { filePolicy: importFilePolicy(body.filePolicy) }),
  };
  let input: ImportProjectInput;
  if (source.type === "files") {
    input = { ...common, source: { type: "files", files: sourceEntries(source.files) } };
  } else if (source.type === "zip") {
    input = {
      ...common,
      source: {
        type: "zip",
        bytes: decodeBase64(requiredString(source.base64, "source.base64", 150_000_000)),
      },
    };
  } else if (source.type === "repository") {
    const integrationId = requiredString(source.integrationId, "source.integrationId", 64);
    const connectionId = source.connectionId === undefined
      ? undefined
      : requiredString(source.connectionId, "source.connectionId", 200);
    const repository = jsonObject(source.repository, "source.repository") as Record<string, unknown>;
    const reference = repositoryReference(source.ref, "source.ref");
    const remote = await user.integrations.repository.use(integrationId, {
      ...(connectionId ? { connectionId } : {}),
    }).readSource({
      repository: {
        owner: requiredString(repository.owner, "source.repository.owner", 200),
        name: requiredString(repository.name, "source.repository.name", 200),
      },
      ref: reference,
    }, signal);
    input = {
      ...common,
      title: common.title ?? remote.repository.name,
      summary: common.summary ?? `Imported ${remote.repository.owner}/${remote.repository.name} at ${remote.commit}.`,
      source: { type: "files", files: repositorySourceEntries(remote.files) },
    };
  } else {
    throw new ConfigurationError("source.type must be files, zip, or repository.");
  }
  const chat = await user.chats.import(input);
  const version = await chat.latestVersion();
  if (!version) throw new NotFoundError("Imported version");
  return { chat, version };
}

async function integrationRoute<Framework extends FrameworkId>(
  request: Request,
  segments: readonly string[],
  url: URL,
  user: ScopedViby<Framework>,
  maxBodyBytes: number,
): Promise<Response> {
  if (segments.length === 1) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    const [repository, deployment] = await Promise.all([
      user.integrations.repository.list(),
      user.integrations.deployment.list(),
    ]);
    return json({ repository, deployment });
  }
  const category = integrationCategory(segments[1]);
  const integrations = user.integrations[category];
  if (segments.length === 2) {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ integrations: await integrations.list() });
  }
  const integrationId = requiredString(segments[2], "integrationId", 64);
  if (segments.length === 4 && segments[3] === "connections") {
    if (request.method !== "GET") return methodNotAllowed("GET");
    return json({ connections: await integrations.connections(integrationId) });
  }
  if (segments.length === 4 && segments[3] === "connect") {
    if (request.method !== "POST") return methodNotAllowed("POST");
    const body = await requestObject(request, maxBodyBytes);
    return json({ result: await integrations.connect(integrationId, {
      callbackUrl: requiredString(body.callbackUrl, "callbackUrl", 2_000),
      returnTo: requiredString(body.returnTo, "returnTo", 2_000),
      ...(body.scopes === undefined ? {} : { scopes: stringArray(body.scopes, "scopes", 200) }),
      ...(body.force === undefined ? {} : { force: booleanValue(body.force, "force") }),
      signal: request.signal,
    }) });
  }
  if (segments.length === 5 && segments[3] === "connections") {
    if (request.method !== "DELETE") return methodNotAllowed("DELETE");
    return json({ result: await integrations.disconnect(integrationId, {
      connectionId: requiredString(segments[4], "connectionId", 200),
      signal: request.signal,
    }) });
  }
  const connectionId = url.searchParams.has("connectionId")
    ? requiredString(url.searchParams.get("connectionId"), "connectionId", 200)
    : undefined;
  if (category === "repository") {
    const handle = user.integrations.repository.use(integrationId, {
      ...(connectionId ? { connectionId } : {}),
    });
    if (segments.length === 4 && segments[3] === "owners" && request.method === "GET") {
      return json(await handle.owners.list(providerPage(url), request.signal));
    }
    if (segments.length === 4 && segments[3] === "repositories") {
      if (request.method === "GET") {
        return json(await handle.repositories.list({
          ...providerPage(url),
          ...(url.searchParams.has("owner") ? { owner: url.searchParams.get("owner")! } : {}),
          ...(url.searchParams.has("search") ? { search: url.searchParams.get("search")! } : {}),
        }, request.signal));
      }
      if (request.method === "POST") {
        const body = await requestObject(request, maxBodyBytes);
        return json({ repository: await handle.repositories.create({
          owner: requiredString(body.owner, "owner", 200),
          name: requiredString(body.name, "name", 200),
          ...(body.description === undefined
            ? {}
            : { description: stringValue(body.description, "description", 2_000) }),
          ...(body.visibility === undefined
            ? {}
            : { visibility: repositoryVisibility(body.visibility) }),
        }, request.signal) }, 201);
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 4 && segments[3] === "branches") {
      if (request.method === "GET") {
        return json(await handle.branches.list({
          repository: repositoryTarget(url.searchParams.get("owner"), url.searchParams.get("name")),
          ...providerPage(url),
        }, request.signal));
      }
      if (request.method === "POST") {
        const body = await requestObject(request, maxBodyBytes);
        return json({ branch: await handle.branches.create({
          repository: repositoryTarget(body.owner, body.repository),
          name: requiredString(body.name, "name", 200),
          from: requiredString(body.from, "from", 200),
        }, request.signal) }, 201);
      }
      return methodNotAllowed("GET, POST");
    }
    if (segments.length === 4 && segments[3] === "pull-requests" && request.method === "POST") {
      const body = await requestObject(request, maxBodyBytes);
      return json({ pullRequest: await handle.pullRequests.create({
        repository: repositoryTarget(body.owner, body.repository),
        head: requiredString(body.head, "head", 200),
        base: requiredString(body.base, "base", 200),
        title: requiredString(body.title, "title", 500),
        ...(body.body === undefined ? {} : { body: stringValue(body.body, "body", 100_000) }),
        ...(body.draft === undefined ? {} : { draft: booleanValue(body.draft, "draft") }),
        ...(body.providerOptions === undefined
          ? {}
          : { providerOptions: jsonObject(body.providerOptions, "providerOptions") }),
      }, request.signal) }, 201);
    }
    if (
      segments.length === 6
      && segments[3] === "pull-requests"
      && segments[5] === "merge"
      && request.method === "POST"
    ) {
      const body = await requestObject(request, maxBodyBytes);
      return json({ pullRequest: await handle.pullRequests.merge({
        repository: repositoryTarget(body.owner, body.repository),
        number: positiveInteger(segments[4], "pullRequestNumber"),
        idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey", 200),
        ...(body.method === undefined ? {} : { method: mergeMethod(body.method) }),
        ...(body.expectedHead === undefined
          ? {}
          : { expectedHead: requiredString(body.expectedHead, "expectedHead", 200) }),
        ...(body.providerOptions === undefined
          ? {}
          : { providerOptions: jsonObject(body.providerOptions, "providerOptions") }),
      }, request.signal) });
    }
    return notFound();
  }
  const handle = user.integrations.deployment.use(integrationId, {
    ...(connectionId ? { connectionId } : {}),
  });
  if (segments.length === 4 && segments[3] === "projects") {
    if (request.method === "GET") {
      return json(await handle.projects.list({
        ...providerPage(url),
        ...(url.searchParams.has("search") ? { search: url.searchParams.get("search")! } : {}),
      }, request.signal));
    }
    if (request.method === "POST") {
      const body = await requestObject(request, maxBodyBytes);
      return json({ project: await handle.projects.create({
        name: requiredString(body.name, "name", 200),
        ...(body.providerOptions === undefined
          ? {}
          : { providerOptions: jsonObject(body.providerOptions, "providerOptions") }),
      }, request.signal) }, 201);
    }
    return methodNotAllowed("GET, POST");
  }
  if (segments.length === 5 && segments[3] === "deployments") {
    if (request.method === "GET") {
      return json({ deployment: await handle.deployments.get({ id: segments[4]! }, request.signal) });
    }
    if (request.method === "DELETE") {
      const body = await requestObject(request, maxBodyBytes);
      return json({ deployment: await handle.deployments.cancel({
        id: segments[4]!,
        idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey", 200),
      }, request.signal) });
    }
    return methodNotAllowed("GET, DELETE");
  }
  return notFound();
}

async function pushVersion<Framework extends FrameworkId>(
  user: ScopedViby<Framework>,
  version: Version<Framework>,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const integrationId = requiredString(body.integrationId, "integrationId", 64);
  const connectionId = body.connectionId === undefined
    ? undefined
    : requiredString(body.connectionId, "connectionId", 200);
  const repository = jsonObject(body.repository, "repository") as Record<string, unknown>;
  const commit = jsonObject(body.commit, "commit") as Record<string, unknown>;
  const branch = typeof body.branch === "string"
    ? requiredString(body.branch, "branch", 200)
    : branchTarget(body.branch);
  const pullRequest = body.pullRequest === undefined
    ? undefined
    : pullRequestTarget(body.pullRequest);
  return version.push<any, any>({
    using: user.integrations.repository.use(integrationId, {
      ...(connectionId ? { connectionId } : {}),
    }),
    repository: {
      owner: requiredString(repository.owner, "repository.owner", 200),
      name: requiredString(repository.name, "repository.name", 200),
      ...(repository.createIfMissing === undefined
        ? {}
        : { createIfMissing: booleanValue(repository.createIfMissing, "repository.createIfMissing") }),
      ...(repository.description === undefined
        ? {}
        : { description: stringValue(repository.description, "repository.description", 2_000) }),
      ...(repository.visibility === undefined
        ? {}
        : { visibility: repositoryVisibility(repository.visibility) }),
    },
    branch,
    commit: {
      message: requiredString(commit.message, "commit.message", 2_000),
      ...(commit.expectedHead === undefined
        ? {}
        : { expectedHead: requiredString(commit.expectedHead, "commit.expectedHead", 200) }),
    },
    ...(pullRequest ? { pullRequest } : {}),
    ...(body.providerOptions === undefined
      ? {}
      : { providerOptions: jsonObject(body.providerOptions, "providerOptions") }),
    ...(body.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey", 200) }),
    signal,
  });
}

async function deployVersion<Framework extends FrameworkId>(
  user: ScopedViby<Framework>,
  version: Version<Framework>,
  body: Record<string, unknown>,
  signal: AbortSignal,
) {
  const integrationId = requiredString(body.integrationId, "integrationId", 64);
  const connectionId = body.connectionId === undefined
    ? undefined
    : requiredString(body.connectionId, "connectionId", 200);
  return version.deploy<any, any>({
    using: user.integrations.deployment.use(integrationId, {
      ...(connectionId ? { connectionId } : {}),
    }),
    project: deploymentProjectTarget(body.project),
    environment: requiredString(body.environment, "environment", 100),
    ...(body.providerOptions === undefined
      ? {}
      : { providerOptions: jsonObject(body.providerOptions, "providerOptions") }),
    ...(body.idempotencyKey === undefined
      ? {}
      : { idempotencyKey: requiredString(body.idempotencyKey, "idempotencyKey", 200) }),
    signal,
  });
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

function sourceEntries(value: unknown): readonly SourceEntryInput[] {
  if (!Array.isArray(value)) throw new ConfigurationError("source.files must be an array.");
  return value.map((candidate, index) => {
    const input = jsonObject(candidate, `source.files[${index}]`) as Record<string, unknown>;
    const type = input.type ?? (input.base64 === undefined ? "text" : "artifact");
    const base = {
      path: requiredString(input.path, `source.files[${index}].path`, 1_000),
      ...(input.mediaType === undefined
        ? {}
        : { mediaType: requiredString(input.mediaType, `source.files[${index}].mediaType`, 200) }),
      ...(input.locked === undefined
        ? {}
        : { locked: booleanValue(input.locked, `source.files[${index}].locked`) }),
    };
    if (type === "text") {
      return {
        ...base,
        type: "text" as const,
        content: stringValue(input.content, `source.files[${index}].content`, 10_000_000),
      };
    }
    if (type === "artifact") {
      return {
        ...base,
        type: "artifact" as const,
        bytes: decodeBase64(requiredString(
          input.base64,
          `source.files[${index}].base64`,
          150_000_000,
        )),
      };
    }
    throw new ConfigurationError(`source.files[${index}].type must be text or artifact.`);
  });
}

function repositorySourceEntries(files: readonly IntegrationSourceFile[]): readonly SourceEntryInput[] {
  return files.map((file) => {
    const bytes = Uint8Array.from(file.content);
    const content = decodeRepositoryText(bytes, file.mediaType);
    return content === null
      ? {
          type: "artifact" as const,
          path: file.path,
          bytes,
          ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        }
      : {
          type: "text" as const,
          path: file.path,
          content,
          ...(file.mediaType ? { mediaType: file.mediaType } : {}),
        };
  });
}

function decodeRepositoryText(bytes: Uint8Array, mediaType: string | undefined): string | null {
  if (mediaType && !mediaType.startsWith("text/")
    && !/^(application\/(json|javascript|typescript|xml|yaml|toml))\b/.test(mediaType)) {
    return null;
  }
  try {
    const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return value.includes("\0") ? null : value;
  } catch {
    return null;
  }
}

function importFilePolicy(value: unknown): ImportFilePolicy {
  const input = jsonObject(value, "filePolicy") as Record<string, unknown>;
  if (input.locked === "all") return { locked: "all" };
  if (Array.isArray(input.locked)) {
    return { locked: stringArray(input.locked, "filePolicy.locked", 1_000) };
  }
  throw new ConfigurationError("filePolicy.locked must be all or an array of paths.");
}

function repositoryReference(value: unknown, name: string) {
  const input = jsonObject(value, name) as Record<string, unknown>;
  const selected = ["branch", "tag", "commit"].filter((key) => input[key] !== undefined);
  if (selected.length !== 1) {
    throw new ConfigurationError(`${name} must contain exactly one of branch, tag, or commit.`);
  }
  const key = selected[0]! as "branch" | "tag" | "commit";
  return { [key]: requiredString(input[key], `${name}.${key}`, 500) } as
    | { readonly branch: string }
    | { readonly tag: string }
    | { readonly commit: string };
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

interface BinaryResponseInput {
  readonly bytes: Uint8Array;
  readonly filename: string;
  readonly mediaType: string;
  readonly checksum: string;
}

function binaryResponse(input: BinaryResponseInput): Response {
  const bytes = Uint8Array.from(input.bytes);
  const headers = new Headers({
    "Cache-Control": "private, no-store",
    "Content-Disposition": contentDisposition(input.filename),
    "Content-Length": String(bytes.byteLength),
    "Content-Type": input.mediaType || "application/octet-stream",
    ETag: `"${input.checksum}"`,
    "X-Content-Type-Options": "nosniff",
  });
  return new Response(new Blob([bytes], { type: input.mediaType }), { headers });
}

function contentDisposition(filename: string): string {
  const normalized = filename.trim() || "artifact";
  const fallback = normalized.replace(/[^a-zA-Z0-9._-]/g, "_").slice(0, 200) || "artifact";
  return `inline; filename="${fallback}"; filename*=UTF-8''${encodeURIComponent(normalized)}`;
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

function stringValue(value: unknown, name: string, max: number): string {
  if (typeof value !== "string") throw new ConfigurationError(`${name} must be a string.`);
  if (value.length > max || value.includes("\0")) {
    throw new ConfigurationError(`${name} cannot exceed ${max} characters or contain null bytes.`);
  }
  return value;
}

function booleanValue(value: unknown, name: string): boolean {
  if (typeof value !== "boolean") throw new ConfigurationError(`${name} must be a boolean.`);
  return value;
}

function stringArray(value: unknown, name: string, itemMax: number): readonly string[] {
  if (!Array.isArray(value)) throw new ConfigurationError(`${name} must be an array of strings.`);
  return value.map((item, index) => requiredString(item, `${name}[${index}]`, itemMax));
}

function integrationCategory(value: string | undefined): IntegrationCategory {
  if (value !== "repository" && value !== "deployment") {
    throw new ConfigurationError("Integration category must be repository or deployment.");
  }
  return value;
}

function providerPage(url: URL): { readonly cursor?: string; readonly limit?: number } {
  return {
    ...(url.searchParams.has("cursor") ? { cursor: url.searchParams.get("cursor")! } : {}),
    ...(url.searchParams.has("limit") ? { limit: queryInteger(url, "limit") } : {}),
  };
}

function repositoryTarget(owner: unknown, repository: unknown) {
  return {
    owner: requiredString(owner, "owner", 200),
    name: requiredString(repository, "repository", 200),
  };
}

function repositoryVisibility(value: unknown): "private" | "internal" | "public" {
  if (value !== "private" && value !== "internal" && value !== "public") {
    throw new ConfigurationError("visibility must be private, internal, or public.");
  }
  return value;
}

function mergeMethod(value: unknown): "merge" | "squash" | "rebase" {
  if (value !== "merge" && value !== "squash" && value !== "rebase") {
    throw new ConfigurationError("method must be merge, squash, or rebase.");
  }
  return value;
}

function positiveInteger(value: unknown, name: string): number {
  const parsed = typeof value === "string" && /^\d+$/.test(value) ? Number(value) : value;
  if (!Number.isSafeInteger(parsed) || (parsed as number) < 1) {
    throw new ConfigurationError(`${name} must be a positive integer.`);
  }
  return parsed as number;
}

function branchTarget(value: unknown) {
  const input = jsonObject(value, "branch") as Record<string, unknown>;
  return {
    name: requiredString(input.name, "branch.name", 200),
    ...(input.from === undefined ? {} : { from: requiredString(input.from, "branch.from", 200) }),
    ...(input.createIfMissing === undefined
      ? {}
      : { createIfMissing: booleanValue(input.createIfMissing, "branch.createIfMissing") }),
  };
}

function pullRequestTarget(value: unknown) {
  const input = jsonObject(value, "pullRequest") as Record<string, unknown>;
  return {
    base: requiredString(input.base, "pullRequest.base", 200),
    title: requiredString(input.title, "pullRequest.title", 500),
    ...(input.body === undefined ? {} : { body: stringValue(input.body, "pullRequest.body", 100_000) }),
    ...(input.draft === undefined ? {} : { draft: booleanValue(input.draft, "pullRequest.draft") }),
    ...(input.providerOptions === undefined
      ? {}
      : { providerOptions: jsonObject(input.providerOptions, "pullRequest.providerOptions") }),
  };
}

function deploymentProjectTarget(value: unknown):
  | string
  | { readonly id: string }
  | {
      readonly name: string;
      readonly createIfMissing?: boolean;
      readonly providerOptions?: Readonly<Record<string, JsonValue>>;
    } {
  if (typeof value === "string") return requiredString(value, "project", 200);
  const input = jsonObject(value, "project") as Record<string, unknown>;
  if (input.id !== undefined) {
    if (input.name !== undefined) throw new ConfigurationError("project must contain id or name, not both.");
    return { id: requiredString(input.id, "project.id", 200) };
  }
  return {
    name: requiredString(input.name, "project.name", 200),
    ...(input.createIfMissing === undefined
      ? {}
      : { createIfMissing: booleanValue(input.createIfMissing, "project.createIfMissing") }),
    ...(input.providerOptions === undefined
      ? {}
      : { providerOptions: jsonObject(input.providerOptions, "project.providerOptions") }),
  };
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
          : error instanceof VibyError && error.code === "integration_connection_required"
            ? 409
            : error instanceof VibyError && error.code === "integration_authorization_failed"
              ? 400
              : error instanceof VibyError && (
                  error.code === "integration_operation_failed"
                  || error.code === "source_import_failed"
                )
                ? 502
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
