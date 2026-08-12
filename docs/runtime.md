# Runtime boundaries

Viby publishes a Web-standard contract separately from adapters that require Node.js or a vendor SDK.

## Portable core

Import shared types and Web API helpers from `@viby/sdk/core`:

```ts
import {
  defineGenerationEngine,
  defineSkillResolver,
  generationEventStreamResponse,
  type ArtifactStore,
  type BrowserAdapter,
  type SandboxAdapter,
} from "@viby/sdk/core";
```

The core entry point has no Node.js filesystem, path, process, crypto, PostgreSQL, migration, Docker, or provider-adapter dependencies. It uses Web-standard `Request`, `Response`, `Headers`, `ReadableStream`, `AbortSignal`, `Uint8Array`, and `structuredClone` APIs.

## Node application entry points

Existing root imports remain supported during the 0.x compatibility line. New Node applications may make the runtime boundary explicit with `@viby/sdk/node`.

Node-specific behavior lives behind dedicated entry points:

| Capability | Entry point |
| --- | --- |
| Viby client with default PostgreSQL behavior | `@viby/sdk/node` |
| PostgreSQL database factory | `@viby/sdk/storage/postgres` |
| PostgreSQL migration helpers | `@viby/sdk/node/migrations` |
| local files and skills.sh/GitHub skill resolution | `@viby/sdk/node/skills` |
| filesystem artifacts | `@viby/sdk/artifact/filesystem` |
| local Docker sandbox | `@viby/sdk/sandbox/docker` |
| Playwright browser | `@viby/sdk/browser/playwright` |
| provider integrations and sandboxes | their existing explicit provider subpaths |

Node adapters require Node.js 20 or newer. The package does not declare a global Node engine because doing so would incorrectly reject portable-core consumers such as Worker applications.

## Compatibility gates

CI runs the unit suite and portable-core import guard on Node.js 20, 22, and 24, then imports and exercises the published core entry point on Bun. The import guard walks the complete emitted ESM dependency graph from `@viby/sdk/core` and fails if any reachable module imports a Node built-in. It also exercises Web `Request`, `Response`, `Headers`, streams, text encoding, and Web Crypto behavior.
