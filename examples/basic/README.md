# Basic persistent generation example

This example runs the complete Viby v1 path:

1. configure Farm, an OpenAI model, and a local product skill;
2. create a tenant- and user-scoped chat;
3. generate a complete source project;
4. optionally iterate from the generated version;
5. re-open the chat and version from Postgres;
6. download the persisted framework-native source as a ZIP.

It does not create a preview URL or deploy anything.

Use Node.js 22 or newer; the current OpenAI AI SDK provider requires it.

## Run

Start with an empty Postgres database, then:

```bash
cd examples/basic
npm install
cp .env.example .env
# Add DATABASE_URL and OPENAI_API_KEY to .env.
npm run db:migrate
npm start
```

To include a real second model call in the same run, set a prompt before starting:

```bash
VIBY_ITERATION_PROMPT="Tighten the type scale and add a complete submitting state." npm start
```

You can also resume a persisted chat in a later process:

```bash
VIBY_CHAT_ID="the printed chat ID" \
VIBY_ITERATION_PROMPT="Tighten the type scale and add a complete submitting state." \
npm run iterate
```

The script prints persisted IDs and counts, then writes the source ZIP under `./output`. It never prints the API key.
