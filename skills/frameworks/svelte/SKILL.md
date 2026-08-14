---
name: svelte
description: Generate and edit client-side Svelte applications with typed single-file components, Vite, scoped styles, accessible events, and Svelte state conventions. Use for framework id svelte when a full SvelteKit server is not requested.
---

# Svelte

Build a Svelte client application. Use the separate SvelteKit target when file-based routing, server loading, form actions, or server endpoints are required.

## Project contract

- Declare `svelte`, `vite`, and the official Svelte Vite plugin with compatible versions.
- Keep the browser entry in `src/main.ts` and the application shell in `src/App.svelte` unless the imported project establishes another layout.
- Write typed `.svelte` components and use the state/props conventions supported by the installed Svelte version.
- Prefer component composition and scoped styles. Keep global tokens and resets in an explicitly imported global stylesheet.
- Use semantic HTML and native accessible interactions; do not attach click handlers to non-interactive elements without keyboard behavior and roles.

## Editing rules

- Do not add SvelteKit route conventions to a plain Svelte project.
- Do not generate React hooks, JSX-only patterns, or Vue directives.
- Add every imported package and preserve the existing Vite plugin chain.

## Verification

Run the declared check/typecheck and build scripts. A conventional Vite-backed project uses `vite` for development and `vite build` for production.
