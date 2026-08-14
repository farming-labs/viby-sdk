---
name: vue
description: Generate and edit typed Vue applications with Vite, Vue single-file components, Composition API, scoped styles, and optional Vue Router or Pinia integrations. Use for framework id vue when Nuxt server features are not required.
---

# Vue

Build a Vue client application. Use the separate Nuxt target for filesystem routing, SSR, server APIs, or Nitro deployment.

## Project contract

- Declare compatible `vue`, `vite`, and `@vitejs/plugin-vue` dependencies.
- Keep the entry in `src/main.ts`, the root in `src/App.vue`, and feature components under `src/components` unless the imported source establishes another structure.
- Prefer typed `<script setup lang="ts">` single-file components and the Composition API.
- Keep component styles scoped when local and import shared design tokens or resets once at the application entry.
- Add Vue Router or Pinia only when the prompt or existing source needs them; configure them through their normal app plugins.

## Editing rules

- Do not generate React hooks, Svelte runes, or Nuxt auto-import assumptions.
- Preserve the existing Vite plugin chain and TypeScript aliases.
- Add every imported package and avoid mutating props directly.

## Verification

Run the declared typecheck and production build. Conventional scripts use `vite`, `vue-tsc`, and `vite build`.
