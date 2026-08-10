# Complete vibe coding reference application

This framework-neutral host demonstrates the complete Viby product loop:

1. create a tenant-scoped chat from a natural-language prompt;
2. consume resumable durable generation events over standard SSE;
3. inspect the persisted generation and immutable source version;
4. materialize that version in an E2B sandbox and open its live preview;
5. iterate from the exact current version;
6. download the framework-native source ZIP.

The browser UI is deliberately plain Web Platform code and the server uses Node's HTTP primitives. The application boundary in [`src/app.ts`](./src/app.ts) accepts a `Viby` client, user scope, static assets, and a declarative preview recipe. Replace the HTTP host, model provider, framework string, skills, sandbox, or authentication system without changing the SDK workflow.

## Run it

Use Node.js 22 or newer. Start with a Postgres database plus OpenAI and E2B credentials:

```bash
cd examples/reference
npm install
cp .env.example .env
# Fill DATABASE_URL, OPENAI_API_KEY, and E2B_API_KEY.
npm run db:migrate
npm start
```

Open `http://localhost:3000`.

Environment variables are read by the host only. The browser never receives provider or database credentials. The example uses a fixed demo tenant and user so the SDK flow stays visible; a product should derive that scope from its authenticated session.

## Adapt the host

- Change `VIBY_FRAMEWORK` to any framework identifier understood by your generation setup.
- Replace `openai(...)` with another AI SDK model.
- Replace `e2bSandbox(...)` with any Viby sandbox adapter that supports commands, background processes, and public port URLs.
- Change the preview recipe for the selected framework's install and development commands.
- Replace the local design skill with skills.sh slugs or your own `skillRead(...)` directories.

Push and deployment are intentionally the next host-level extension. They can consume the same immutable version or downloaded ZIP without changing generation, preview, or iteration.

## End-to-end coverage

The repository test `test/reference-app.e2e.test.ts` drives the real request handler through chat creation, SSE streaming, preview creation, iteration, and ZIP download. It injects deterministic model and sandbox adapters, so CI verifies the full orchestration without paid provider credentials.
