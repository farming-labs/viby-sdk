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

The host owns authentication. Returning `null` produces a JSON `401`; returning a `Response` preserves a product-specific redirect or denial. Every resource route after authentication uses the returned tenant/user scope. The integration callback is deliberately public because its hashed, single-use authorization state establishes the original scope.

## Typed Web client

`createVibyWebClient()` consumes this contract from browsers, Workers, Bun, Node, or another Web-compatible runtime. It owns route construction, attachment encoding, typed errors, binary download responses, and SSE reconnection from the last acknowledged cursor.

```ts
import { createVibyWebClient } from "@viby/sdk/core";

const viby = createVibyWebClient<"farm">({
  baseUrl: "/api/viby",
  fetch: authenticatedFetch,
});

const { chat, generation } = await viby.chats.create({
  title: "Analytics",
  prompt: "Build a polished analytics dashboard",
});

for await (const event of viby.generations.stream(generation.id)) {
  saveCursor(event.cursor);
  render(event);
}

const state = await viby.generations.get(generation.id);
const source = await viby.chats.versions.download(chat.id, state.version!.id);
```

Pass `after` to `generations.stream()` when restoring a cursor from application storage. The client sends it as `Last-Event-ID`, updates it after each event, and reconnects a prematurely closed retryable stream without replaying acknowledged events. Authentication remains host-owned: use `headers`, a header factory, or a custom `fetch` implementation to attach the product session.

## Routes

All paths are relative to `basePath` (default `/api/viby`).

| Method and path | Operation |
| --- | --- |
| `GET /chats` | list chats with `limit`, `after`, and JSON-encoded `metadata` filters |
| `POST /chats` | create a chat; include `prompt` to start its first generation |
| `GET/PATCH/DELETE /chats/:chatId` | load, update, or retention-delete a chat |
| `GET/POST /chats/:chatId/messages` | list messages or start a generation |
| `GET /chats/:chatId/messages/:messageId` | load one durable message |
| `GET /chats/:chatId/versions` | list immutable versions |
| `GET /chats/:chatId/versions/:versionId` | load version metadata and entries |
| `POST /chats/:chatId/versions/:versionId/messages` | iterate from an exact version |
| `GET /chats/:chatId/versions/:versionId/download` | download raw framework source as ZIP |
| `POST /chats/:chatId/versions/:versionId/preview` | invoke the optional host preview handler |
| `GET /generations/:generationId` | load status, attempts, tasks, tools, artifacts, and result version |
| `GET /generations/:generationId/events` | stream resumable SSE using `Last-Event-ID` |
| `GET /generations/:generationId/events/page` | read a JSON event page with `after` and `limit` |
| `POST /generations/:generationId/cancel` | cancel an active generation |
| `POST /generations/:generationId/retry` | add a retry attempt |
| `POST /generations/:generationId/resume` | resume an interrupted attempt |
| `POST /generations/:generationId/tasks/:taskId` | resolve a typed plan, question, or permission task |
| `GET/POST /integrations/callback` | complete a provider authorization through durable state |

Compact `/versions/:versionId/{iterations,preview,download}` aliases accept `chatId` in the JSON body or download query for small clients that already keep the chat identity in UI state.

Generation JSON accepts `prompt`, `model`, `instructions`, categorized `skills`, `metadata`, and attachments. HTTP attachments use `{ filename, mediaType, base64 }`; the host converts them to immutable byte inputs before calling Viby. `maxBodyBytes` defaults to 10 MiB and is enforced even when `Content-Length` is absent.

## Preview boundary

The API does not invent a preview URL. Configure `preview` to open or reuse a deployment/sandbox preview and return either JSON or a complete `Response`:

```ts
const api = createVibyApi({
  viby,
  authenticate,
  preview: async ({ scope, chat, version, request }) => {
    return previews.open({ scope, chatId: chat.id, version, signal: request.signal });
  },
});
```

Without that handler, preview routes return `501 preview_not_configured`. CORS, CSRF policy, rate limits, sessions, and preview cleanup remain application responsibilities.
