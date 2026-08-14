---
name: farmjs
description: Generate and edit Farm.js applications using the @farm.js packages, app-directory routing, React Server Components, built-in Tailwind support, and Farm deployment configuration. Use for new Farm.js projects and iterations on existing Farm.js source.
---

# Farm.js

Preserve the existing Farm.js project contract. Do not substitute FarmFE, `@farmfe/*`, or another framework.

## Project contract

- Declare `@farm.js/core`, `@farm.js/cli`, `react`, and `react-dom` with mutually compatible versions.
- Configure the app in `farm.config.ts` with `defineConfig` from `@farm.js/core`.
- Put routes under `src/app`: `layout.tsx`, `page.tsx`, nested segments, and `api/**/route.ts`.
- Keep the root layout responsible for the document shell. Add `"use client"` only to components that require browser APIs, state, effects, or event handlers.
- Use Farm's built-in Tailwind integration when Tailwind is selected. Do not add PostCSS or `@tailwindcss/postcss` unless the existing project explicitly requires it.
- Configure deployment through `deploy.target` or `deploy.preset`; keep generated deployment output separate from raw source.

## Editing rules

- Inspect `package.json`, `farm.config.ts`, and the existing route tree before changing files.
- Preserve locked configuration and compatibility declaration files supplied by the host.
- Add every imported package to the manifest and keep React peer dependencies compatible.
- Prefer framework APIs from `@farm.js/core` over invented helpers or APIs copied from another meta-framework.

## Verification

Run the project's declared typecheck and build scripts. For previews, use `farm dev --port <port>`; do not pass unsupported CLI flags.
