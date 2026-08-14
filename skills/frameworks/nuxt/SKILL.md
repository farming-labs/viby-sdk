---
name: nuxt
description: Generate and edit full-stack Nuxt applications using Vue, filesystem pages, layouts, composables, Nitro server routes, runtime configuration, and deployment presets. Use for framework id nuxt and SSR or server-enabled Vue products.
---

# Nuxt

Follow the installed Nuxt major version and preserve its directory convention. For a new current project, use the `app/` application directory and `server/` for Nitro code.

## Project contract

- Declare `nuxt` and `vue` with compatible versions and configure the project in `nuxt.config.ts`.
- Place UI routes in `app/pages`, shared layouts in `app/layouts`, components in `app/components`, and composables in `app/composables` for current projects. Preserve root-level Nuxt 3 layout when importing an existing project.
- Put HTTP handlers in `server/api` or `server/routes` and code shared by app and server in `shared`.
- Put unchanged public assets in `public`; put processed assets in the application assets directory.
- Store public runtime values under `runtimeConfig.public` and keep secrets in private runtime configuration.

## Editing rules

- Respect Nuxt auto-imports without inventing unavailable modules.
- Do not expose secrets through app config or public runtime config.
- Keep provider behavior in Nitro/deployment configuration and add every imported module to the manifest.

## Verification

Run Nuxt's generated type preparation/typecheck when declared, then the production build. Verify the selected Nitro preset against the requested deployment target.
