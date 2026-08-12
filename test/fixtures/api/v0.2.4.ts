import type { LanguageModel } from "ai";
import {
  createViby,
  defineSkillResolver,
  generationEventCursor,
  generationEventStreamResponse,
  openTelemetry,
  sandboxCommandPolicy,
  signedOutboundEventSink,
  skillRead,
  skillFrom,
  skillInline,
  type ChatData,
  type GenerationEvent,
  type GenerationOutcome,
  type OutboundEventSink,
  type OpenTelemetryTracerLike,
  type SandboxAdapter,
  type SkillGroups,
  type UserScope,
  type VersionFile,
  type Viby,
  type VibyStorage,
} from "@viby/sdk";
import { postgres } from "@viby/sdk/storage/postgres";
import { s3 } from "@viby/sdk/storage/s3";
import { registerVibyMcpTools } from "@viby/sdk/mcp";

declare const model: LanguageModel;
declare const sandbox: SandboxAdapter;
declare const sink: OutboundEventSink;
declare const tracer: OpenTelemetryTracerLike;
declare const storage: VibyStorage;

const skills = {
  frontend: ["farming-labs/design-eng-skills/frontend-design"],
  testing: [skillRead("./skills/testing/SKILL.md")],
  core: [skillInline({ name: "rules", files: [{ path: "SKILL.md", content: "# Rules" }] })],
  design: [skillFrom("company/catalog", "design-system")],
} satisfies SkillGroups;

const skillResolver = defineSkillResolver({
  id: "company/catalog",
  async resolve({ reference }) {
    if (typeof reference === "string" || reference.source !== "resolver") return null;
    return {
      name: reference.locator,
      files: [{ path: "SKILL.md", content: `# ${reference.locator}` }],
    };
  },
});

const client = createViby({
  framework: "farm",
  model,
  skills,
  skillResolver,
  sandbox,
  sandboxPolicy: sandboxCommandPolicy({ allowCommands: ["npm"] }),
  generation: { execution: "worker" },
  events: { sinks: [sink] },
  telemetry: openTelemetry({ tracer }),
  cost: { currency: "USD", calculate: ({ totalTokens }) => totalTokens ?? 0 },
});

const typedClient: Viby<"farm"> = client;
const scope: UserScope = { tenantId: "tenant", userId: "user" };
const user = typedClient.forUser(scope);

async function exerciseShippedApi(): Promise<void> {
  const chat = await user.chats.create({ title: "Compatibility", metadata: { team: "sdk" } });
  await user.chats.list({ limit: 20, metadata: { team: "sdk" } });
  const generation = await chat.start({ prompt: "Build a product" });
  const request = new Request("https://example.test", {
    headers: { "Last-Event-ID": "12" },
  });
  const cursor: string | undefined = generationEventCursor(request);
  const response: Response = generationEventStreamResponse(generation, { request });
  void cursor;
  void response;

  const outcome: GenerationOutcome<"farm"> = await generation.wait();
  if (outcome.status === "succeeded") {
    const files: readonly VersionFile[] = await outcome.version.files();
    const next = await outcome.version.iterate({ prompt: "Refine it" });
    await next.download();
    void files;
  }

  const data: Pick<ChatData<"farm">, "id" | "title" | "framework" | "metadata"> = {
    id: chat.id,
    title: chat.title,
    framework: chat.framework,
    metadata: chat.metadata,
  };
  const events: readonly GenerationEvent[] = (await generation.events()).events;
  void data;
  void events;
}

function exposeMcp(server: Parameters<typeof registerVibyMcpTools>[0]): void {
  registerVibyMcpTools(server, { viby: user });
}

void exerciseShippedApi;
void exposeMcp;
void signedOutboundEventSink;
void postgres;
void s3;
void storage;
