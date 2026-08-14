---
name: nextjs
description: Generate and edit Next.js applications using the App Router, React Server and Client Components, route handlers, layouts, metadata, and Next.js build conventions. Use for framework id nextjs and existing Next.js projects.
---

# Next.js

Use the App Router for new projects unless the imported source already uses the Pages Router.

## Project contract

- Declare compatible `next`, `react`, and `react-dom` dependencies.
- Put routes in `app/` or `src/app/`. Provide a required root `layout.tsx` containing `<html>` and `<body>` and a `page.tsx` for `/`.
- Use special files such as `loading.tsx`, `error.tsx`, `not-found.tsx`, and `route.ts` according to their framework roles.
- Keep components server-rendered by default. Add `"use client"` only where hooks, browser APIs, mutable state, or event handlers require it.
- Use route handlers for HTTP APIs and server functions/actions for trusted application mutations. Validate inputs and authorize on the server.
- Keep static assets in `public/` and framework configuration in `next.config.*`.

## Editing rules

- Do not mix Pages Router and App Router conventions in a new tree.
- Do not expose secrets through client components or public environment-variable prefixes.
- Preserve generated type files and existing bundler choices.
- Add every imported package and verify its React peer range.

## Verification

Use the manifest's scripts. A conventional project supports `next dev`, `next build`, and `next start`; typecheck separately when the project defines it.
