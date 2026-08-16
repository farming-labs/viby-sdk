---
title: "Tool sources"
description: "Expose host-configured tools with durable selection, isolated credentials, approval policy, and idempotent effects."
---

# Tool sources

Tool sources let a generation discover and call host-configured capabilities without coupling Viby
to a specific protocol. Sources may be process-configured, registered durably by a user, or supplied
through the MCP client adapter.

## Core `ToolSource`

```ts
const source = defineToolSource({
  id: "product-catalog",
  async list(context) {
    return [{
      name: "find_product",
      description: "Find a product by SKU",
      inputSchema: { type: "object", properties: { sku: { type: "string" } } },
      effect: "read",
    }];
  },
  async call(call, context) {
    return catalog.find(call.arguments.sku);
  },
});
```

`list(context)` returns tool definitions. `call(call, context)` returns bounded JSON. The context
contains tenant, user, chat, generation, attempt, framework, metadata, and abort signal. It never
contains a provider credential unless the application intentionally closes over one inside its
adapter.

Every tool declares a `read`, `write`, or `external` effect. External effects receive a stable
idempotency key and must use it when contacting downstream systems.

## Configure static sources

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  tools: {
    sources: { catalog: source },
    select: ({ available, context }) =>
      context.metadata.toolset === "catalog" ? ["catalog"] : [],
    policy: ({ tool }) => tool.effect === "read" ? "allow" : "approval-required",
  },
});
```

When `select` is omitted, all configured sources are eligible. The default policy allows reads and
requires approval for write/external effects. A policy may return `allow`, `deny`, or
`approval-required` asynchronously.

## Durable registrations

Register adapter types once, then let each scoped user create credential-free source records:

```ts
const viby = createViby({
  framework: "farmjs",
  model,
  tools: {
    adapters: {
      mcp: defineToolSourceAdapter({
        type: "mcp",
        open: ({ source, credential }) => openCompanyMcp({ source, credential }),
      }),
    },
  },
});

const registered = await user.toolSources.create({
  type: "mcp",
  name: "Company tools",
  configuration: { endpoint: "https://tools.example.com/mcp" },
});

await chat.toolSources.set([registered.id]);
```

Configuration is JSON-only and rejects credential-like keys. Registrations are explicitly selected
per chat and resolved into the same `ToolSource` contract as static sources.

## `RegisteredToolSourceCollection`

| Method | Behavior |
| --- | --- |
| `create(input)` | Validates a configured adapter type and persists an active registration. |
| `get(id)` | Loads one scoped registration. |
| `list({ status?, type?, limit? })` | Lists registrations with bounded optional filters. |

## `RegisteredToolSource`

| Member | Behavior |
| --- | --- |
| `id`, `type`, `name`, `status` | Current public identity and lifecycle state. |
| `data()` | Returns the complete credential-free registration record. |
| `update(input)` | Updates name, description, public configuration, or enabled state and refreshes the handle. |
| `archive()` | Permanently archives the registration and removes it from chat selections. |
| `connection()` | Returns redacted provider connection metadata or `null`. |
| `connect(input)` | Returns a healthy existing connection or an authorization URL with expiry. |
| `disconnect(signal?)` | Revokes when supported, removes secret material, and records local revocation. |

## `ChatToolSourceSelection`

| Method | Behavior |
| --- | --- |
| `list()` | Returns active durable sources explicitly selected for the chat. |
| `set(sourceIds)` | Atomically replaces the selection after validating every source belongs to this scope. |

Static selection from `tools.select` and durable chat selection are combined by the configured
runtime. Archived or disabled registrations cannot be exposed to a new generation.

## Authorization callbacks

An adapter may define `startAuthorization`, `completeAuthorization`, optional refresh, and optional
revocation. Start the flow from an authenticated request:

```ts
const result = await registered.connect({
  callbackUrl: "https://app.example.com/api/viby/tool-sources/callback",
  returnTo: "/settings/tools",
});
```

Complete it in the public callback route:

```ts
const completed = await viby.toolSources.callback(request);
return Response.redirect(new URL(completed.returnTo, appOrigin));
```

Viby hashes bounded, expiring, single-use state and restores the original tenant/user/source scope.
The provider credential is stored through `storage.secrets`; public connection data contains account,
scope, status, and expiry only. The host must allowlist safe return paths before redirecting.

## Tool calls, approval, and redaction

Arguments and results are validated as bounded JSON and redacted before persistence. Common password,
token, authorization, cookie, credential, secret, private-key, and API-key fields become
`[REDACTED]`; Viby does not retain an unredacted ordinary record.

Denied tools are not called. Approval-required tools produce a durable permission task containing a
safe proposed action. External effects require an idempotency key; duplicate starts return the
existing tool-call record so a retry can reuse or reconcile its outcome.

## MCP adapter

Import `mcp` from `@viby/sdk/tools/mcp`. It supports Streamable HTTP and application-supplied
transports while keeping per-chat credentials inside the transport factory. Install the optional
`@modelcontextprotocol/client` peer only when using this adapter.

`@viby/sdk/mcp` is the opposite direction: it exposes selected Viby operations through an official
MCP server. The supplied `ScopedViby` already establishes identity, so tenant/user IDs are never tool
arguments.
