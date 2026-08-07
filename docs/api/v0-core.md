# v0 core API capability reference

This document records the product-generation surface exposed by `v0-sdk@0.16.7` and the official v0 Platform API documentation as reviewed on 2026-08-05. It exists to keep Viby feature planning complete without copying v0's hosted-product assumptions into a framework-agnostic SDK.

This is a capability map, not a drop-in compatibility layer. Method names under **v0** describe the audited source. Method names under **Viby** describe either the current v1 API or the intended Viby-native shape.

Status meanings:

- **Shipped**: implemented and covered by the current v1 contract.
- **Partial**: the durable core exists, but options such as cursor pagination or streaming are not shipped.
- **Planned**: part of the core parity target, but deliberately absent from the current package.
- **App-owned**: belongs to the product embedding Viby rather than this SDK.
- **Excluded**: a third-party or hosted-service feature outside this phase.

## Complete audited method inventory

This is the complete top-level surface exported by `createClient()` in `v0-sdk@0.16.7`, classified before the more detailed capability mapping below.

| Namespace | Audited methods | Viby disposition |
| --- | --- | --- |
| `chats` | `create`, `find`, `init`, `delete`, `getById`, `update`, `favorite`, `fork`, `findMessages`, `sendMessage`, `getMessage`, `findVersions`, `getVersion`, `updateVersion`, `downloadVersion`, `deleteVersionFiles`, `resume`, `stop`, `resolveTask`, `restore` | core parity target; shipped/partial/planned status is detailed below |
| `projects` | `getByChatId`, `find`, `create`, `getById`, `update`, `delete`, `assign` | app-owned grouping; the current v0 docs deprecate this resource |
| `projects` secrets | `findEnvVars`, `createEnvVars`, `updateEnvVars`, `deleteEnvVars`, `getEnvVar` | excluded secret/provider layer |
| `deployments` | `find`, `create`, `getById`, `delete`, `findLogs`, `findErrors` | excluded hosted deployment layer |
| `hooks` | `find`, `create`, `getById`, `update`, `delete` | excluded outbound third-party delivery layer |
| `integrations.vercel.projects` | `find`, `create` | excluded provider connection layer |
| `mcpServers` | `find`, `create`, `getById`, `update`, `delete`, `createOAuthAuthorizationUrl` | excluded external tool/OAuth layer |
| `rateLimits` | `find` | hosted-account concern; the embedding app owns rate limits |
| `user` | `get`, `getBilling`, `getPlan`, `getScopes` | hosted-account concern; the embedding app owns identity and billing |
| `reports` | `getUsage`, `getAIUsage`, `getUserActivity` | app-owned reporting; Viby persists the underlying per-generation usage |
| package utility | `parseStreamingResponse` | no decoder required; Viby returns typed durable events from `generation.stream` |

Within chat requests, the audited inputs also include privacy, metadata, attachments, per-request system prompts, model/thinking/image options, response mode, design-system ID, remote/memory/project skills, integration/tool IDs, and typed task resolutions. Viby keeps portable generation inputs (prompt, model, skills, attachments, metadata, response mode, and task state) in the parity target and excludes provider connection identifiers.

## Chats and generation

| Capability | v0 surface | Viby-native surface | Status | Durable state |
| --- | --- | --- | --- | --- |
| Create a chat and immediately generate | `chats.create` | `chats.create` then `chat.generate` | Shipped | chat, two messages, generation, version, files, skill snapshots |
| Create an empty chat | `chats.init` with source | `chats.create` | Shipped | chat |
| Initialize from local source files | `chats.init({ type: "files" })` | `chats.import({ source: { type: "files", files } })` | Shipped | chat plus immutable imported version and files |
| Initialize from a ZIP | `chats.init({ type: "zip" })` | `chats.import({ source: { type: "zip", bytes } })` | Shipped | chat plus immutable imported version and files |
| Initialize from a repository, registry, or hosted template | `chats.init` variants | provider adapter | Excluded | none in core |
| List chats and filter them | `chats.find` | `chats.list({ limit })` | Partial | reads chats |
| Get one chat | `chats.getById` | `chats.get(id)` | Shipped | reads chat |
| Rename and attach arbitrary metadata | `chats.update` | proposed `chat.update` | Planned | chat name and JSON metadata |
| Favorite a chat | deprecated `chats.favorite`; v0 recommends metadata | proposed `chat.update({ metadata: { favorite } })` | Planned | chat metadata |
| Delete a chat | `chats.delete` | proposed `chat.delete` | Planned | soft-delete marker; later purge policy |
| Fork a chat from a version | `chats.fork` | proposed `version.fork` | Planned | new chat and copied immutable version lineage |
| Continue from the latest version | `chats.sendMessage` | `chat.generate` | Shipped | message, generation, child version, files |
| Continue from any historical version | `chats.sendMessage`/fork workflow | `version.iterate` | Shipped | message, generation, child version, files |
| Per-request system instructions | `system` | categorized configured skills | Partial | resolved skill snapshot per generation |
| Per-request remote, memory, and project skills | `skills`, `attachedSkillIds` | categorized local and skills.sh-compatible skills | Partial | resolved skill snapshot and generation link |
| Text and URL attachments | `attachments` | proposed `attachments` on `generate` | Planned | attachment metadata and a content snapshot when allowed |
| Model and reasoning options | `modelConfiguration` | AI SDK model configured on `createViby` | Partial | provider, model ID, usage, finish state |
| Sync generation | `responseMode: "sync"` | awaited `chat.generate` | Shipped | complete durable attempt |
| Async generation | `responseMode: "async"` | `chat.start` and `generation.wait` | Shipped | queued/running/final logical state plus immutable attempts |
| Streaming generation events | `responseMode: "experimental_stream"` | `generation.stream({ after })` | Shipped | canonical state, ordered durable events, and resumable cursor |
| Stop a running generation | `chats.stop` | `generation.cancel` | Shipped | cancellation state, event, timestamp, and local model abort |
| Resume an interrupted generation | `chats.resume` | `generation.resume` | Shipped | new attempt linked by generation ID; prior active attempt becomes interrupted |
| Retry a failed generation | implicit new message/retry | `generation.retry` | Shipped | new immutable attempt on the same logical generation |
| Resolve plans, questions, or permission tasks | `chats.resolveTask` | typed `generation.resolve` | Shipped | discriminated task and resolution records plus continuation attempt |

Viby does not copy v0's hosted privacy values, `webUrl`, `apiUrl`, `demoUrl`, or screenshot URLs. Authentication, authorization, sharing routes, and product URLs belong to the application. Preview URLs only become meaningful when a future execution or deployment adapter is configured.

## Messages

| Capability | v0 surface | Viby-native surface | Status | Durable state |
| --- | --- | --- | --- | --- |
| List chat messages | `chats.findMessages` | `chat.listMessages` | Partial | reads messages |
| Cursor pagination | `limit`, `cursor` | proposed `chat.listMessages({ limit, cursor })` | Planned | no new state |
| Get one message | `chats.getMessage` | proposed `chat.getMessage` | Planned | reads message |
| User and assistant roles | message resource | `MessageData.role` | Shipped | role and content |
| Parent message/thread linkage | `parentId` | version parent lineage | Partial | version parent ID; message parent ID is planned |
| Finish reason and rich generation state | `finishReason`, experimental task content | generation attempts, events, and typed tasks | Shipped | attempt finish reason, usage, ordered events, and task records |
| Attachment metadata | message attachments | proposed attachment resource | Planned | scoped attachment rows |

## Versions, files, and artifacts

| Capability | v0 surface | Viby-native surface | Status | Durable state |
| --- | --- | --- | --- | --- |
| List versions | `chats.findVersions` | `chat.listVersions` | Shipped | reads versions |
| Get latest version | chat `latestVersion` | `chat.latestVersion` | Shipped | reads version |
| Get a version by ID | `chats.getVersion` | `chat.getVersion` | Shipped | reads version |
| Read complete source files | `getVersion({ includeDefaultFiles })` | `version.files` | Shipped | reads version file snapshot |
| Edit or add files | `chats.updateVersion` | `version.apply({ changes })` with `write` | Shipped | a new immutable child version, never in-place mutation |
| Delete files | `chats.deleteVersionFiles` | `version.apply({ changes })` with `delete` | Shipped | a new immutable child version |
| Restore a version | `chats.restore` | proposed `version.restore` | Planned | a new immutable child version pointing at the restored snapshot |
| Download ZIP | `chats.downloadVersion({ format: "zip" })` | `version.download` | Shipped | artifact is generated from persisted files |
| Download tarball | `format: "tarball"` | proposed artifact format option | Planned | artifact is generated from persisted files |
| Locked/default files | file `locked`; `includeDefaultFiles` | framework skill and generated source | Planned | lock policy on version files |
| Version status | pending/completed/failed | generation status plus successful immutable version | Shipped | generation and version records |
| Preview, screenshots, and demo URL | hosted version fields | future execution/deployment adapter | Excluded | not produced by core SDK |

## Projects, discovery, and account features

v0 exposes project grouping and search, but its current documentation marks v0 Projects as deprecated in favor of chat metadata or deployment-platform projects. Viby therefore does not copy that hosted project resource into v1.

| Capability | v0 surface | Viby decision | Status |
| --- | --- | --- | --- |
| Group chats into projects | `projects.create/find/get/update/assign/delete` | use app-owned workspaces plus planned chat metadata; reconsider a neutral collection only if real products need it | App-owned |
| Search chats/projects | account search surface | proposed tenant-scoped chat/message metadata search | Planned |
| User/team account and preferences | account surface | pass `{ tenantId, userId }` from the host application's auth | App-owned |
| Usage and billing | account usage surface | persist per-generation tokens; billing policy belongs to the app | App-owned |

## Explicitly excluded third-party and hosted surfaces

These v0 SDK areas are intentionally outside this core parity document and the Viby v1 package:

- deployments, build logs, deployment errors, preview hosting, screenshots, and domains;
- deployment-platform project connections and provider credentials;
- GitHub/repository synchronization, commits, branches, and pull requests;
- integration marketplace products and integration connections;
- project environment-variable storage or secret decryption;
- MCP server registration, OAuth, presets, and connection management;
- outgoing hooks/webhooks and their delivery logs;
- hosted v0 API keys, rate limits, credits, billing, and account management.

Those capabilities can later live behind explicit adapters. They must not change the portable source-generation contract or make provider credentials visible to Viby core.

## Persistence rules for parity work

Every future parity feature follows these rules:

1. Every row is constrained by both `tenantId` and `userId`.
2. The logical generation and immutable attempt are durable before a model request begins; every transition, failure, and cancellation has an ordered durable event.
3. Successful source changes create immutable full snapshots with parent lineage. Editing, deleting, and restoring files never mutate historical versions.
4. Exact resolved skills are content-addressed and linked to the generation that used them.
5. Model credentials and provider access tokens are never written to the Viby schema.
6. Downloads are derived from a persisted version and contain framework-native source, not provider-specific output.

## Audited sources

- [v0 SDK package](https://www.npmjs.com/package/v0-sdk)
- [v0 SDK reference](https://v0.app/docs/api/platform/packages/v0-sdk)
- [Create Chat](https://v0.app/docs/api/platform/reference/chats/create)
- [Initialize Chat](https://v0.app/docs/api/platform/reference/chats/init)
- [Find Messages](https://v0.app/docs/api/platform/reference/chats/find-messages)
- [Find Versions](https://v0.app/docs/api/platform/reference/chats/find-versions)
- [Update Version](https://v0.app/docs/api/platform/reference/chats/update-version)
- [Download Version](https://v0.app/docs/api/platform/reference/chats/download-version)
