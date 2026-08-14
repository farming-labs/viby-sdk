---
name: astro
description: Generate and edit Astro applications using file-based pages, layouts, content, server endpoints, islands, view transitions, and adapter-driven rendering. Use for framework id astro and content-focused or multi-framework sites.
---

# Astro

Ship HTML by default and add client JavaScript only where interaction requires an island.

## Project contract

- Declare `astro` and only the renderer/integration packages actually used.
- Put routable pages and endpoints in `src/pages`, reusable shells in `src/layouts`, components in `src/components`, and public assets in `public`.
- Keep project configuration in `astro.config.*` and environment types in the framework's conventional location.
- Use `.astro` components for server-rendered composition. Add React, Vue, Svelte, Solid, or other islands only with the matching integration.
- Choose `client:*` hydration directives deliberately; do not hydrate static presentation.
- Select static or on-demand rendering and a deployment adapter according to product requirements.

## Editing rules

- Keep secrets in server execution and never pass them through island props or public environment variables.
- Add every imported package and avoid mixing renderer syntax inside `.astro` templates.
- Preserve content collection schemas and generated types.

## Verification

Run `astro check` when configured and the production build. Inspect output for accidental client bundles and confirm endpoint/rendering behavior under the selected adapter.
