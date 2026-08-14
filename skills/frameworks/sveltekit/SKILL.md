---
name: sveltekit
description: Generate and edit SvelteKit applications using filesystem routes, layouts, load functions, form actions, server endpoints, adapters, and server-only module boundaries. Use for framework id sveltekit and full-stack Svelte projects.
---

# SvelteKit

Preserve SvelteKit's filesystem routing and server/client boundaries.

## Project contract

- Declare compatible `@sveltejs/kit`, `svelte`, `vite`, and adapter packages.
- Put routes in `src/routes` using `+page.svelte`, `+layout.svelte`, `+page.ts`, `+page.server.ts`, and `+server.ts` according to responsibility.
- Put reusable code in `src/lib`; keep secrets and privileged helpers under `src/lib/server`.
- Keep the SvelteKit Vite plugin in `vite.config.*`, framework configuration in `svelte.config.*`, and deployment behavior in the selected adapter.
- Use load functions for route data and form actions for progressively enhanced mutations. Validate and authorize server operations.
- Store unprocessed public assets in `static/`.

## Editing rules

- Never import server-only modules into browser code.
- Preserve the generated `.svelte-kit` TypeScript base configuration rather than copying generated output into source.
- Follow the syntax supported by the installed Svelte version and add every imported dependency.

## Verification

Run the project's check and build scripts. Confirm the chosen adapter matches the deployment target and that no private environment value enters client output.
