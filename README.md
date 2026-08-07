# Viby SDK

`@viby/sdk` is a framework-agnostic TypeScript SDK for building persistent, skill-guided vibe coding products. Your application owns authentication, model credentials, and Postgres. Viby owns chats, durable generation attempts and events, typed tasks, immutable source versions, iteration, and source downloads.

## Install

```bash
npm install @viby/sdk ai
```

Add your Postgres connection and model-provider credentials to the server environment:

```bash
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/viby
```

Run the Viby-owned migrations:

```bash
npx viby db migrate
```

Viby creates and maintains a dedicated `viby` Postgres schema. Your existing authentication and user tables remain the source of truth.

## Create the SDK

Pass one framework, one AI SDK model, and categorized skills:

```ts
import { createViby, skillRead } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";

export const viby = createViby({
  framework: "farm",
  model: openai("your-model-id"),
  skills: {
    core: [skillRead("./skills/company")],
    design: [skillRead("./skills/design-engineer")],
    frontend: ["owner/repository/frontend-skill"],
    security: ["owner/repository/security-skill"],
  },
});
```

The model provider reads its own credential from your environment. Viby does not receive or store it.

Remote skill strings use the stable skills.sh `owner/repository/slug` form. Local skills can point at a directory containing `SKILL.md` or at the file itself. Remote skills are resolved through the authenticated skills.sh API when Vercel OIDC is available, with public GitHub repositories as the portable fallback. Set `GITHUB_TOKEN` only when you need higher GitHub API limits.

## Generate and iterate

Scope every operation to IDs from your authentication system:

```ts
const userViby = viby.forUser({
  tenantId: organization.id,
  userId: session.user.id,
});

const chat = await userViby.chats.create({
  title: "Analytics dashboard",
});

let version = await chat.generate({
  prompt: "Build a polished SaaS analytics dashboard",
});

version = await version.iterate({
  prompt: "Make the sidebar more compact and improve empty states",
});
```

## Import an existing project

Create a durable chat and first immutable version directly from UTF-8 source files or ZIP bytes. Importing never invokes the model.

```ts
const imported = await userViby.chats.import({
  title: "Existing Farm app",
  source: {
    type: "files",
    files: [
      { path: "package.json", content: packageJson },
      { path: "src/index.ts", content: source },
    ],
  },
});

const importedVersion = await imported.latestVersion();
```

Use `{ type: "zip", bytes }` for a ZIP archive. Imports reject unsafe paths, duplicate files, encrypted or oversized archives, symbolic links, binary content, and ZIP bombs before persistence.

Every generation attempt is stored, including failures and token usage. Successful attempts create immutable versions with a parent relationship and complete source snapshot.

## Run and stream asynchronously

`chat.start` persists a queued generation and its first attempt before model execution begins, then immediately returns an addressable generation handle:

```ts
const generation = await chat.start({
  prompt: "Build a polished SaaS analytics dashboard",
});

for await (const event of generation.stream()) {
  if (event.type === "output.delta") {
    sendToBrowser(event);
  }
}

const outcome = await generation.wait();
if (outcome.status === "succeeded") {
  const version = outcome.version;
}
```

Events are committed to Postgres with monotonically increasing string cursors. A reconnecting client can continue without replaying acknowledged events:

```ts
const page = await generation.events({ after: lastCursor });

for await (const event of generation.stream({ after: lastCursor })) {
  lastCursor = event.cursor;
}
```

Stopping an event iterator only disconnects that subscriber. Explicitly cancel the underlying model call with:

```ts
await generation.cancel("Stopped from the product UI");
```

Failures and interrupted processes retain their original attempts. Recovery creates a new attempt on the same generation:

```ts
const generation = await userViby.generations.get(generationId);

await generation.retry();  // failed or cancelled generation
await generation.resume(); // interrupted, failed, or cancelled generation
```

`chat.generate` and `version.iterate` remain synchronous convenience methods built on this durable lifecycle.

## Resolve typed tasks

A generation can pause when it genuinely requires plan approval, critical information, or permission for a sensitive action. `wait` returns the typed pending task instead of losing the model state:

```ts
const outcome = await generation.wait();

if (outcome.status === "waiting") {
  const task = outcome.tasks[0];

  if (task?.kind === "question") {
    await generation.resolve({
      taskId: task.id,
      resolution: {
        kind: "question",
        answer: "Use our existing Postgres database",
      },
    });
  }
}
```

Plan resolutions use `approve` or `revise`; permission resolutions use `allow` or `deny`. Resolution starts a new durable attempt, and the complete task history remains available through `generation.tasks()`.

## Download framework source

```ts
const download = await version.download();

return download.toResponse();
```

Or consume the portable artifact directly:

```ts
download.filename;
download.contentType;
download.bytes;
```

The ZIP is the raw framework-native source project. It contains no deployment vendor configuration, credentials, dependency folders, or build output.

## Resume history

```ts
const chat = await userViby.chats.get(chatId);
const latest = await chat.latestVersion();
const messages = await chat.listMessages();
const versions = await chat.listVersions();
```

All reads and writes are constrained by both `tenantId` and `userId`.

## Skill categories

Built-in categories are `core`, `product`, `design`, `frontend`, `backend`, `data`, `ai`, `testing`, `security`, `accessibility`, `performance`, and `delivery`. Custom category names are accepted.

`core` and `frontend` are active for every project generation. Other categories are selected from the current request. Viby snapshots the exact resolved skill files and content hash used by each generation.

Remote skills are untrusted instructions. Review them before use and pin your application dependencies. Viby limits skill files and sizes, snapshots their content, and never passes model-provider credentials into skill instructions.

## Database commands

```bash
npx viby db status
npx viby db migrate
```

Migrations use a Postgres advisory lock and run transactionally. Viby never silently migrates production during an application request.

## Current boundary

Included now:

- AI SDK model injection
- categorized local and skills.sh-compatible skills
- tenant- and user-scoped Postgres persistence
- Viby-owned migrations
- chats and messages
- asynchronous generation handles
- resumable event cursors and streamed output deltas
- cancellation, retry, and process recovery
- immutable attempt history and usage
- typed plan, question, and permission tasks
- immutable versions and iteration
- raw source ZIP downloads

Planned as separate capabilities later:

- sandboxed execution and preview URLs
- deployment presets and provider connections
- GitHub export and pull requests
- managed Viby infrastructure

## Development

```bash
npm ci
npm run check
npm run test:package
```

Run the [persistent OpenAI example](./examples/basic) to exercise chat creation, generation, optional iteration, Postgres reload, and source download end to end.

The CI workflow tests supported Node releases, the compiled package and CLI, the example's public types, and a durable lifecycle against PostgreSQL. See [RELEASING.md](./RELEASING.md) for versioning commands and the [npm publishing guide](./docs/publishing.md) for trusted-publisher setup.

## License

MIT
