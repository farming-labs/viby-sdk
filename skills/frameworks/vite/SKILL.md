---
name: vite
description: Generate and edit Vite applications while preserving the selected UI renderer, TypeScript setup, plugin chain, environment boundaries, static assets, and production build contract. Use for framework id vite when no meta-framework is selected.
---

# Vite

Treat Vite as the build/runtime target, not as a UI framework. Determine the renderer from the prompt, existing source, or declared dependencies.

## Project contract

- Keep `index.html` as the browser entry and application source under `src` unless the imported project establishes another structure.
- Configure plugins in `vite.config.*` and install the official plugin for the selected renderer.
- Use `import.meta.env` only for values intended for the browser and honor the project's public environment prefix.
- Put copied static assets in `public`; import processed assets from source.
- Keep aliases synchronized between Vite and TypeScript.

## Editing rules

- Do not silently add React, Vue, Svelte, Solid, or another renderer when the request is ambiguous; return a typed question when that choice affects the project.
- Do not add meta-framework filesystem routes or server APIs to a plain Vite target.
- Add every imported package and preserve the existing plugin order.

## Verification

Run the selected renderer's typecheck plus `vite build`. Use the manifest's preview command to verify base paths, asset URLs, and client-side routing fallbacks.
