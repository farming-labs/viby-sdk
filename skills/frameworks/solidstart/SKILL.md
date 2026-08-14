---
name: solidstart
description: Generate and edit SolidStart applications using filesystem routes, Solid reactivity, server functions, API routes, Vite configuration, and Nitro deployment. Use for framework id solidstart and full-stack Solid projects.
---

# SolidStart

Follow the installed SolidStart major version. Preserve an imported v1 layout; use current v2 conventions for a new project.

## Project contract

- Declare compatible SolidStart, Solid, router, Vite, and Nitro packages required by the selected template.
- Put routes in `src/routes`; use default exports for UI routes and HTTP method exports for API routes.
- Keep the document/app shell in `src/app.tsx` and preserve framework entry files when the template supplies them.
- Configure current projects in `vite.config.ts` with the SolidStart and Nitro plugins expected by the installed version.
- Use Solid reactive primitives, not React hooks. Keep server-only work behind SolidStart server functions or API routes and validate inputs.

## Editing rules

- Do not mix v1 Vinxi configuration into a v2 project or migrate an imported project implicitly.
- Preserve filesystem route naming and add every imported dependency.
- Keep secrets server-only and deployment behavior in Nitro configuration.

## Verification

Run the project's typecheck and build scripts, then start the production output or preview contract supplied by the selected Nitro preset.
