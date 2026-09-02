# Viby SDK

`@viby/sdk` is a framework-agnostic TypeScript SDK for building persistent, skill-guided vibe coding products. Your application owns authentication, model credentials, and Postgres. Viby owns chats, durable generation attempts and events, typed tasks, immutable source versions, iteration, and source downloads.

See the [shipped capability inventory](./docs/capabilities.md) for the complete core, adapter, integration, verification, and boundary matrix. The [Web API host guide](./docs/api-host.md) documents the ready-to-mount Request/Response surface. Generate an OpenAPI 3.1 document or consume frozen Draft 2020-12 schemas from the portable [`@viby/sdk/schema`](./docs/api/schemas.md) entry point.

## Demo

https://github.com/user-attachments/assets/54b4c532-d7e5-47cf-bb88-04ff65a2ae5d

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

Inspect runtime, connectivity, pending migrations, and secret-store configuration without changing
the database or contacting providers:

```bash
npx viby doctor
npx viby doctor --json
```

Viby creates and maintains a dedicated `viby` Postgres schema. Your existing authentication and user tables remain the source of truth.

## Runtime boundaries

Use `@viby/sdk/core` for Web-standard contracts and helpers shared with browsers, Workers, Bun, or other runtimes. Use `@viby/sdk/node` for the full Node client; filesystem, PostgreSQL, migrations, Docker, Playwright, and provider SDKs stay behind explicit subpath exports. Existing `@viby/sdk` imports remain compatible throughout the 0.x line. See [the runtime boundary guide](docs/runtime.md).

## Create the SDK

Pass one framework, one AI SDK model, and categorized skills:

```ts
import { createViby, skillRead } from "@viby/sdk";
import { openai } from "@ai-sdk/openai";

export const viby = createViby({
  framework: "farmjs",
  model: openai("your-model-id"),
  retention: { deletedChatsMs: 30 * 24 * 60 * 60 * 1_000 },
  generation: {
    limits: {
      maxSteps: 20,
      maxDurationMs: 300_000,
      maxTokens: 200_000,
      maxCommands: 20,
      commandTimeoutMs: 60_000,
      sandboxPorts: [3000],
    },
  },
  skills: {
    core: [skillRead("./skills/company")],
    design: [skillRead("./skills/design-engineer")],
    frontend: ["owner/repository/frontend-skill"],
    security: ["owner/repository/security-skill"],
  },
});
```

Mount a credential-safe readiness endpoint from the same configured client:

```ts
const report = await viby.health.check();
return Response.json(report, { status: report.ok ? 200 : 503 });
```

The active database adapter is probed. Optional provider capabilities are reported from
configuration without calling models, creating sandboxes, or changing integrations. Add
product-owned queue or gateway probes through `health.checks`; thrown errors are redacted from the
public report. See [Health and diagnostics](docs/operations/health.md).

The model path uses Viby's built-in, bounded coding loop. It is the default for products that want
Viby to own planning, workspace tools, policy, traces, quality repair, and source commits. Advanced
hosts can replace only that intelligence loop through `generation.engine`; storage, durability,
permissions, previews, integrations, and immutable history remain Viby-owned.

```ts
const answer = await version.inspect({
  prompt: "Where is session expiry enforced, and which tests cover it?",
});

console.log(answer.content);

// Addressable, cancellable, retryable, and resumable when needed:
const inspection = await version.startInspection({ prompt: "Audit the data flow" });
for await (const event of inspection.stream()) {
  // Persisted event cursor; reconnect with `after`.
}
const outcome = await inspection.wait(); // { status: "responded", message, generation }
```

Inspection is available only after a project has an immutable version. It receives read/search
capabilities, filters effectful inbound tools, skips preview and quality-build work, persists the
assistant response and usage, and leaves version history unchanged.

Accept follow-up prompts while the current generation is still running without racing its source
version:

```ts
const first = await chat.start({ prompt: "Build the analytics dashboard" });
const next = await chat.enqueue({
  prompt: "Add a revenue trend",
  afterGenerationId: first.id,
});

for await (const event of next.stream()) {
  // Starts only after `first` succeeds, then edits its immutable result.
}
```

The queued user message survives reloads immediately. Embedded and external workers enforce the
same durable predecessor ordering.

`framework` is one type-safe string. Viby provides autocomplete and an automatically resolved,
immutable framework skill for `farmjs`, `nextjs`, `svelte`, `sveltekit`, `vue`, `nuxt`, `solid`,
`solidstart`, `tanstack-start`, `react-router`, `astro`, and `vite`. The skill is prepended to the
always-selected `core` group; the configured `skills` above extend it. Any other non-empty string
remains valid for a host-owned framework and receives no package-owned assumptions.

```ts
import { builtInFrameworks, frameworkSkill } from "@viby/sdk";

builtInFrameworks; // readonly built-in IDs for selectors and validation
frameworkSkill("farmjs"); // optional explicit immutable snapshot
```

`farm` and `next` remain migration aliases for bundled skill selection, but new records should use
the canonical `farmjs` and `nextjs` IDs.

The model provider reads its own credential from your environment. Viby does not receive or store it. The default generator is a bounded AI SDK tool-loop agent: it reads and changes source through `AgentWorkspace`, emits durable tool and trace records, and returns either an immutable project result or a typed blocking task.

Skills can also come from an application-owned catalog, database, object store, or Git service. The configured resolver handles opaque references while built-in skills.sh, local-directory, and inline adapters remain available:

```ts
import { defineSkillResolver, skillFrom, skillInline } from "@viby/sdk";

const skillResolver = defineSkillResolver({
  id: "company/catalog",
  async resolve({ reference }) {
    if (typeof reference === "string" || reference.source !== "resolver") return null;
    const snapshot = await catalog.get(reference.locator);
    return { name: snapshot.name, files: snapshot.files };
  },
});

const viby = createViby({
  framework: "farmjs",
  model,
  skillResolver,
  skills: {
    design: [skillFrom("company/catalog", "design-system@4")],
    core: [skillInline({ name: "product-rules", files: [{ path: "SKILL.md", content: rules }] })],
  },
});
```

Resolver locators and metadata are persisted with generation configuration, and exact resolved files are snapshotted once per generation. Credentials belong inside the resolver implementation, never in a reference or returned skill file.

Inbound tools use the same provider-neutral pattern. Configure named sources once, then select them from durable chat metadata and apply one policy before a tool is exposed to the default agent:

```ts
import { mcp } from "@viby/sdk/tools/mcp";

const viby = createViby({
  framework: "farmjs",
  model,
  tools: {
    sources: {
      docs: mcp({ id: "docs", url: "https://docs.example.com/mcp" }),
      private: mcp({
        id: "private",
        url: "https://tools.example.com/mcp",
        headers: async ({ tenantId, userId }) => ({
          Authorization: `Bearer ${await credentials.forUser(tenantId, userId)}`,
        }),
      }),
    },
    select: ({ context }) =>
      context.metadata.toolset === "private" ? ["docs", "private"] : ["docs"],
    policy: ({ tool }) => (tool.effect === "read" ? "allow" : "approval-required"),
  },
});
```

The core `ToolSource` contract also supports application catalogs, database-backed tools, and other protocols. MCP credentials remain inside the adapter callback. Viby gives every effectful call a stable idempotency key, persists redacted arguments/results, and resumes an approval-required call only after its permission task is resolved. Install the optional `@modelcontextprotocol/client` peer only when using the MCP adapter.

Products that let every tenant add its own tools can register adapter types once and persist only public configuration:

```ts
import { defineToolSourceAdapter } from "@viby/sdk";

const viby = createViby({
  framework: "farmjs",
  model,
  tools: {
    adapters: {
      mcp: defineToolSourceAdapter({
        type: "mcp",
        open: ({ source }) => openRegisteredMcpSource(source),
      }),
    },
  },
});

const user = viby.forUser({ tenantId, userId });
const source = await user.toolSources.create({
  type: "mcp",
  name: "Company tools",
  configuration: { endpoint: "https://tools.example.com/mcp" },
});

await chat.toolSources.set([source.id]);
```

MCP has a built-in durable adapter, so the common path needs no custom materializer:

```ts
import { mcpAdapter } from "@viby/sdk/tools/mcp";

const viby = createViby({
  framework: "farmjs",
  model,
  tools: { adapters: { mcp: mcpAdapter() } },
});

const source = await user.toolSources.create({
  type: "mcp",
  name: "Product catalog",
  configuration: { url: "https://tools.example.com/mcp" },
});
await chat.toolSources.set([source.id]);
```

Pass the existing provider-neutral `authorization` lifecycle to `mcpAdapter({ authorization })` for tenant-owned OAuth. The adapter sends the live opaque credential as a bearer token by default; `headers` and `connect` provide explicit escape hatches for custom schemes and transports. Only the URL and other public registration configuration are persisted.

Durable registrations are scoped to one tenant and user, selected explicitly per chat, and resolved into the same `ToolSource` interface used by static sources. They can be disabled, updated, or archived without changing generation code. The JSON `configuration` field rejects credential-like keys; authentication belongs in the separate secret-backed authorization lifecycle.

When a generation is queued, Viby stores the selected registrations' public configuration as immutable `generation.configuration.toolSources` snapshots. Workers and retries use those exact revisions even if the chat selection or registration changes later. Credentials are deliberately excluded and continue to resolve through the live isolated connection, so rotation and revocation remain effective.

Adapter authors can run `verifyToolSourceAdapter` from `@viby/sdk/tools/conformance` against a disposable registration. The caller supplies a harmless listed call and any fixture credential resolver; Viby checks identity, materialization, tool schemas, calls, credential isolation, JSON-safe results, and source cleanup without assuming MCP or a provider.

Adapters may declare that lifecycle without exposing provider credentials to chats, messages, events, or the model:

```ts
const adapter = defineToolSourceAdapter({
  type: "company-tools",
  authorization: {
    provider: "company-oauth",
    startAuthorization: (input, context) => oauth.start(input, context),
    completeAuthorization: (input, context) => oauth.complete(input, context),
    refreshCredential: (credential, context) => oauth.refresh(credential, context),
    revokeCredential: (credential, context) => oauth.revoke(credential, context),
  },
  open: ({ source, credential }) => openCompanyTools({ source, credential }),
});

const source = await user.toolSources.create({
  type: "company-tools",
  name: "Company tools",
  configuration: { endpoint: "https://tools.example.com" },
});

const authorization = await source.connect({
  callbackUrl: "https://app.example.com/tool-sources/callback",
  returnTo: "/settings/tools",
});

// In the public callback handler:
const completed = await viby.toolSources.callback(request);

await source.connection();
await source.disconnect();
```

Viby hashes single-use callback state, persists connection metadata with `storage.database`, and stores opaque authorization sessions and credentials only through `storage.secrets`. Credential resolution occurs inside the adapter boundary immediately before a selected source lists or calls tools. Products still own provider app registration, redirect routing, and user authentication.

`createVibyApi()` exposes the same lifecycle through `/tool-sources`, `/chats/:chatId/tool-sources`, and the public `/tool-sources/callback` route. `createVibyWebClient()` mirrors those operations through `client.toolSources` and `client.chats.toolSources`.

PostgreSQL remains the zero-configuration structured database: omit `storage.database`, set `DATABASE_URL`, and run `viby db migrate`. Storage is grouped by what Viby stores, while each value remains a provider-neutral adapter:

```ts
import { postgres } from "@viby/sdk/storage/postgres";
import { fileSystemArtifactStore } from "@viby/sdk/artifact/filesystem";

const viby = createViby({
  framework: "farmjs",
  model,
  storage: {
    database: postgres({ url: env.DATABASE_URL }),
    artifacts: fileSystemArtifactStore({ directory: "/var/lib/viby/artifacts" }),
  },
});
```

`storage.database` stores structured records: chats, messages, generations, versions, events, histories, and artifact references. `storage.artifacts` stores binary bytes: attachments, generated media, project entries, screenshots, and deployment output. The `DATABASE_URL` shortcut still selects PostgreSQL when `storage.database` is omitted.

For local, desktop, example, and test hosts on Node.js 22.5+, the explicit SQLite adapter provides
the complete persistence contract without a database service:

```ts
import { sqlite } from "@viby/sdk/storage/sqlite";

const viby = createViby({
  framework: "farmjs",
  model,
  storage: { database: sqlite({ path: ".viby/viby.sqlite" }) },
});
```

The embedded adapter stores one transactionally versioned snapshot, supports WAL and concurrent
handle refresh, and passes the shared persistence conformance suite. It owns embedded binary bytes
and therefore rejects a separate `storage.artifacts`. PostgreSQL remains recommended for
multi-service production and external artifact storage. See [SQLite](docs/storage/sqlite.md).

Custom database implementations can use `defineDatabaseAdapter({ id, open })`; `open({ artifacts })` receives the independently selected artifact store. The durable interface remains exported as `PersistenceAdapter` from `@viby/sdk/persistence`, and its conformance suite remains at `@viby/sdk/persistence/conformance`. The former `persistence`, `artifactStore`, `connectionStore`, and `secretStore` fields remain deprecated compatibility aliases for one release line; configuring an alias and its corresponding `storage.*` category together is rejected.

For production object storage, the S3-compatible adapter fits the same category and works with AWS S3, Cloudflare R2, MinIO, and compatible services:

```ts
import { s3 } from "@viby/sdk/storage/s3";

const viby = createViby({
  framework: "farmjs",
  model,
  storage: {
    database: postgres({ url: env.DATABASE_URL }),
    artifacts: s3({
      bucket: env.S3_BUCKET,
      region: env.S3_REGION,
      endpoint: env.S3_ENDPOINT, // omit for AWS; set for R2 or MinIO
      credentials: {
        accessKeyId: env.S3_ACCESS_KEY_ID,
        secretAccessKey: env.S3_SECRET_ACCESS_KEY,
      },
    }),
  },
});
```

Objects are scoped under encoded tenant and user segments, checked against their SHA-256 metadata, and never exposed as public URLs. Set `forcePathStyle: true` when required by a local MinIO-compatible endpoint. The alias `@viby/sdk/artifact/s3` exports the same adapter for artifact-centric imports.
Install the optional peer `@aws-sdk/client-s3` in applications that use this adapter.

## Project environments and secrets

Enable durable project environments with the PostgreSQL default and the same provider-neutral secret-store boundary used by integrations:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  environment: {},
});

const chat = await viby.forUser({ tenantId, userId }).chats.get(chatId);

await chat.environment.set({
  environment: "preview",
  name: "PUBLIC_API_ORIGIN",
  value: "https://api.example.com",
});

await chat.environment.set({
  environment: "preview",
  name: "SERVICE_TOKEN",
  value: serviceToken,
  secret: true,
});
```

`environment` is one type-safe string (`development`, `preview`, `production`, or a custom name), so the same variable may have a different value in each environment. `chat.environment.list()` returns public values but always returns `null` for secret values. Secret bytes live only in `storage.secrets`; the default encrypts them with `VIBY_SECRET_KEY`.

Opt in to injection by naming an environment when opening a sandbox:

```ts
const sandbox = await version.sandbox({ environment: "development" });
```

Deployments automatically resolve the deployment's existing `environment` value. Prebuilt deployments inject those variables into sandbox creation and build commands; deployment adapters receive them just-in-time through `DeployVersionInput.environmentVariables`. Vercel source deployments pass them in the deployment request. Values are not copied into prompts, messages, events, telemetry, deployment history, or build-artifact command records. Explicit `preparation.env` values override the durable values for that one build.

Advanced hosts may provide `environment: { store }` with any `EnvironmentVariableStore` and `storage: { secrets }` with any `SecretStore`. PostgreSQL metadata is available explicitly through `postgresEnvironmentVariables()` from `@viby/sdk/environment/postgres`.

External account connections use the same tenant and user scope while keeping provider credentials out of ordinary records. Configure adapters under capability categories, set a separate 32-byte `VIBY_SECRET_KEY`, and run the normal migrations:

```ts
import { github } from "@viby/sdk/integrations/github";
import { cloudflare } from "@viby/sdk/integrations/cloudflare";
import { netlify } from "@viby/sdk/integrations/netlify";
import { vercel } from "@viby/sdk/integrations/vercel";

const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  storage: { artifacts: artifactStore },
  deployment: {
    preparation: {
      install: { command: "pnpm", args: ["install", "--frozen-lockfile"] },
      build: { command: "pnpm", args: ["build"] },
      outputDirectory: "dist",
    },
  },
  integrations: {
    repository: {
      github: github({
        appId: env.GITHUB_APP_ID,
        clientId: env.GITHUB_APP_CLIENT_ID,
        clientSecret: env.GITHUB_APP_CLIENT_SECRET,
        privateKey: env.GITHUB_APP_PRIVATE_KEY,
        slug: "viby",
      }),
    },
    deployment: {
      vercel: vercel({
        clientId: env.VERCEL_CLIENT_ID,
        clientSecret: env.VERCEL_CLIENT_SECRET,
        slug: "viby",
      }),
      cloudflare: cloudflare({
        clientId: env.CLOUDFLARE_CLIENT_ID,
        clientSecret: env.CLOUDFLARE_CLIENT_SECRET,
        scopes: env.CLOUDFLARE_OAUTH_SCOPES.split(" "),
      }),
      netlify: netlify({
        clientId: env.NETLIFY_CLIENT_ID,
        clientSecret: env.NETLIFY_CLIENT_SECRET,
      }),
    },
  },
});

const user = viby.forUser({ tenantId, userId });
const result = await user.integrations.repository.connect("github", {
  callbackUrl: "https://app.example/api/integrations/callback",
  returnTo: "/projects/project-123",
  authorization: { account: "existing" },
});
```

`connect` returns an existing healthy connection or a single-use authorization URL. Complete every provider through one Web-standard callback with `viby.integrations.callback(request)`. Viby persists connection metadata and hashed authorization state in PostgreSQL; the default secret store encrypts OAuth/installation credentials with AES-256-GCM. Advanced products can provide `storage.connections` and `storage.secrets` implementations instead. No provider token is returned to application UI objects, generation events, or the model.

`authorization.account` is a provider-neutral `"existing" | "new"` preference. The GitHub adapter
uses `"existing"` to authorize the user, discover an already-installed GitHub App, and attach it
without reinstalling. Use `"new"` to open the installation flow. If a product has already let the
user select among several accounts, pass that provider identifier as `externalAccountId`.

After authorization, one reusable repository handle covers discovery, import, immutable-version pushes, branches, and pull requests:

```ts
const github = user.integrations.repository.use("github");

const imported = await user.chats.import({
  source: github.source({
    repository: { owner: "farming-labs", name: "starter" },
    ref: { branch: "main" },
  }),
});

const version = await imported.latestVersion();
const pushed = await version!.push({
  using: github,
  repository: {
    owner: "farming-labs",
    name: "generated-app",
    createIfMissing: true,
  },
  branch: { name: "feat/dashboard", from: "main", createIfMissing: true },
  commit: { message: "feat: add generated dashboard" },
  pullRequest: {
    base: "main",
    title: "feat: add generated dashboard",
    draft: true,
  },
});

if (pushed.status === "conflict") {
  console.log(pushed.expectedHead, pushed.actualHead);
}
```

Adapters receive a complete immutable source snapshot, including artifact-backed binary files. `expectedHead` provides portable optimistic concurrency for later iterations. Adapter authors can run `verifyRepositoryIntegration` from `@viby/sdk/integrations/repository/conformance` against a disposable provider repository. Included adapters cover [GitHub App installations](./docs/integrations/github.md), [GitLab OAuth applications](./docs/integrations/gitlab.md), and [Bitbucket Cloud OAuth consumers](./docs/integrations/bitbucket.md).

Deployment uses the same connected-handle pattern and exists only when the product configures an adapter:

```ts
const hosting = user.integrations.deployment.use("vercel");
const deployment = await version.deploy({
  using: hosting,
  project: { name: "analytics-dashboard", createIfMissing: true },
  environment: "preview",
});

deployment.status;
deployment.url; // null until the provider has a URL
```

`version.deploy(...)` reads the adapter's provider-neutral source contract. Source providers receive the complete immutable text and binary snapshot. Prebuilt providers cause Viby to materialize that same version in the configured sandbox, run `deployment.preparation`, capture the output as an immutable ZIP in the artifact store, and send only those built files. Build environment values passed with `preparation.env` are runtime-only; durable command metadata retains environment variable names, never values.

The default idempotency key is stable for the version, integration, project, and environment. A safe retry reuses the persisted provider result or preparation artifact instead of rebuilding or creating another provider effect. Project creation remains explicit through `createIfMissing`. Use `version.deployments()` to reload durable history and `version.deploymentArtifact(deploymentId)` to retrieve a prepared artifact. The normal `version.download()` remains raw framework-native source and is never replaced by build output. Use `provider.projects` and `provider.deployments.get(...)` for the common lifecycle; cancellation is available only when the selected adapter supports it. Adapter authors can run `verifyDeploymentIntegration` from `@viby/sdk/integrations/deployment/conformance`.

The included [Vercel adapter](./docs/integrations/vercel.md) accepts complete framework source and provider build settings. The included [Cloudflare adapter](./docs/integrations/cloudflare.md) declares prebuilt input and selects `dist` by default. The included [Netlify adapter](./docs/integrations/netlify.md) accepts prebuilt static assets plus optional already-built server-function bundles; its guide includes the Farm.js `.output/public` and `.output/server` contract. Viby prepares prebuilt output automatically and never publishes raw framework source in place of a build. Prebuilt deployment requires both `sandbox` and `storage.artifacts`; either can be any conforming adapter.

Binary attachments use a separate provider-neutral artifact store so PostgreSQL retains only queryable ownership, media metadata, checksums, and opaque storage references. The filesystem adapter is a reference implementation for development or hosts with a durable mounted volume:

```ts
import { fileSystemArtifactStore } from "@viby/sdk/artifact/filesystem";

const viby = createViby({
  framework: "farmjs",
  model,
  storage: {
    artifacts: fileSystemArtifactStore({ directory: "/var/lib/viby/artifacts" }),
  },
});
```

Configure `storage.artifacts` before accepting attachment bytes. Custom stores implement ordinary `put`, `get`, and idempotent `delete` methods and retain their own credentials. Adapter authors can verify byte roundtrips and defensive reads with `verifyArtifactStore` from `@viby/sdk/artifact/conformance`. Existing attachment bytes from older schemas remain readable through the explicit `postgres-legacy` migration marker; all new binary writes go to the configured store.

The same store holds durable binary output from a generation engine. AI SDK generated files are captured automatically; custom engines can return an `artifacts` array containing images, audio, video, documents, or arbitrary binary files. Viby persists ownership, ordering, MIME type, size, checksum, and the opaque store reference while keeping bytes outside PostgreSQL:

```ts
const generation = await chat.start({ prompt: "Create the app and a share image" });
await generation.wait();

const [artifact] = await generation.artifacts();
if (artifact) {
  const content = await generation.getArtifact(artifact.id);
  console.log(content.mediaType, content.bytes);
}
```

Every stored output emits an `artifact.created` event on the normal resumable generation cursor. Artifacts created with a successful source result link to its immutable version; artifacts accompanying a blocking task remain generation- and attempt-owned until the host decides what to do next. Store references are not public URLs, so serving or signing downloads remains an explicit host concern.

Advanced consumers can replace the AI SDK shortcut with a provider-neutral generation engine. The engine may call a custom model runtime, run an agent, or delegate to an orchestration service while Viby continues to own durable attempts, events, tasks, usage, and immutable source versions:

```ts
import { createViby, defineGenerationEngine } from "@viby/sdk";

const engine = defineGenerationEngine({
  identity: { provider: "company-runtime", model: "frontend-agent-v1" },
  capabilities: {
    operations: ["change", "inspect"],
    streaming: true,
    steering: true,
    traces: true,
  },
  async generate(input, { signal, trace, toolCalls } = {}) {
    signal?.throwIfAborted();
    return companyAgent.generate({ input, signal, trace, toolCalls });
  },
  async close() {
    await companyAgent.close();
  },
});

export const viby = createViby({
  framework: "farmjs",
  generation: {
    engine,
    engines: {
      fast: fastCompanyEngine,
    },
  },
});
```

Use `generation.engines` for request-selectable aliases and pass `engine: "fast"` on a generation.
The former top-level `engine` and `engines` fields remain deprecated compatibility aliases.

An engine receives normalized prompt, immutable source, messages, resolved skills, tasks,
attachments, optional sandbox access, and a stable run identity containing tenant, user, chat,
generation, and attempt IDs. It returns exactly one typed project, change set, blocking task, or
read-only message. Capability discovery prevents Viby from sending inspection or steering work to a
harness that did not advertise support. `viby.close()` closes every distinct configured engine once.

Generation engine authors can run `verifyGenerationEngine` from
`@viby/sdk/generation/conformance` against caller-owned deterministic scenarios. The suite validates
identity, declared operation support, portable outputs, capability-gated steering, and cancellation
without assuming a provider or orchestration design.

Remote harnesses can use `defineRemoteGenerationEngine({ start, events, cancel })`. `start` is
idempotent on `context.run.attemptId`; `events` resumes from opaque provider cursors, forwards text
deltas into Viby's durable stream, and ends with one typed completed or failed result. Cancellation
is propagated without making the remote provider, queue, or transport part of the core SDK.
The remote wrapper stores its run identity and cursor in an attempt-scoped durable checkpoint, so a
reclaimed worker resumes the same provider stream. Custom engines can use
`context.checkpoint.load()`, `.save()`, and `.clear()` for their own credential-free JSON state.
Engines advertising `toolCalls: true` also receive `context.tools.list()` and `.invoke()`. Viby
projects only host-selected tools and preserves policy decisions, approval tasks, durable call
records, redaction, and external-effect idempotency across custom harnesses.

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

Create a durable chat and first immutable version directly from text and binary source entries or ZIP bytes. Importing never invokes the model.

```ts
const imported = await userViby.chats.import({
  title: "Existing Farm app",
  filePolicy: { locked: ["package.json", "farm.config.ts"] },
  source: {
    type: "files",
    files: [
      { path: "package.json", content: packageJson },
      { path: "src/index.ts", content: source },
      { type: "artifact", path: "public/logo.png", bytes: logoBytes, mediaType: "image/png" },
    ],
  },
});

const importedVersion = await imported.latestVersion();
const entries = await importedVersion?.entries();
const logo = entries?.find((entry) => entry.type === "artifact");
const logoContent = logo ? await importedVersion?.projectArtifact(logo.artifactId) : null;
```

Use `{ type: "artifact", path, bytes, mediaType }` for images, fonts, video, and other binary entries, or `{ type: "zip", bytes }` for a complete archive. Imports reject unsafe paths, duplicates, encrypted or oversized archives, symbolic links, and ZIP bombs before persistence. Binary bytes live in the configured artifact store; immutable versions retain scoped references and lightweight metadata.

`filePolicy.locked` accepts `"all"` or normalized project paths. File-list imports may also set `locked: true` on individual files. A lock becomes immutable version metadata: direct changes, generated changes, and agent workspace tools cannot write, delete, or move the file. Forks, restores, and child snapshots preserve it.

External sources use the same import pipeline through a provider-neutral adapter:

```ts
import type { SourceImportAdapter } from "@viby/sdk";

const source: SourceImportAdapter<{ projectId: string }> = {
  name: "company-source",
  async import({ projectId }, { signal }) {
    const bytes = await companyClient.downloadZip(projectId, { signal });
    return {
      title: `Imported ${projectId}`,
      source: { type: "zip", bytes },
    };
  },
};

const imported = await userViby.chats.import({
  source: {
    type: "adapter",
    adapter: source,
    input: { projectId: "project_123" },
  },
});
```

The application owns adapter credentials and transport. Viby passes only tenant/user scope, framework, and an optional abort signal; it never stores adapter input. Returned files or ZIP bytes still pass every normal size, archive, path, UTF-8, and locked-file validation before one immutable version is committed.

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

`apply` creates a complete immutable child snapshot. It never changes the selected version in place and rejects changes to locked files before persistence.

The default agent uses the same workspace primitives automatically. Advanced consumers can also open an in-memory workspace over an immutable version and expose its portable tools to a custom model runtime:

```ts
const workspace = await importedVersion!.workspace();

await workspace.tools.readFile({ path: "src/index.ts" });
await workspace.tools.search({ query: "legacy", prefix: "src" });
await workspace.tools.writeFile({
  path: "src/index.ts",
  content: updatedSource,
});
await workspace.tools.moveFile({ from: "README.md", to: "docs/README.md" });
await workspace.tools.deleteFile({ path: "src/legacy.ts" });

const proposedChanges = workspace.changes();
const nextVersion = await workspace.commit({
  title: "Agent-refined project",
  summary: "Reviewed and committed the staged source changes.",
});
```

The functions are ordinary typed JavaScript functions, so they can be mapped into any model provider's tool format without importing provider concepts into Viby. Reads and writes operate only on the in-memory workspace. `commit` validates the complete change set and atomically creates one immutable child version; it never mutates the base version or performs external effects.

The built-in agent enforces total step, wall-clock, observed-token, sandbox-command, per-command timeout, and command-output limits. Its workspace tools are always portable. During an iteration, a configured sandbox adapter may materialize the immutable base version; read, command, streaming-output, and port URL tools are exposed only when that session declares the matching capability. Viby checks capabilities, not provider names. New projects have no persisted base version yet, so they start with workspace tools and no sandbox session.

Fork or restore any historical snapshot without a model request:

```ts
const experiment = await importedVersion!.fork({
  title: "Import experiment",
});

const restored = await importedVersion!.restore();
```

`fork` creates a new chat whose first version points back to the selected source version. `restore` copies the selected files into a new latest version in the same chat.

Every generation attempt is stored, including failures and token usage. Initial generations produce a complete source tree. Iterations produce typed `write`, `delete`, and `move` operations, which Viby validates against the selected base and stores alongside the resulting complete immutable snapshot. `version.changes()` returns those ordered operations; imported, forked, and restored versions return an empty list.

## Run a version in an isolated sandbox

Pass any compatible sandbox adapter when constructing Viby. The core SDK does not own provider credentials and does not require a particular sandbox vendor.

```ts
const viby = createViby({
  framework: "farmjs",
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

Commands use a separate executable and argument list instead of an interpolated shell command. Sessions support streamed output, relative file reads and writes, optional public port URLs, abort signals, and idempotent cleanup. `viby.close()` stops any session the application left open. A request-scoped durable worker can instead call `viby.close({ preserveSandboxes: true })` after handing an eager preview to its durable record; local stores and provider clients close while the reconnectable sandbox keeps running.

Inspect `sandbox.capabilities` or call `sandbox.supports("portUrls")` before using optional behavior. The typed capability record is provider-neutral and reports what the configured adapter implements; unsupported primitives remain `false` until the adapter exposes them through Viby.

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

Every opened sandbox receives a tenant- and user-scoped durable lease. Keep its Viby-owned lease id and reconnect after a request or process restart:

```ts
const leaseId = sandbox.leaseId;
const reconnected = await userViby.sandboxes.reconnect(leaseId);
```

`userViby.sandboxes.get(leaseId)` returns the portable lease metadata. Viby stores the provider name, opaque provider sandbox id, source version, framework, declared ports, state, and expiration. It never stores provider credentials, environment values, or vendor response payloads. E2B, Vercel Sandbox, and Cloudflare implement native reconnect today; other adapters fail through the capability gate.

For the normal product flow, configure the framework's development command once and let Viby own the durable preview lifecycle:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  preview: {
    // Optional preview-only overrides are written after immutable source materialization.
    // Raw source, history, and downloads are not changed.
    files: [{ path: "preview.config.ts", content: "export const preview = true;\n" }],
    start: { command: "pnpm", args: ["dev", "--host", "0.0.0.0"] },
    port: 3000,
    path: "/",
    environment: "preview",
  },
  generation: {
    // Start the scaffold now; keep this sandbox through generation and validation.
    workspace: { preview: "eager" },
    quality: {
      prepare: [{ id: "install", command: "pnpm", args: ["install", "--prefer-offline"] }],
      checks: [
        { id: "typecheck", command: "pnpm", args: ["typecheck"] },
        { id: "build", command: "pnpm", args: ["build"] },
      ],
      checkConcurrency: 2,
    },
  },
});

const preview = await version.preview({
  onEvent(event) {
    if (event.type === "command.output") {
      process.stdout.write(`[${event.stage}:${event.stream}] ${event.data}`);
    }
  },
});
preview.url;

// After an application or worker restart:
const restored = await viby.forUser({ tenantId, userId }).previews.get(preview.id);
await restored.reconnect();
await restored.stop();
```

Each preview is bound to one immutable version and one persisted sandbox lease. Viby records readiness, URL, failure, expiry, and stop state; `user.previews.list(...)` reloads history and `cleanupExpired()` closes stale records. `preview.reconnect()` re-runs readiness and durably fails a stale non-listening sandbox instead of returning its old URL. Concurrent starts for the same version and preview inputs share one sandbox. `files` is a provider-neutral escape hatch for preview-only configuration and does not mutate the durable version. `onEvent` reports workspace preparation, commands, stdout/stderr, server startup, readiness, success, and failure without exposing provider-specific types.

The Web API and typed client can carry the same progress directly to a product UI:

```ts
for await (const event of web.chats.versions.previewStream(chatId, versionId)) {
  if (event.type === "command.output") terminal.append(event.data);
  if (event.type === "preview.result") iframe.src = event.result.url;
  if (event.type === "preview.error") showError(event.error);
}
```

The sandbox adapter still owns execution and URL creation, so this remains provider-neutral and does not imply Viby-managed hosting.

Enforce one command policy across every adapter in the session core:

```ts
import { sandboxCommandPolicy } from "@viby/sdk";

const viby = createViby({
  framework: "farmjs",
  model,
  sandbox,
  sandboxPolicy: sandboxCommandPolicy({
    allowCommands: ["node", "pnpm"],
    denyCommands: ["sudo"],
    actions: ["run", "start"],
    environment: ["CI", "NODE_ENV"],
    maxTimeoutMs: 5 * 60_000,
    maxArgs: 100,
  }),
});
```

`sandboxPolicy` may also be an async function returning `{ decision: "allow" }`, `{ decision: "deny", reason }`, or `{ decision: "approval-required", reason }`. The earlier `{ allow: true | false, reason? }` form remains accepted for compatibility. Viby authorizes normalized command metadata before calling `run` or `start`; a denial, thrown policy error, or malformed decision is fail-closed. Policy requests and persisted approval tasks include environment variable names but never their values. Keep credentials out of command arguments as well, since arguments are necessarily visible to command authorization.

When the default agent receives `approval-required`, it stops before adapter execution and persists the exact proposed action on a permission task. Resolve that task through the normal durable generation API:

```ts
const outcome = await generation.wait();

if (outcome.status === "waiting") {
  const task = outcome.tasks.find((candidate) => candidate.kind === "permission");
  if (task?.kind === "permission" && task.proposedAction) {
    await generation.resolve({
      taskId: task.id,
      resolution: { kind: "permission", decision: "allow" },
    });
  }
}
```

The resumed attempt can execute only the approved action fingerprint. Agent commands are recorded as external effects under the same stable idempotency key, so a completed call is reused and a pending, uncertain call must be reconciled instead of repeated. A denied task keeps that exact action denied for the generation.

Adapter authors can import `verifySandboxAdapter` from `@viby/sdk/sandbox/conformance` in their own test suite. The caller supplies a harmless runtime-specific command and fixture credentials; Viby verifies capability declarations, text and binary file roundtrips, commands, streaming, port URLs, and idempotent cleanup without assuming a framework, image, or provider.

All public adapter conformance suites are also available from `@viby/sdk/testing`. The same entry
point exports `createScriptedGenerationEngine()`, a queue-driven engine for deterministic host API,
worker, and UI tests. Every call consumes one explicit output, function, or error; unexpected extra
attempts fail visibly instead of returning a hidden mock result.

### E2B

Install E2B only when that is the provider your product uses:

```bash
npm install e2b
```

```ts
import { e2bSandbox } from "@viby/sdk/sandbox/e2b";

const viby = createViby({
  framework: "farmjs",
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
  framework: "farmjs",
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
  framework: "farmjs",
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
  framework: "farmjs",
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
  framework: "farmjs",
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
  framework: "farmjs",
  model,
  sandbox: dockerSandbox({
    image: "node:24-bookworm-slim",
    cpus: 2,
    memoryMb: 2048,
  }),
});
```

The adapter uses the local Docker CLI and daemon. It never bind-mounts generated source: files are streamed into a labeled, read-only-root container with dropped capabilities, `no-new-privileges`, PID/CPU/memory limits, and a size-limited temporary workspace. Use it for trusted local or single-tenant infrastructure; a Docker daemon is not a substitute for a hardened multi-tenant cloud sandbox.

## Inspect previews through a portable browser

Browser automation is a separate provider-neutral layer. Core types expose navigation, readiness, screenshots, bounded DOM inspection, console errors, and normalized accessibility reports without leaking browser-driver handles or provider-specific result types:

```ts
import { openBrowserSession } from "@viby/sdk";

const browser = await openBrowserSession(browserAdapter, {
  baseUrl: previewUrl,
  context: { tenantId, userId, chatId: chat.id, versionId: version.id },
  viewport: { width: 1440, height: 900 },
});

await browser.navigate("/");
await browser.waitForReady({ selector: "main", state: "visible" });
const screenshot = await browser.screenshot({ fullPage: true });
const dom = await browser.inspect({ selector: "main" });
const consoleErrors = await browser.consoleErrors();
const accessibility = await browser.accessibility();
await browser.close();
```

Navigation remains on the preview origin by default. Adapter authors can run `verifyBrowserAdapter` from `@viby/sdk/browser/conformance` against a caller-owned reachable fixture. Browser sessions are optional and host-owned; the SDK does not create a managed preview URL.

The first included implementation uses Playwright plus axe-core while keeping those types in its provider-specific entry point:

```ts
import { playwrightBrowser } from "@viby/sdk/browser/playwright";
import { openSandboxPreview } from "@viby/sdk";

const browserAdapter = playwrightBrowser({
  browserName: "chromium",
  context: { reducedMotion: "reduce", colorScheme: "light" },
  accessibilityTags: ["wcag2a", "wcag2aa", "wcag21aa", "wcag22aa"],
});

const browser = await openSandboxPreview(browserAdapter, sandbox, {
  port: 3000,
  path: "/",
  context: { tenantId, userId, chatId: chat.id, versionId: version.id },
});
```

`openSandboxPreview` first waits for the sandbox port, then opens an isolated browser context and navigates to the resolved URL. Playwright collects both `console.error` messages and uncaught page exceptions, returns in-memory PNG/JPEG bytes, and maps axe violations into the core accessibility vocabulary. Install both optional peers in hosts that use this adapter: `playwright` and `@axe-core/playwright`.

### Run durable visual evaluations

Configure the browser once, then evaluate any immutable version against either a URL or a sandbox preview. The workflow captures each route, stores its screenshot in the configured artifact store, and records artifact evidence on the existing design-evaluation history:

```ts
import { accessibilityGate, consoleErrorGate, createViby } from "@viby/sdk";
import { playwrightBrowser } from "@viby/sdk/browser/playwright";

const viby = createViby({
  framework: "farmjs",
  model,
  browser: playwrightBrowser(),
  storage: { artifacts: artifactStore },
});

const result = await version.evaluateVisual({
  evaluator: "product-quality@1",
  preview: { type: "sandbox", sandbox, port: 3000 },
  pages: [
    { id: "home", path: "/", readiness: { selector: "main" } },
    { id: "settings", path: "/settings" },
  ],
  gates: [
    consoleErrorGate({ maxErrors: 0 }),
    accessibilityGate({ impacts: ["serious", "critical"] }),
    {
      id: "design-review",
      label: "Design review",
      async evaluate({ version, captures, signal }) {
        return productDesignAgent.evaluate({ version, captures, signal });
      },
    },
  ],
});
```

Quality gates are ordinary callbacks. They can use deterministic rules, a visual regression service, any model runtime, or a custom agent; Viby does not select a design model. `version.visualArtifacts()` lists durable screenshot metadata and `version.getVisualArtifact(id)` explicitly loads verified bytes. Preview hosting remains host-owned.

## Run and stream asynchronously

`chat.start` persists a queued generation and its first attempt before model execution begins, then immediately returns an addressable generation handle:

```ts
const generation = await chat.start({
  prompt: "Build a polished SaaS analytics dashboard",
});

for await (const event of generation.stream()) {
  if (event.type.startsWith("part.")) {
    sendToBrowser(event);
  }
}

const outcome = await generation.wait();
if (outcome.status === "succeeded") {
  const version = outcome.version;
}
```

Steer an active run without cancelling it or creating a competing generation:

```ts
await generation.steer("Keep the navigation compact and preserve the auth flow");

await generation.steer({
  prompt: "Use the attached reference for the empty state",
  attachments: [referenceImage],
  idempotencyKey: composerMessageId,
});
```

Steering is a durable user message, not an in-memory callback. It is accepted while the generation
is queued, running, or waiting, and the next worker applies it at a safe agent boundary. The normal
event cursor emits `steering.queued` and `steering.applied`; `generation.steering()` restores the
ordered records after reconnecting. The default agent checks between steps. A custom generation
engine receives `options.steering.consume()` and decides its own safe boundaries. Viby never
interrupts a command or repeats an external effect to apply steering.

Events are committed to Postgres with monotonically increasing string cursors. A reconnecting client can continue without replaying acknowledged events:

```ts
const page = await generation.events({ after: lastCursor });

for await (const event of generation.stream({ after: lastCursor })) {
  lastCursor = event.cursor;
}
```

HTTP hosts can return the same cursor as standards-compliant SSE without a framework adapter:

```ts
return generation.toEventStreamResponse({ request });

// Or use the standalone helper with any compatible generation source:
return generationEventStreamResponse(generation, { request });
```

The helper reads `Last-Event-ID`, emits normal `id`, `event`, and JSON `data` fields, sends an SSE retry hint, propagates request cancellation, and returns a Web-standard `Response`.

Browser and other Web-runtime consumers can use the matching typed client without recreating routes or SSE parsing:

```ts
import { createVibyWebClient } from "@viby/sdk/core";

const viby = createVibyWebClient<"farmjs">({ baseUrl: "/api/viby" });
const { chat, generation } = await viby.chats.create({
  title: "Dashboard",
  prompt: "Build a polished analytics dashboard",
});

for await (const event of viby.generations.stream(generation.id)) {
  renderGenerationEvent(event);
}

const result = await viby.generations.get(generation.id);
const zip = await viby.chats.versions.download(chat.id, result.version!.id);
```

The client supports dynamic authentication headers, binary downloads, base64 transport for byte attachments, typed API errors, and bounded automatic SSE reconnection from the latest durable cursor.

For a complete product API, mount the Web-standard host in any server or framework:

```ts
import { createVibyApi } from "@viby/sdk";

const api = createVibyApi({
  viby,
  basePath: "/api/viby",
  authenticate: async (request) => {
    const session = await auth.session(request);
    return session
      ? {
          scope: { tenantId: session.organizationId, userId: session.userId },
          headers: session.setCookie ? { "Set-Cookie": session.setCookie } : undefined,
        }
      : new Response("Unauthorized", { status: 401 });
  },
  authorize: ({ operationId, params, scope }) =>
    operationId !== "deleteChat" || permissions.canDelete(scope, params.chatId),
  middleware: [
    async ({ operationId, scope }, next) => {
      if (operationId !== "startGeneration") return next();
      const reservation = await quotas.reserveGeneration(scope);
      if (!reservation.accepted) {
        return Response.json({ error: "Generation limit reached." }, { status: 429 });
      }
      try {
        return await next();
      } finally {
        await reservation.release();
      }
    },
  ],
  preview: true,
});

export const fetch = (request: Request) => api.fetch(request);
```

It covers chat listing/creation/update/deletion, file/ZIP/repository imports, messages, generation status and control, resumable SSE and event pages, permission-task resolution, versions, immutable source changes, iteration, private binary delivery, project environments, integration authorization and discovery, durable push/deployment workflows, ZIP downloads, public integration callbacks, and durable or host-overridden previews. JSON attachments and binary imports use base64 only at the HTTP boundary. Provider credentials remain in adapter-owned secret storage. Authentication, authorization, middleware, sessions, CORS, quotas, billing, rate limits, and sandbox selection remain product-owned. The complete reference application mounts this helper at `/api`.

Generation steering is available through `GET/POST /generations/:id/steering` and the typed Web
client's `generations.steering(...)` / `generations.steer(...)` methods.

Agent trace parts use four lifecycle events: `part.started`, `part.delta`, `part.completed`, and `part.failed`. Started events establish a stable part id, type, and trace position; deltas append live display data; completion carries the typed durable part; and failures carry a redaction-safe error. Completed trace parts retain the same id in the final assistant message. Saving the normal generation cursor is sufficient to resume both lifecycle and trace events.

Send those same durable events to any application-owned transport with signed envelopes:

```ts
import { signedOutboundEventSink } from "@viby/sdk";

const productEvents = signedOutboundEventSink({
  id: "product-events",
  keyId: "events-2026-08",
  secret: process.env.VIBY_EVENT_SECRET!,
  send: (request) =>
    fetch(process.env.EVENT_ENDPOINT!, {
      method: "POST",
      headers: request.headers,
      body: request.body,
      signal: request.signal,
    }),
});

const viby = createViby({
  framework: "farmjs",
  model,
  events: { sinks: [productEvents] },
});

const page = await generation.deliverEvents({
  sink: "product-events",
  after: savedCursor,
  limit: 100,
});
savedCursor = page.cursor;
```

`deliverEvents` is explicit so the host can run it in its own request, cron, queue, or workflow system. Viby durably claims each generation/event/sink tuple, fences concurrent delivery with a lease, retries with bounded backoff, and moves exhausted events to a dead letter. `generation.outboundDeliveries(...)` inspects delivery state and `generation.redriveOutboundEvent(...)` explicitly returns a dead letter to the pending queue. Delivery is at least once. Event IDs are stable as `<generationId>:<cursor>`, so receivers must still deduplicate them.

For endpoints managed by each tenant, enable `events: { webhooks: {} }` and use
`user.webhooks`. Creation and rotation return the signing secret exactly once; endpoint metadata,
filter progress, attempts, retry state, and dead letters remain durable. Run
`viby.webhookWorker({ id }).run()` in a worker process, or call `runOnce()` from cron/workflow
runtimes; it discovers due work without tenant, webhook, or generation IDs. See
[Durable webhooks](docs/api/webhooks.md).

The helper emits a CloudEvents-style JSON envelope and signs `timestamp.eventId.body` with HMAC-SHA256. It includes key ID, timestamp, event ID, and `v1` signature headers. Rotate keys through `keyId`, keep signing secrets server-side, reject timestamps outside your chosen replay window, and use `verifySignedOutboundEvent` for constant-time verification. Secrets and transport response bodies are never persisted.

## Expose scoped Viby operations as MCP tools

Install the optional official server package and register tools against an already-authenticated Viby scope:

```ts
import { McpServer } from "@modelcontextprotocol/server";
import { registerVibyMcpTools } from "@viby/sdk/mcp";

const server = new McpServer({ name: "my-product", version: "1.0.0" });
registerVibyMcpTools(server, { viby: userViby });
```

The registration exposes scoped chat, generation, event, task-resolution, version, iteration, and download operations. The host still owns MCP transport, authentication, connection lifecycle, and any third-party OAuth grants.

## Observe usage and cost

Pass provider-neutral telemetry hooks directly or adapt OpenTelemetry-compatible tracer and meter objects:

```ts
import { openTelemetry } from "@viby/sdk";

const viby = createViby({
  framework: "farmjs",
  model,
  telemetry: openTelemetry({ tracer, meter }),
  cost: {
    currency: "USD",
    calculate: ({ inputTokens, outputTokens }) => (inputTokens ?? 0) * 2 + (outputTokens ?? 0) * 8,
  },
});
```

Cost uses safe integer micro-units in a host-defined currency or credit unit. Each attempt keeps its immutable estimate, the logical generation stores the cumulative amount across retries/resumes, and the final usage message part includes cost when configured. Telemetry is fail-open and omits prompts, source, tool payloads, credentials, and high-cardinality tenant/user IDs.

Tool executions are provider-neutral records owned by their immutable attempt and, after completion, their assistant message:

```ts
const toolCalls = await generation.toolCalls();

for (const call of toolCalls) {
  console.log(call.name, call.status, call.arguments, call.result);
}
```

Arguments and results are validated as bounded JSON and redact common credential fields before persistence. Read, write, and external effects share one contract. External effects require an idempotency key, and replaying the same tenant/tool/key returns the original record instead of authorizing the effect again.

Stopping an event iterator only disconnects that subscriber. Explicitly cancel the underlying model call with:

```ts
await generation.cancel("Stopped from the product UI");
```

Failures and interrupted processes retain their original attempts. Recovery creates a new attempt on the same generation:

```ts
const generation = await userViby.generations.get(generationId);

await generation.retry(); // failed or cancelled generation
await generation.resume(); // interrupted, failed, or cancelled generation
```

`chat.generate` and `version.iterate` remain synchronous convenience methods built on this durable lifecycle.

For request-scoped or horizontally scaled hosts, queue generation in Postgres and run the portable worker loop separately:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  skills,
  generation: { execution: "worker" },
});

const worker = viby.worker({
  id: process.env.WORKER_ID!,
  concurrency: 4,
});

await worker.run({ signal: shutdownSignal });
```

`worker.runOnce()` processes at most one available attempt, which is useful for cron jobs and host-owned workflow systems. Viby claims work with Postgres row locks, expiring leases, and periodic heartbeats; no queue, runtime, or deployment vendor is required. Claims are filtered by the configured framework and model. Lease tokens fence streamed events, skill attachment, task pauses, failures, and final version commits, so a stale worker cannot write after another worker reclaims an expired attempt. Delivery is at least once: generated tools and model calls should remain safe to retry around a process crash.

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

Plan resolutions use `approve` or `revise`; permission resolutions use `allow` or `deny`. Permission tasks created by the default sandbox agent also carry the exact secret-free `proposedAction`. Resolution starts a new durable attempt, and the complete task history remains available through `generation.tasks()`.

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

The ZIP is the raw framework-native source project, including text and artifact-backed binary entries. It contains no deployment vendor configuration, credentials, dependency folders, or build output.

## Resume history

```ts
const chat = await userViby.chats.get(chatId);
const latest = await chat.latestVersion();
const messages = await chat.listMessages({ limit: 20 });
const message = await chat.getMessage(messages.items[0]!.id);
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

const workspaceChats = await userViby.chats.list({
  metadata: { workspaceId: "workspace_123" },
  limit: 20,
});
```

Metadata filters use JSON containment, including nested objects and array members, and are applied before pagination. Pagination cursors are opaque and stable for the resource ordering. Reuse the same filter with later cursors. All reads and writes remain constrained by both `tenantId` and `userId`.

Delete a chat without making recovery or data-retention behavior implicit:

```ts
const deletion = await chat.delete(); // uses retention.deletedChatsMs
await userViby.chats.restore(deletion.chatId); // only before purgeAfter

await chat.delete({ retentionMs: 0 });
const purged = await userViby.chats.purgeDeleted({ limit: 100 });
```

Deleted chats disappear from normal reads immediately. The default retention is 30 days; set `deletedChatsMs: null` (or `retentionMs: null` for one deletion) to retain a tombstone indefinitely. A value of `0` makes it eligible for immediate purge. Deletion refuses chats with queued, running, or waiting generations, so cancel or resolve active work first. `purgeDeleted` is an explicit, tenant-scoped maintenance primitive suitable for the host application's cron or worker and relies on database cascades for permanent removal.

## Render typed message parts

Every message retains its plain `content` for simple transcripts, exposes the assistant's nullable `finishReason`, and provides ordered, discriminated `parts` for richer agent interfaces:

```ts
const { items: messages } = await chat.listMessages();

for (const message of messages) {
  for (const part of message.parts) {
    switch (part.type) {
      case "text":
        console.log(part.data.text);
        break;
      case "file-edit":
        console.log(part.data.operation);
        break;
      case "usage":
        console.log(part.data.totalTokens);
        break;
    }
  }
}
```

The durable part types are `text`, `status`, `reasoning-summary`, `file-read`, `file-edit`, `search`, `command`, `tool-call`, `error`, and `usage`. File edits distinguish `create`, `update`, `delete`, and `move`; the legacy `write` value remains readable for records persisted by older releases. Each part is linked to its message and, when applicable, the logical generation and immutable attempt. `reasoning-summary` is provider-safe summary text; Viby does not expose or promise hidden model reasoning.

Collect durable product feedback without coupling the SDK to an analytics or model provider:

```ts
const feedback = await chat.submitFeedback(assistantMessage.id, {
  rating: "positive",
  reasons: ["helpful", "well-designed"],
  comment: "The generated hierarchy matches the brief.",
  metadata: { surface: "preview" },
  idempotencyKey: `thumb:${assistantMessage.id}`,
});

const feedbackHistory = await chat.listFeedback(assistantMessage.id);
const selectedFeedback = await chat.getSelectedFeedback(assistantMessage.id);

const analytics = await user.feedback.analytics({
  groupBy: ["model", "engine", "skill-set", "framework", "generation-version"],
});
```

Each immutable record retains the exact message, generation, attempt, model identity, runtime
alias, framework, skill set, and nullable generated version. New records atomically become the
current reload-safe selection. Idempotency keys prevent duplicate votes, analytics produce typed
positive/negative buckets, and every operation remains scoped by tenant and user. The Web client
exposes the same behavior through `client.chats.messages`, plus `client.feedback.analytics()`.

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
- categorized provider-neutral database, artifact, connection, and secret storage
- tenant- and user-scoped PostgreSQL default through `DATABASE_URL`
- Viby-owned migrations
- chats and messages
- ordered typed message parts with generation and attempt ownership
- asynchronous generation handles
- resumable event cursors and streamed output deltas
- resumable started, delta, completed, and failed agent trace events
- provider-neutral typed tool calls, results, secret redaction, and external-effect idempotency
- cancellation, retry, and process recovery
- first-class durable steering with idempotency, attachments, safe-boundary consumption, and resumable events
- embedded or durable generation-worker execution with fenced leases and heartbeats
- immutable attempt history and usage
- typed plan, question, and permission tasks
- immutable versions and iteration
- portable agent workspace tools and durable immutable change sets
- a bounded default workspace agent with capability-gated sandbox tools
- raw source ZIP downloads
- standard SSE and Web `Response` helpers
- scoped MCP tool registration through the official server SDK
- sandboxed execution, durable leases, and preview URLs when an adapter supports them
- enforced provider-neutral sandbox command authorization
- durable approval-gated sandbox actions with exact-action, idempotent resume
- signed outbound events with durable retries, dead letters, inspection, and redrive
- provider-neutral telemetry hooks, OpenTelemetry adaptation, and durable cost attribution
- categorized provider-neutral repository and deployment integration contracts
- durable tenant-scoped integration authorization, refresh, reconnect, and disconnect lifecycle
- encrypted PostgreSQL integration secret storage with custom store overrides
- provider-neutral repository discovery, source import, immutable pushes, branches, pull requests, and conformance
- GitHub, GitLab, and Bitbucket provider adapters behind the provider-neutral repository contract
- Vercel and Cloudflare provider adapters behind the provider-neutral deployment contract
- automatic sandbox preparation and immutable deployment artifacts for prebuilt providers
- migration immutability plus schema-upgrade and public-API compatibility fixtures
- a complete framework-neutral reference host for chat, stream, preview, iteration, and download

Planned as separate capabilities later:

- additional deployment providers
- managed Viby infrastructure

## Development

```bash
npm ci
npm run check
npm run test:package
```

Run the [persistent OpenAI example](./examples/basic) for the minimal durable flow, or the [complete reference application](./examples/reference) for chat → SSE → sandbox preview → iteration → source download.

The CI workflow tests supported Node releases, the compiled package and CLI, both examples, API/export compatibility, immutable migrations, historical schema upgrades, the full reference flow, and a durable lifecycle against PostgreSQL. See [RELEASING.md](./RELEASING.md) for versioning commands and the [npm publishing guide](./maintainers/publishing.md) for trusted-publisher setup.

## License

MIT
