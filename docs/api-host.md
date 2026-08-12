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

## Routes

All paths are relative to `basePath` (default `/api/viby`).

| Method and path | Operation |
| --- | --- |
| `GET /chats` | list chats with `limit`, `after`, and JSON-encoded `metadata` filters |
| `POST /chats` | create a chat; include `prompt` to start its first generation |
| `POST /chats/imports` | import a project from text/binary files, a base64 ZIP, or a connected repository |
| `GET/PATCH/DELETE /chats/:chatId` | load, update, or retention-delete a chat |
| `GET/POST /chats/:chatId/messages` | list messages or start a generation |
| `GET /chats/:chatId/messages/:messageId` | load one durable message |
| `GET /chats/:chatId/attachments/:attachmentId` | stream private attachment bytes with verified metadata headers |
| `GET /chats/:chatId/environment` | list public and redacted environment-variable records |
| `PUT/DELETE /chats/:chatId/environment/:environment/:name` | set or delete a scoped variable or secret |
| `GET /chats/:chatId/{repository-links,repository-pushes}` | reload durable repository connection and push history |
| `GET /chats/:chatId/{deployment-projects,deployments}` | reload durable deployment project and deployment history |
| `GET /chats/:chatId/versions` | list immutable versions |
| `GET /chats/:chatId/versions/:versionId` | load version metadata and entries |
| `POST /chats/:chatId/versions/:versionId/messages` | iterate from an exact version |
| `GET /chats/:chatId/versions/:versionId/download` | download raw framework source as ZIP |
| `POST /chats/:chatId/versions/:versionId/preview` | invoke the optional host preview handler |
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
| `GET/POST /integrations/callback` | complete a provider authorization through durable state |
| `GET /integrations[/:category]` | list configured repository/deployment adapters and connection state |
| `GET/POST/DELETE /integrations/:category/:id/{connections,connect}` | inspect, authorize, or revoke user connections |
| `GET/POST /integrations/repository/:id/{owners,repositories,branches,pull-requests}` | drive provider-neutral repository selection and PR workflows |
| `GET/POST /integrations/deployment/:id/projects` | list or create deployment projects |
| `GET/DELETE /integrations/deployment/:id/deployments/:deploymentId` | refresh or cancel a provider deployment |

Compact `/versions/:versionId/{iterations,preview,download}` aliases accept `chatId` in the JSON body or download query for small clients that already keep the chat identity in UI state.

Generation JSON accepts `prompt`, `model`, `instructions`, categorized `skills`, `metadata`, and attachments. HTTP attachments use `{ filename, mediaType, base64 }`; the host converts them to immutable byte inputs before calling Viby. `maxBodyBytes` defaults to 10 MiB and is enforced even when `Content-Length` is absent.

Project imports use `{ source: { type: "files", files } }`, `{ source: { type: "zip", base64 } }`, or `{ source: { type: "repository", integrationId, connectionId?, repository, ref } }`. Binary file entries carry `type: "artifact"` and `base64`; text entries carry `content`. Repository credentials remain in the selected integration adapter and never enter the request or response.

Provider workflow routes accept only provider-neutral fields at the stable boundary. Vendor-specific options, when needed, stay inside `providerOptions`. Push and deployment effects execute against one immutable version and use the SDK's durable idempotency and history records.

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
