# Viby SDK

`@viby/sdk` is a framework-agnostic TypeScript SDK for building persistent, skill-guided vibe coding products. Your application owns authentication, model credentials, and Postgres. Viby owns chats, generation attempts, immutable source versions, iteration, and source downloads.

This first release intentionally does not include preview hosting, deployment providers, GitHub connections, or a Viby API key.

The versioned contracts live in [`docs/api`](./docs/api): the [Viby v1 API](./docs/api/v1.md) is the shipped contract, while the [v0 core capability reference](./docs/api/v0-core.md) is the audited parity roadmap with third-party surfaces explicitly separated.

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

Every generation attempt is stored, including failures and token usage. Successful attempts create immutable versions with a parent relationship and complete source snapshot.

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
- generation attempts and usage
- immutable versions and iteration
- raw source ZIP downloads

Planned as separate capabilities later:

- sandboxed execution and preview URLs
- deployment presets and provider connections
- GitHub export and pull requests
- managed Viby infrastructure

## Development

```bash
npm install
npm run check
npm pack --dry-run
```

Run the [persistent OpenAI example](./examples/basic) to exercise chat creation, generation, optional iteration, Postgres reload, and source download end to end.

## License

MIT
