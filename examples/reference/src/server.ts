import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { openai } from "@ai-sdk/openai";
import { createViby, sandboxCommandPolicy, skillRead } from "@viby/sdk";
import { e2bSandbox } from "@viby/sdk/sandbox/e2b";
import { createReferenceApp, type ReferenceAsset } from "./app.js";

for (const name of ["DATABASE_URL", "OPENAI_API_KEY", "E2B_API_KEY"] as const) {
  if (!process.env[name]) {
    throw new Error(`${name} is required. Copy .env.example to .env and fill it in.`);
  }
}

const framework = process.env.VIBY_FRAMEWORK?.trim() || "farm";
const previewPort = 4173;
const skillDirectory = fileURLToPath(new URL("../skills/design", import.meta.url));
const viby = createViby({
  framework,
  model: openai(process.env.OPENAI_MODEL ?? "gpt-5.6-sol"),
  skills: { design: [skillRead(skillDirectory)] },
  sandbox: e2bSandbox({ apiKey: process.env.E2B_API_KEY! }),
  sandboxPolicy: sandboxCommandPolicy({
    allowCommands: ["npm"],
    actions: ["run", "start"],
    maxTimeoutMs: 300_000,
  }),
});
const assets = await loadAssets();
const app = createReferenceApp({
  viby,
  scope: {
    tenantId: process.env.VIBY_TENANT_ID ?? "demo-tenant",
    userId: process.env.VIBY_USER_ID ?? "demo-user",
  },
  assets,
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
    const response = await app.fetch(request);
    await sendResponse(response, outgoing);
  } catch (error) {
    outgoing.writeHead(500, { "Content-Type": "application/json" });
    outgoing.end(JSON.stringify({ error: error instanceof Error ? error.message : "Request failed." }));
  }
});

const port = Number(process.env.PORT ?? "3000");
server.listen(port, () => {
  console.log(`Viby reference app is running at http://localhost:${port}`);
});

let closing = false;
async function close(): Promise<void> {
  if (closing) return;
  closing = true;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  await viby.close();
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
