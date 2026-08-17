---
title: "Web API host"
description: "Mount Viby as a framework-neutral Web Request/Response API with a typed client and resumable SSE."
---

# Web API host

`createVibyApi()` turns a configured Viby client into one framework-neutral `fetch(Request): Promise<Response>` handler. It uses only Web `Request`, `Response`, `Headers`, `ReadableStream`, URL, and crypto-compatible SDK surfaces, so the same host can be mounted in Node, Bun, Workers, or a framework route.

```ts
const api = createVibyApi({
  viby,
  basePath: "/api/viby",
  authenticate: async (request) => {
    const session = await sessions.read(request);
    return session
      ? { tenantId: session.tenantId, userId: session.userId }
      : new Response("Unauthorized", { status: 401 });
  },
});
```

The host owns authentication. Returning `null` produces a JSON `401`; returning a `Response` preserves a product-specific redirect or denial. Every resource route after authentication uses the returned tenant/user scope. Integration and tool-source callbacks are deliberately public because their hashed, single-use authorization state establishes the original scope.

An authenticator that creates or rotates a cookie can return the scope and response headers together.
The headers are applied to both successful route responses and SDK error responses, and are never
persisted or exposed to generation code:

```ts
authenticate: async (request) => {
  const session = await sessions.readOrCreate(request);
  return {
    scope: { tenantId: session.tenantId, userId: session.userId },
    headers: session.setCookie ? { "Set-Cookie": session.setCookie } : undefined,
  };
},
```

## Typed Web client

`createVibyWebClient()` consumes this contract from browsers, Workers, Bun, Node, or another Web-compatible runtime. It owns route construction, attachment encoding, typed errors, binary download responses, and SSE reconnection from the last acknowledged cursor.

```ts
import { createVibyWebClient } from "@viby/sdk/core";

const viby = createVibyWebClient<"farmjs">({
  baseUrl: "/api/viby",
  fetch: authenticatedFetch,
});

const { chat, generation } = await viby.chats.create({
  title: "Analytics",
  prompt: "Build a polished analytics dashboard",
});

const imported = await viby.chats.import({
  title: "Existing app",
  source: { type: "zip", bytes: uploadedZip },
});
await viby.chats.versions.apply(imported.chat.id, imported.version.id, {
  changes: [{ type: "write", path: "src/theme.css", content: theme }],
});

for await (const event of viby.generations.stream(generation.id)) {
  saveCursor(event.cursor);
  render(event);
}

const state = await viby.generations.get(generation.id);
const source = await viby.chats.versions.download(chat.id, state.version!.id);

const restored = await viby.chats.versions.restore(chat.id, state.version!.id);
const forked = await viby.chats.versions.fork(chat.id, restored.version.id, {
  title: "Analytics experiment",
});

const previews = await viby.previews.list({ chatId: chat.id, status: "ready" });
if (previews.previews[0]) await viby.previews.stop(previews.previews[0].id);

const tools = await viby.toolSources.create({
  type: "mcp",
  name: "Company tools",
  configuration: { endpoint: "https://tools.example.com/mcp" },
});
await viby.chats.toolSources.set(chat.id, [tools.toolSource.id]);
```

Pass `after` to `generations.stream()` when restoring a cursor from application storage. The client sends it as `Last-Event-ID`, updates it after each event, and reconnects a prematurely closed retryable stream without replaying acknowledged events. File, ZIP, and attachment bytes remain `Uint8Array` values in application code; the client owns their base64 HTTP encoding. Authentication remains host-owned: use `headers`, a header factory, or a custom `fetch` implementation to attach the product session.

## Routes

All paths are relative to `basePath` (default `/api/viby`).

| Method and path | Operation |
| --- | --- |
| `GET /chats` | list chats with `limit`, `after`, and JSON-encoded `metadata` filters |
| `POST /chats` | create a chat; include `prompt` to start its first generation |
| `POST /chats/imports` | import a project from text/binary files, a base64 ZIP, or a connected repository |
| `GET/PATCH/DELETE /chats/:chatId` | load, update, or retention-delete a chat |
| `POST /chats/:chatId/restore` | restore a retention-deleted chat before its purge deadline |
| `GET/POST /chats/:chatId/messages` | list messages or start a generation |
| `GET /chats/:chatId/messages/:messageId` | load one durable message |
| `GET /chats/:chatId/attachments/:attachmentId` | stream private attachment bytes with verified metadata headers |
| `GET /chats/:chatId/environment` | list public and redacted environment-variable records |
| `PUT/DELETE /chats/:chatId/environment/:environment/:name` | set or delete a scoped variable or secret |
| `GET/PUT /chats/:chatId/tool-sources` | list or replace the chat's explicit durable tool-source selection |
| `GET /chats/:chatId/{repository-links,repository-pushes}` | reload durable repository connection and push history |
| `GET /chats/:chatId/{deployment-projects,deployments}` | reload durable deployment project and deployment history |
| `GET /chats/:chatId/versions` | list immutable versions |
| `GET /chats/:chatId/versions/:versionId` | load version metadata and entries |
| `GET/POST /chats/:chatId/versions/:versionId/changes` | inspect or apply immutable source changes |
| `POST /chats/:chatId/versions/:versionId/restore` | create a new version from a previous immutable snapshot |
| `POST /chats/:chatId/versions/:versionId/fork` | create a new chat whose first version references the source snapshot |
| `POST /chats/:chatId/versions/:versionId/messages` | iterate from an exact version |
| `GET /chats/:chatId/versions/:versionId/download` | download raw framework source as ZIP |
| `POST /chats/:chatId/versions/:versionId/preview` | open a configured durable preview or invoke a host override |
| `GET /chats/:chatId/versions/:versionId/artifacts/:artifactId` | stream a binary project entry |
| `GET /chats/:chatId/versions/:versionId/visual-artifacts[/:artifactId]` | list visual evidence or stream one screenshot |
| `GET/POST /chats/:chatId/versions/:versionId/repository-pushes` | list version push history or push/open a PR through an integration |
| `GET/POST /chats/:chatId/versions/:versionId/deployments` | list deployment history or deploy the immutable version |
| `GET /chats/:chatId/versions/:versionId/deployments/:deploymentId/artifact` | download immutable prebuilt deployment output |
| `GET /generations/:generationId` | load status, attempts, tasks, tools, artifacts, and result version |
| `GET /generations/:generationId/events` | stream resumable SSE using `Last-Event-ID` |
| `GET /generations/:generationId/events/page` | read a JSON event page with `after` and `limit` |
| `GET /generations/:generationId/artifacts/:artifactId` | stream a generated image, audio, document, or binary output |
| `POST /generations/:generationId/cancel` | cancel an active generation |
| `POST /generations/:generationId/retry` | add a retry attempt |
| `POST /generations/:generationId/resume` | resume an interrupted attempt |
| `POST /generations/:generationId/tasks/:taskId` | resolve a typed plan, question, or permission task |
| `GET /previews` | list durable previews by chat, version, or status |
| `GET/DELETE /previews/:previewId` | load or stop a durable preview |
| `POST /previews/:previewId/reconnect` | reconnect the configured sandbox to a durable preview lease |
| `POST /previews/cleanup` | stop and release expired previews with an optional bounded limit |
| `GET/POST /integrations/callback` | complete a provider authorization through durable state |
| `GET/POST /tool-sources/callback` | complete tool-source authorization through durable single-use state |
| `GET/POST /tool-sources` | list/filter registrations or create a public credential-free registration |
| `GET/PATCH/DELETE /tool-sources/:sourceId` | load, update, disable, or archive a registration |
| `GET /tool-sources/:sourceId/connection` | inspect redacted connection metadata |
| `POST /tool-sources/:sourceId/{connect,disconnect}` | authorize, reconnect, or revoke a source connection |
| `GET /integrations[/:category]` | list configured repository/deployment adapters and connection state |
| `GET/POST/DELETE /integrations/:category/:id/{connections,connect}` | inspect, authorize, or revoke user connections |
| `GET/POST /integrations/repository/:id/{owners,repositories,branches,pull-requests}` | drive provider-neutral repository selection and PR workflows |
| `GET/POST /integrations/deployment/:id/projects` | list or create deployment projects |
| `GET/DELETE /integrations/deployment/:id/deployments/:deploymentId` | refresh or cancel a provider deployment |

Compact `/versions/:versionId/{iterations,preview,download}` aliases accept `chatId` in the JSON body or download query for small clients that already keep the chat identity in UI state.

Generation JSON accepts `prompt`, `model`, `instructions`, categorized `skills`, `metadata`, and attachments. HTTP attachments use `{ filename, mediaType, base64 }`; the host converts them to immutable byte inputs before calling Viby. `maxBodyBytes` defaults to 10 MiB and is enforced even when `Content-Length` is absent.

Project imports use `{ source: { type: "files", files } }`, `{ source: { type: "zip", base64 } }`, or `{ source: { type: "repository", integrationId, connectionId?, repository, ref } }`. Binary file entries carry `type: "artifact"` and `base64`; text entries carry `content`. Repository credentials remain in the selected integration adapter and never enter the request or response.

Provider workflow routes accept only provider-neutral fields at the stable boundary. Vendor-specific options, when needed, stay inside `providerOptions`. Push and deployment effects execute against one immutable version and use the SDK's durable idempotency and history records.

Tool-source routes accept only public registration configuration. `connect` returns either an existing healthy connection or a provider authorization URL; callback state restores the original tenant/user scope without a product session. Connection responses never contain credential bytes or secret-store references.

## Preview boundary

The API does not invent a preview URL. When `createViby()` has a durable `preview` configuration, opt into the built-in lifecycle with `preview: true`. It reuses a ready preview for the immutable version and otherwise materializes the version, runs every configured `prepare` command, starts the server, waits for readiness, and persists the result:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  preview: {
    files: [{ path: "preview.config.ts", content: "export const preview = true;\n" }],
    prepare: [{ command: "pnpm", args: ["install", "--frozen-lockfile"] }],
    start: { command: "pnpm", args: ["dev", "--host", "0.0.0.0"] },
    port: 3000,
  },
});

const api = createVibyApi({
  viby,
  authenticate,
  preview: true,
});
```

`preview.files` contains preview-only overrides written after the immutable version is materialized. It is useful for host allowlists and development-server settings that should never alter version history or raw downloads. Send `Accept: text/event-stream` to the preview route, or use `web.chats.versions.previewStream(...)`, to receive workspace, command, stdout/stderr, readiness, and final result events while startup is running.

Pass a callback instead when the product needs a custom cache, deployment result, or complete `Response`. Without `preview`, preview routes return `501 preview_not_configured`. CORS, CSRF policy, rate limits, and sessions remain application responsibilities; durable sandbox preview cleanup is available through `user.previews.cleanupExpired()`.
