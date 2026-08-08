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

Apply deterministic source changes without invoking the model:

```ts
const editedVersion = await importedVersion!.apply({
  changes: [
    { type: "write", path: "src/index.ts", content: updatedSource },
    { type: "move", from: "README.md", to: "docs/README.md" },
    { type: "delete", path: "src/legacy.ts" },
  ],
});
```

`apply` creates a complete immutable child snapshot. It never changes the selected version in place.

Fork or restore any historical snapshot without a model request:

```ts
const experiment = await importedVersion!.fork({
  title: "Import experiment",
});

const restored = await importedVersion!.restore();
```

`fork` creates a new chat whose first version points back to the selected source version. `restore` copies the selected files into a new latest version in the same chat.

Every generation attempt is stored, including failures and token usage. Successful attempts create immutable versions with a parent relationship and complete source snapshot.

## Run a version in an isolated sandbox

Pass any compatible sandbox adapter when constructing Viby. The core SDK does not own provider credentials and does not require a particular sandbox vendor.

```ts
const viby = createViby({
  framework: "farm",
  model,
  sandbox: yourSandboxAdapter,
});

const sandbox = await version.sandbox({
  timeoutMs: 5 * 60_000,
  ports: [3000],
});

try {
  const install = await sandbox.run({ command: "pnpm", args: ["install"] });
  const build = await sandbox.run({ command: "pnpm", args: ["build"] });

  if (install.exitCode !== 0 || build.exitCode !== 0) {
    throw new Error(build.stderr || install.stderr);
  }
} finally {
  await sandbox.stop();
}
```

Commands use a separate executable and argument list instead of an interpolated shell command. Sessions support streamed output, relative file reads and writes, optional public port URLs, abort signals, and idempotent cleanup. `viby.close()` stops any session the application left open.

Inspect `sandbox.capabilities` or call `sandbox.supports("portUrls")` before using optional behavior. The typed capability record is provider-neutral and reports what the configured adapter implements; unsupported future primitives such as background processes, reconnect, and snapshots remain `false` until the adapter exposes them through Viby.

Adapters with `backgroundProcesses` can start a long-running server without blocking the request. Readiness works across any adapter with `portUrls` and accepts a custom check for authenticated or nonstandard preview routes:

```ts
const server = await sandbox.start({
  command: "pnpm",
  args: ["dev", "--host", "0.0.0.0"],
  onOutput: ({ stream, data }) => console.log(stream, data),
});

const previewUrl = await sandbox.waitForPort(3000, { path: "/health" });

// Later:
await server.kill();
```

E2B, Vercel Sandbox, and Cloudflare currently expose native background handles. Other adapters report the capability as `false`; Viby never detaches a process through an untracked shell workaround.

Adapter authors can import `verifySandboxAdapter` from `@viby/sdk/sandbox/conformance` in their own test suite. The caller supplies a harmless runtime-specific command and fixture credentials; Viby verifies capability declarations, text and binary file roundtrips, commands, streaming, port URLs, and idempotent cleanup without assuming a framework, image, or provider.

### E2B

Install E2B only when that is the provider your product uses:

```bash
npm install e2b
```

```ts
import { e2bSandbox } from "@viby/sdk/sandbox/e2b";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: e2bSandbox({
    apiKey: process.env.E2B_API_KEY,
    template: "base",
  }),
});
```

The adapter maps Viby timeouts, environment variables, file operations, abort signals, output callbacks, and port URLs to the E2B SDK. Arguments are POSIX-quoted before reaching E2B's shell command API.

### Vercel Sandbox

Install the provider peer:

```bash
npm install @vercel/sandbox
```

```ts
import { vercelSandbox } from "@viby/sdk/sandbox/vercel";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: vercelSandbox({
    image: "vercel/sandbox/universal:latest",
  }),
});
```

Vercel OIDC authentication is automatic in a linked Vercel project. Outside Vercel, pass `token`, `teamId`, and `projectId` together. Viby creates non-persistent execution sandboxes, declares requested preview ports at creation, and maps command output streams into the common callback.

### Daytona

Install the provider peer:

```bash
npm install @daytona/sdk
```

```ts
import { daytonaSandbox } from "@viby/sdk/sandbox/daytona";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: daytonaSandbox({
    apiKey: process.env.DAYTONA_API_KEY,
    image: "node:24",
    resources: { cpu: 2, memory: 4 },
  }),
});
```

Without explicit credentials, the Daytona SDK reads `DAYTONA_API_KEY`, `DAYTONA_API_URL`, and `DAYTONA_TARGET`. The adapter creates ephemeral sandboxes with a TTL matching the Viby session, supports images or snapshots, streams command output through Daytona sessions, and returns signed preview URLs that can be opened directly. Network allowlists, secrets, labels, resources, and custom names remain provider options rather than leaking into Viby’s shared contract.

### Modal

Install the provider peer in a server-side Node.js 22 or newer application:

```bash
npm install modal
```

```ts
import { modalSandbox } from "@viby/sdk/sandbox/modal";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: modalSandbox({
    appName: "viby",
    image: "node:24-bookworm-slim",
    cpu: 2,
    memoryMiB: 2048,
  }),
});
```

Modal reads `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` by default or accepts the pair explicitly. The adapter passes command arguments directly as an argv array, streams stdout and stderr concurrently, uses Modal's binary filesystem API, declares encrypted preview tunnels at creation, and terminates the sandbox when the Viby session stops. Provider options include registry or named Modal images, GPU and resource controls, named secrets, regions, cloud placement, network allowlists, tags, OIDC identity tokens, and idle timeouts.

### Cloudflare Sandbox

Install the provider peer in a Cloudflare Worker project:

```bash
npm install @cloudflare/sandbox
```

Export Cloudflare's Durable Object class and pass its configured binding to Viby inside the Worker:

```ts
export { Sandbox } from "@cloudflare/sandbox";

import { cloudflareSandbox } from "@viby/sdk/sandbox/cloudflare";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: cloudflareSandbox({
    binding: env.Sandbox,
    preview: "tunnel",
  }),
});

const session = await version.sandbox({ ports: [5173] });
```

The Worker must configure the `Sandbox` container, Durable Object binding, and migration in `wrangler.jsonc`. The adapter defaults to sessionless RPC execution, writes binary files without host filesystem access, maps command streaming and abort signals, creates zero-config quick-tunnel previews, and destroys the container on cleanup. For stable previews, pass `{ hostname, token?, name? }` instead of `"tunnel"`. Preview URLs are public, port `3000` is reserved by Cloudflare's internal control server, and local container development requires Docker.

### Local Docker

Docker requires no JavaScript provider dependency:

```ts
import { dockerSandbox } from "@viby/sdk/sandbox/docker";

const viby = createViby({
  framework: "farm",
  model,
  sandbox: dockerSandbox({
    image: "node:24-bookworm-slim",
    cpus: 2,
    memoryMb: 2048,
  }),
});
```

The adapter uses the local Docker CLI and daemon. It never bind-mounts generated source: files are streamed into a labeled, read-only-root container with dropped capabilities, `no-new-privileges`, PID/CPU/memory limits, and a size-limited temporary workspace. Use it for trusted local or single-tenant infrastructure; a Docker daemon is not a substitute for a hardened multi-tenant cloud sandbox.

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
const messages = await chat.listMessages({ limit: 20 });
const versions = await chat.listVersions({ limit: 20 });

const nextMessages = messages.nextCursor
  ? await chat.listMessages({ after: messages.nextCursor, limit: 20 })
  : null;
```

Chat metadata is application-defined JSON and can store product state such as favorites, tags, or workspace references:

```ts
const updated = await chat.update({
  title: "Customer analytics",
  metadata: { favorite: true, workspaceId: "workspace_123" },
});
```

Pagination cursors are opaque and stable for the resource ordering. All reads and writes remain constrained by both `tenantId` and `userId`.

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
