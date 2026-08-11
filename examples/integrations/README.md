# Real repository and deployment integration example

This local callback server exercises the provider-neutral Viby integration flow against real accounts:

1. persist OAuth state and encrypted credentials in PostgreSQL;
2. connect a user-owned GitHub App installation or Vercel workspace;
3. create a durable framework-native fixture version;
4. push the immutable source to GitHub or create a Vercel preview deployment;
5. optionally run OpenAI generation and download its persisted source ZIP.

The provider buttons open real authorization pages. The push action may create `GITHUB_TEST_REPOSITORY`, and the deployment action may create `VERCEL_TEST_PROJECT`. They never target production. Use disposable names or delete the resources after verification.

## Provider setup

Use the exact `VIBY_CALLBACK_URL` as each provider's callback or redirect URL. The default is:

```text
http://127.0.0.1:3217/api/integrations/callback
```

The GitHub App must request user authorization during installation and have repository Metadata read, Contents read/write, Pull requests read/write, plus Administration read/write only when the test may create a repository. `GITHUB_APP_CLIENT_ID` and `GITHUB_APP_CLIENT_SECRET` must come from that same App.

The Vercel external integration must grant Project and Deployment read/write scopes. `VERCEL_INTEGRATION_SLUG` is the integration URL slug, not its client ID.

## Run

```bash
cd examples/integrations
npm install
cp .env.example .env
# Fill the provider credentials and a separate 32-byte VIBY_SECRET_KEY.
npm run db:migrate
npm start
```

Open `http://127.0.0.1:3217`. Connect one provider at a time, then run its verification action. The page displays public connection metadata and operation results; provider tokens are never returned to the browser or logs.
