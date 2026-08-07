---
name: focused-product-page
description: Build a small, complete product page with a restrained visual system.
---

# Focused product page

- `framework: "farm"` means the Farm.js React meta-framework published under `@farm.js/*`. Never use FarmFE or any `@farmfe/*` package.
- Use matching published versions of `@farm.js/core` and `@farm.js/cli`. The current public version for this example is `0.1.0-beta.8`.
- Put `@farm.js/core` in dependencies and `@farm.js/cli`, TypeScript, and React types in devDependencies. Use React and React DOM 19.
- Use `farm dev` and `farm build` scripts. Every script binary must be supplied by a direct dependency.
- Use Farm.js app-directory routing with `src/app/layout.tsx`, `src/app/page.tsx`, and `src/app/globals.css`.
- Import `defineConfig` from `@farm.js/core` in `farm.config.ts`. Do not add a deployment target.
- Keep the project runnable with `npm install`, `npm run dev`, and `npm run build`.
- Prefer a deliberate type scale, generous spacing, and one accent color.
- Include useful focus, hover, loading, and empty states when the request needs them.
- Do not use a grid-pattern background, stock gradients, or placeholder copy.
- Keep dependencies minimal and use only local assets.
