---
name: solid
description: Generate and edit client-side Solid applications using fine-grained reactivity, typed JSX, Vite, Solid control-flow components, and accessible browser UI. Use for framework id solid when SolidStart server features are not required.
---

# Solid

Build a client-side Solid application. Use the separate SolidStart target for filesystem routes, server functions, APIs, or SSR.

## Project contract

- Declare compatible `solid-js`, `vite`, and Solid Vite plugin dependencies.
- Keep the browser entry in `src/index.tsx` or the existing entry and mount with Solid's `render` API.
- Use Solid primitives such as signals, memos, resources, and effects. Do not write React hooks or destructure reactive props in ways that lose tracking.
- Prefer Solid control-flow components for reactive branching and lists where they improve correctness.
- Keep styles and design tokens explicit and preserve the existing Vite plugin chain.

## Editing rules

- Do not add SolidStart routing to a plain Solid target.
- Add every imported package and preserve JSX compiler settings.
- Use semantic HTML and accessible interactions.

## Verification

Run the declared typecheck and `vite build`. Test state updates, conditional rendering, and list identity rather than assuming React behavior.
