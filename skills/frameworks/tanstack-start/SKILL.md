---
name: tanstack-start
description: Generate and edit TanStack Start React applications using TanStack Router file routes, loaders, validated search params, server functions, middleware, SSR, and runtime-neutral deployment output. Use for framework id tanstack-start.
---

# TanStack Start

Keep TanStack Router as the application contract and TanStack Start as the server/rendering layer.

## Project contract

- Declare compatible TanStack Start, TanStack Router, React, and build-tool dependencies.
- Keep routes in `src/routes`, the root document route in `src/routes/__root.tsx`, and router creation in `src/router.tsx`.
- Treat `src/routeTree.gen.ts` as generated output; never hand-edit it.
- Use route loaders, validated search parameters, pending/error boundaries, and typed links instead of ad hoc routing state.
- Use `createServerFn` for typed app-internal server calls and server routes for external HTTP consumers. Keep privileged helpers in server-only modules.
- Preserve the selected Vite or Rsbuild configuration and deployment adapter.

## Editing rules

- Export a fresh router from the template's router factory and keep required root document components/scripts.
- Add every imported package and keep React peer dependencies compatible.
- Do not copy App Router or React Router route conventions into this tree.

## Verification

Run route generation, typecheck, tests, and the production build using the manifest's scripts. Never commit a stale generated route tree.
