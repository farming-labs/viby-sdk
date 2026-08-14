---
name: react-router
description: Generate and edit React Router Framework Mode applications using route configuration, route modules, loaders, actions, middleware, pending UI, SSR, and provider adapters. Use for framework id react-router rather than declarative router-only SPAs.
---

# React Router Framework Mode

Use Framework Mode and preserve its route-module contract.

## Project contract

- Declare compatible `react-router`, React, framework development, and deployment adapter packages.
- Keep the document shell in `app/root.tsx`, route configuration in `app/routes.ts`, and framework options in `react-router.config.ts`.
- Implement route modules with typed loader, action, metadata, headers, error-boundary, and component exports as required.
- Use loaders for reads, actions for mutations, `<Form>` for progressive enhancement, and fetchers for concurrent non-navigation interactions.
- Keep `.server` modules out of client graphs and `.client` modules out of server rendering.
- Preserve entry files and provider presets when the template supplies them.

## Editing rules

- Do not mix declarative `<Routes>` setup with a Framework Mode project unless integrating an explicit nested use case.
- Use generated route types rather than recreating parameter types manually.
- Add every imported package and keep authorization inside loaders/actions.

## Verification

Run framework type generation, typecheck, and the production build. Exercise loaders, actions, error boundaries, and the selected deployment adapter.
