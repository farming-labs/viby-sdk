---
title: "OpenAPI and JSON Schema"
description: "Generate portable API descriptions and consume the SDK's machine-readable request and response contracts."
---

# OpenAPI and JSON Schema

`@viby/sdk/schema` publishes a runtime-independent OpenAPI 3.1 document builder, the exact Web API
operation inventory, and a JSON Schema Draft 2020-12 bundle. Products can generate clients,
validate host boundaries, power API explorers, or publish a contract without importing Node,
PostgreSQL, a framework router, or provider SDKs.

## Build an OpenAPI document

```ts
import { createVibyOpenApiDocument } from "@viby/sdk/schema";

const document = createVibyOpenApiDocument({
  title: "Acme generation API",
  version: "2026-09-01",
  basePath: "/api/viby",
  serverUrl: "https://app.acme.com",
});
```

The default base path matches `createVibyApi()`. Pass the same custom `basePath` to both functions
when mounting elsewhere. The returned document is deeply frozen and contains one operation for
every shipped chat, message, generation, event, task, version, preview, tool-source, integration,
repository, deployment, callback, and compatibility route.

Viby does not prescribe product authentication. Authenticated operations reference a placeholder
`hostSession` scheme that represents the host's `authenticate(request)` callback. Replace or
augment that scheme in a serialized copy when publishing product-specific bearer, cookie, or OIDC
details. Provider callbacks are marked public because they authenticate through hashed single-use
state instead of the normal product session.

## Consume JSON Schema

```ts
import { vibyJsonSchemas } from "@viby/sdk/schema";

const feedbackSchema = vibyJsonSchemas.$defs.MessageFeedbackRequest;
const generationSchema = vibyJsonSchemas.$defs.Generation;
```

`vibyJsonSchemas` is a deeply frozen Draft 2020-12 bundle. It includes public resources and common
request bodies, including chats, messages, generations, versions, previews, feedback, source
changes, repository operations, deployment operations, and health reports. The OpenAPI components
are generated from the same definitions so the two surfaces cannot drift independently.

The schemas describe the public wire contract. They intentionally allow provider-specific fields
inside documented JSON escape hatches such as `providerOptions`, while credential values remain
outside every schema.

## Inspect the operation inventory

```ts
import { VIBY_API_OPERATIONS } from "@viby/sdk/schema";

for (const operation of VIBY_API_OPERATIONS) {
  console.log(operation.method, operation.path, operation.id);
}
```

Each entry includes a stable operation ID, method, unprefixed path, tag, success status, response
kind, optional request schema, public-callback flag, and compatibility-deprecation flag. This is
useful for host conformance tests and router integrations that do not consume OpenAPI directly.
