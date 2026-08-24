---
name: farmjs
description: Generate and edit current Farm.js applications using app-directory routing, typed server and browser APIs, renderer adapters, integrations, storage, i18n, cron, and portable deployment targets. Use for every Farm.js project and iteration.
---

# Farm.js

Preserve the existing Farm.js project contract. Do not substitute FarmFE, `@farmfe/*`, or another framework. Treat the checked-in manifest, `farm.config.ts`, route tree, and locked files as authoritative.

## Project contract

- Keep every published `@farm.js/*` package on the same release channel and compatible version.
- Configure the app in `farm.config.ts` with `defineConfig` from `@farm.js/core`.
- Put routes under `src/app`: `layout`, `page`, nested segments, and `api/**/route`.
- Return application UI or a fragment from the root layout. Farm.js owns the `<html>`, `<head>`, and `<body>` document shell.
- Add `"use client"` only to components that require browser APIs, state, effects, client bindings, or event handlers.
- Use the existing package manager. New Viby workspaces use `pnpm`.
- Use Farm's built-in Tailwind integration when Tailwind is selected. Do not add PostCSS or `@tailwindcss/postcss` unless the project explicitly requires it.
- Preserve locked configuration and compatibility declarations supplied by the host.

## Renderers and routes

React is the default renderer. Farm.js also supports Preact, Solid, Vue, and Svelte through renderer adapters. Preserve the selected renderer and use its native component format and bindings; never mix renderer formats in one route tree.

Routing conventions include:

- `src/app/page.tsx` maps to `/`.
- `src/app/about/page.tsx` maps to `/about`.
- `src/app/users/[id]/page.tsx` maps to a dynamic route.
- `[...slug]` and `[[...slug]]` create required and optional catch-all routes.
- Route groups do not appear in URLs; named slots and intercepted routes are supported.
- `loading`, `error`, and `not-found` files define route boundaries.
- Use Farm's `PageProps`, `LayoutProps`, typed `Link href`, and generated `src/farm.d.ts` declarations.

## Configuration

Use current documented fields rather than inventing framework APIs. Common config surfaces include:

- `renderer`, `srcDir`, `api`, and `experimental.serverComponents`
- `integrations`, top-level `auth`, `storage.mounts`, and `migrations`
- `i18n`, `cron`, `docs`, `md`, `mdx`, and `openapi`
- `deploy.target`, `deploy.preset`, and deployment output
- `routeRules`, `security`, `serverActions`, `images`, and `performance`
- `plugins`, `redirects()`, `headers()`, `rewrites()`, and `vite`

Prefer `deploy.target` for first-class targets. Use `deploy.preset` only for explicit Nitro pass-through; a preset overrides a target. Keep deploy output separate from immutable raw source.

## Data and server behavior

- API routes live under `src/app/api/**/route.ts`.
- Prefer `createEndpoint` from `@farm.js/core/api` for validated, generated caller types; standard HTTP method exports remain valid.
- Use `createAPIClient` from `@farm.js/core/client` for application routes.
- Use `createIntegrations<AppIntegrations>()` for configured integration namespaces and export the registry type.
- Use `createServerFn` for typed mutations and `createServerQuery` for typed reads when the project has the documented server-function transform.
- Use `loadRouteParams`, `loadSearchParams`, and query parsers on the server; use `useQueryState` or `useQueryStates` for React client URL state.
- Keep secrets and provider SDKs in server-only modules.

Farm supports typed HTTP queries, multipart uploads, streamed results, caching, invalidation, retries, optimistic updates, and structured server-query refresh. Follow the closest current project pattern instead of approximating another framework's API.

## Integrations, auth, storage, and jobs

- New provider code uses dedicated packages such as `@farm.js/stripe`, `@farm.js/clerk`, `@farm.js/resend`, and `@farm.js/jobs`.
- Older `@farm.js/integrations/*` imports are compatibility paths, not the preferred surface for new work.
- The integration registry key is the client namespace, such as `billing` becoming `api.billing`.
- Use `defineIntegration`, typed endpoints, lifecycle hooks, middleware, providers, and validated config for custom integrations.
- Use top-level `auth` with `@farm.js/auth` for built-in email/password sessions. Do not combine top-level auth with `integrations.auth`.
- Use `@farm.js/core/storage` mounts for provider-neutral storage rather than embedding provider calls throughout the UI.
- Use config-plus-route cron for portable schedules; handlers must be idempotent. Use a jobs integration for durable retries, queues, steps, or long-running work.

Current integration families include AI, billing, email, jobs, auth, data, agents, security, and custom app-owned provider instances. Add every imported adapter to the manifest.

## Product capabilities

Farm.js has first-class configuration for internationalization, typed ICU catalogs, themes, fonts, image policy, documentation/MDX, OpenAPI, route caching and rendering modes, CSP, observability, runtime events, migrations, and multiple deployment targets. Reuse those primitives when the request needs them instead of introducing parallel configuration systems.

## Verification

1. Inspect `package.json`, the lockfile, `farm.config.ts`, `src/farm.d.ts`, and the route tree.
2. Preserve the renderer, package manager, source layout, config, and deployment contract.
3. Add every imported package to the manifest and keep React peer dependencies compatible.
4. Prefer framework APIs from `@farm.js/core` and dedicated `@farm.js/*` adapters over invented helpers.
5. Keep generated source readable; do not compress JSX, CSS, handlers, or data into dense one-line output.
6. Run the project's declared generate, typecheck, and build scripts. Use `farm doctor`, `farm explain`, or `farm deploy --plan` when the resolved runtime matters.
7. For remote sandbox previews, use `farm dev --host 0.0.0.0 --port <port>` and reuse the prepared workspace. A local-only preview can omit `--host`. Do not reinstall dependencies.

Never modify a locked file, expose a secret to client code, mix renderers, combine incompatible auth modes, or silently replace the framework.
