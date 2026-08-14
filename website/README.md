# Viby documentation website

The Viby docs website is a standalone Farm application. The tracked `website/docs` source link
points at the SDK's existing `docs/` directory, so Farm compiles the original Markdown without a
second hand-maintained content tree.

## Local development

From the repository root:

```bash
npm run docs:install
npm run docs:dev
```

Production checks use the same boundary:

```bash
npm run docs:typecheck
npm run docs:build
```

## Farm docs adapter

The integration has three explicit pieces:

1. `farm.config.ts` wraps Farm's `defineConfig()` result with `withDocs()` from
   `@farming-labs/farmjs/config`.
2. `docs.config.ts` points `contentDir` at the repository's `docs` folder and selects `shadcn()`
   from `@farming-labs/theme/shadcn`.
3. `src/app/globals.css` imports the matching `@farming-labs/theme/shadcn/css` stylesheet.

The theme factory and CSS entrypoint must use the same theme name. Farm owns development and
production routing for `/docs`, Markdown representations, search, sitemaps, `llms.txt`, and MCP
surfaces exposed by the adapter.
