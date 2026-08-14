import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { createViby, sandboxCommandPolicy, skillRead } from "@viby/sdk";
import { e2bSandbox } from "@viby/sdk/sandbox/e2b";
import { mcpAdapter } from "@viby/sdk/tools/mcp";
import { z } from "zod";
import { createReferenceApp, type ReferenceAsset } from "./app.js";

for (const name of ["DATABASE_URL", "OPENAI_API_KEY", "E2B_API_KEY"] as const) {
  if (!process.env[name]) {
    throw new Error(`${name} is required. Copy .env.example to .env and fill it in.`);
  }
}

const framework = process.env.VIBY_FRAMEWORK?.trim() || "farmjs";
const port = Number(process.env.PORT ?? "3000");
const previewPort = 4173;
const skillDirectory = fileURLToPath(new URL("../skills/design", import.meta.url));
const builtInTools = createMcpHandler(() => {
  const server = new McpServer({ name: "viby-reference-tools", version: "1.0.0" });
  server.registerTool("product_context", {
    description: "Read the durable product requirements for the generated reference project.",
    inputSchema: z.object({ focus: z.string().optional() }),
    annotations: { readOnlyHint: true, idempotentHint: true },
  }, async ({ focus }) => ({
    content: [{
      type: "text",
      text: [
        "Build accessible, responsive interfaces with explicit loading, empty, and error states.",
        focus ? `Current focus: ${focus}` : "Current focus: the complete product experience.",
      ].join("\n"),
    }],
    structuredContent: {
      framework,
      requirements: ["accessible", "responsive", "complete-states"],
    },
  }));
  return server;
}, { responseMode: "json" });
const viby = createViby({
  framework,
  model: openai(process.env.OPENAI_MODEL ?? "gpt-5.6-sol"),
  skills: { design: [skillRead(skillDirectory)] },
  tools: { adapters: { mcp: mcpAdapter() } },
  sandbox: e2bSandbox({ apiKey: process.env.E2B_API_KEY! }),
  sandboxPolicy: sandboxCommandPolicy({
    allowCommands: ["npm"],
    actions: ["run", "start"],
    maxTimeoutMs: 300_000,
  }),
});
const scope = {
  tenantId: process.env.VIBY_TENANT_ID ?? "demo-tenant",
  userId: process.env.VIBY_USER_ID ?? "demo-user",
};
const scoped = viby.forUser(scope);
const configuredToolSourceIds = await configureToolSources(scoped);
const assets = await loadAssets();
const app = createReferenceApp({
  viby,
  scope,
  assets,
  defaultToolSourceIds: configuredToolSourceIds,
  preview: {
    port: previewPort,
    install: { command: "npm", args: ["install"], timeoutMs: 300_000 },
    start: {
      command: "npm",
      args: ["run", "dev", "--", "--host", "0.0.0.0", "--port", String(previewPort)],
      timeoutMs: 300_000,
    },
  },
});

const server = createServer(async (incoming, outgoing) => {
  try {
    const request = await webRequest(incoming);
    const response = new URL(request.url).pathname === "/mcp"
      ? await builtInTools.fetch(request)
      : await app.fetch(request);
    await sendResponse(response, outgoing);
  } catch (error) {
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed." }));
  }
});

server.listen(port, () => {
  console.log(`Viby reference app is running at http://localhost:${port}`);
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await Promise.all([viby.close(), builtInTools.close()]);
}
process.once("SIGINT", () => void close());
process.once("SIGTERM", () => void close());

async function loadAssets(): Promise<Record<string, ReferenceAsset>> {
  const directory = new URL("../public/", import.meta.url);
  const entries = [
    ["/index.html", "index.html", "text/html; charset=utf-8"],
    ["/app.css", "app.css", "text/css; charset=utf-8"],
    ["/app.js", "app.js", "text/javascript; charset=utf-8"],
  ] as const;
  return Object.fromEntries(await Promise.all(entries.map(async ([path, name, contentType]) => [
    path,
    { body: await readFile(new URL(name, directory), "utf8"), contentType },
  ])));
}

async function configureToolSources(
  user: ReturnType<typeof viby.forUser>,
): Promise<readonly string[]> {
  const url = process.env.MCP_SERVER_URL?.trim();
  const endpoint = url || `http://127.0.0.1:${port}/mcp`;
  const existing = await user.toolSources.list({ type: "mcp", limit: 200 });
  const configured = existing.find((source) => source.data().configuration.url === endpoint)
    ?? await user.toolSources.create({
      type: "mcp",
      name: process.env.MCP_SERVER_NAME?.trim()
        || (url ? "Connected product tools" : "Reference product context"),
      description: "Host-configured MCP tools selected for every new project.",
      configuration: { url: endpoint },
    });
  return [configured.id];
}

async function webRequest(request: IncomingMessage): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  return new Request(`http://${request.headers.host ?? "localhost"}${request.url ?? "/"}`, {
    method: request.method ?? "GET",
    headers: request.headers as HeadersInit,
    ...(body ? { body } : {}),
  });
}

async function sendResponse(response: Response, outgoing: ServerResponse): Promise<void> {
  outgoing.writeHead(response.status, Object.fromEntries(response.headers));
  if (!response.body) {
    outgoing.end();
    return;
  }
  const reader = response.body.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!outgoing.write(Buffer.from(value))) {
      await new Promise<void>((resolve) => outgoing.once("drain", resolve));
    }
  }
  outgoing.end();
}
