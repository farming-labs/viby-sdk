import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { openai } from "@ai-sdk/openai";
import { createViby, type Version } from "@viby/sdk";
import { github } from "@viby/sdk/integrations/github";
import { vercel } from "@viby/sdk/integrations/vercel";

const callbackUrl = new URL(required("VIBY_CALLBACK_URL"));
if (callbackUrl.protocol !== "http:") {
  throw new Error("The local integration example requires an http:// callback URL.");
}
if (!callbackUrl.port) {
  throw new Error("VIBY_CALLBACK_URL must include the local server port.");
}

const githubClientSecret = process.env.GITHUB_APP_CLIENT_SECRET?.trim();
const repository = githubClientSecret
  ? {
      github: github({
        appId: required("GITHUB_APP_ID"),
        clientId: required("GITHUB_APP_CLIENT_ID"),
        clientSecret: githubClientSecret,
        privateKey: await readFile(required("GITHUB_APP_PRIVATE_KEY_PATH"), "utf8"),
        slug: required("GITHUB_APP_SLUG"),
      }),
    }
  : undefined;

const viby = createViby({
  framework: "farm",
  model: openai(process.env.OPENAI_MODEL?.trim() || "gpt-4.1-mini"),
  integrations: {
    ...(repository ? { repository } : {}),
    deployment: {
      vercel: vercel({
        clientId: required("VERCEL_CLIENT_ID"),
        clientSecret: required("VERCEL_CLIENT_SECRET"),
        slug: required("VERCEL_INTEGRATION_SLUG"),
      }),
    },
  },
});

const scope = {
  tenantId: process.env.VIBY_TENANT_ID?.trim() || "integration-test",
  userId: process.env.VIBY_USER_ID?.trim() || "local-user",
};
const user = viby.forUser(scope);
const host = callbackUrl.hostname;
const port = Number(callbackUrl.port);

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    console.error(error instanceof Error ? `${error.name}: ${error.message}` : "Unknown request error");
    html(response, 500, page("Integration check failed", {
      error: error instanceof Error ? error.message : "Unknown integration error.",
    }));
  }
});

server.listen(port, host, () => {
  console.log(`Viby integration check listening on ${callbackUrl.origin}`);
  console.log(`Callback URL: ${callbackUrl.href}`);
  if (!repository) {
    console.log("GitHub is disabled until GITHUB_APP_CLIENT_SECRET is configured.");
  }
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    server.close(() => {
      void viby.close().finally(() => process.exit(0));
    });
  });
}

async function route(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url || "/", callbackUrl.origin);
  if (request.method === "GET" && url.pathname === "/") {
    const [repositories, deployments] = await Promise.all([
      user.integrations.repository.list(),
      user.integrations.deployment.list(),
    ]);
    html(response, 200, page("Real integration check", {
      notice: url.searchParams.get("notice"),
      error: url.searchParams.get("error"),
      repositories,
      deployments,
      githubEnabled: Boolean(repository),
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === callbackUrl.pathname) {
    const completed = await viby.integrations.callback(new Request(url));
    redirect(response, withNotice(completed.returnTo, `${completed.integrationId} connected.`));
    return;
  }

  if (request.method === "POST" && url.pathname === "/connect/github") {
    if (!repository) throw new Error("GitHub needs GITHUB_APP_CLIENT_SECRET from the configured GitHub App.");
    await connect(response, "repository", "github");
    return;
  }

  if (request.method === "POST" && url.pathname === "/connect/vercel") {
    await connect(response, "deployment", "vercel");
    return;
  }

  if (request.method === "POST" && url.pathname === "/verify/github") {
    const version = await fixtureVersion();
    const sourceControl = user.integrations.repository.use("github");
    const owner = required("GITHUB_TEST_OWNER");
    const name = process.env.GITHUB_TEST_REPOSITORY?.trim() || "viby-sdk-integration-test";
    const result = await version.push({
      using: sourceControl,
      repository: { owner, name, createIfMissing: true, visibility: "private" },
      branch: { name: "main", createIfMissing: true },
      commit: { message: "test: verify Viby GitHub integration" },
    });
    redirect(response, withNotice("/", `GitHub ${result.status}: ${owner}/${name}.`));
    return;
  }

  if (request.method === "POST" && url.pathname === "/verify/vercel") {
    const version = await fixtureVersion();
    const deployment = await version.deploy({
      using: user.integrations.deployment.use("vercel"),
      project: {
        name: process.env.VERCEL_TEST_PROJECT?.trim() || "viby-sdk-integration-test",
        createIfMissing: true,
        providerOptions: {
          framework: null,
          installCommand: "npm install --legacy-peer-deps",
          buildCommand: "npm run build",
        },
      },
      environment: "preview",
      providerOptions: {
        skipAutoDetectionConfirmation: true,
        meta: { source: "viby-sdk-real-integration-check" },
      },
    });
    redirect(response, withNotice("/", `Vercel ${deployment.status}: ${deployment.url ?? deployment.id}.`));
    return;
  }

  if (request.method === "POST" && url.pathname === "/verify/generation") {
    const chat = await user.chats.create({
      title: "Real OpenAI integration check",
      metadata: { example: "real-integrations" },
    });
    const version = await chat.generate({
      prompt: "Return a minimal runnable Farm project with one polished welcome page.",
    });
    const download = await version.download();
    const directory = resolve("output");
    await mkdir(directory, { recursive: true });
    const target = resolve(directory, download.filename);
    await writeFile(target, download.bytes);
    redirect(response, withNotice("/", `Generated version ${version.number}; ZIP saved to ${target}.`));
    return;
  }

  html(response, 404, page("Not found", { error: `${request.method} ${url.pathname}` }));
}

async function connect(
  response: ServerResponse,
  category: "repository" | "deployment",
  integrationId: string,
): Promise<void> {
  const integrations = category === "repository"
    ? user.integrations.repository
    : user.integrations.deployment;
  const result = await integrations.connect(integrationId, {
    callbackUrl: callbackUrl.href,
    returnTo: "/",
  });
  if (result.status === "authorization-required") {
    redirect(response, result.url);
    return;
  }
  redirect(response, withNotice("/", `${integrationId} is already connected.`));
}

async function fixtureVersion(): Promise<Version<"farm">> {
  const existing = await user.chats.list({
    limit: 1,
    metadata: { example: "real-integration-fixture-v2" },
  });
  const current = existing.items[0] ? await existing.items[0].latestVersion() : null;
  if (current) return current;

  const chat = await user.chats.import({
    title: "Viby integration fixture",
    summary: "A deterministic Farm project for real provider verification.",
    metadata: { example: "real-integration-fixture-v2" },
    source: {
      type: "files",
      files: fixtureFiles(),
    },
  });
  const version = await chat.latestVersion();
  if (!version) throw new Error("The fixture import did not produce a source version.");
  return version;
}

function fixtureFiles() {
  return [
    {
      path: "package.json",
      content: JSON.stringify({
        name: "viby-real-integration-check",
        private: true,
        version: "0.0.0",
        type: "module",
        scripts: { dev: "farm dev", build: "farm build", start: "farm start" },
        dependencies: {
          "@farm.js/core": "0.1.0-beta.26",
          react: "^19.0.0",
          "react-dom": "^19.0.0",
        },
        devDependencies: {
          "@farm.js/cli": "0.1.0-beta.26",
          "@types/react": "^19.0.0",
          "@types/react-dom": "^19.0.0",
          typescript: "^5.3.3",
        },
      }, null, 2) + "\n",
    },
    {
      path: "farm.config.ts",
      content: [
        'import { defineConfig } from "@farm.js/core";',
        "",
        "export default defineConfig({",
        '  deploy: { target: "vercel" },',
        "});",
        "",
      ].join("\n"),
    },
    {
      path: "src/app/layout.tsx",
      content: [
        'import type { ReactNode } from "react";',
        'import "./globals.css";',
        "",
        "export const metadata = {",
        '  title: "Viby verified",',
        '  description: "A real Viby SDK integration check.",',
        "};",
        "",
        "export default function RootLayout({ children }: { children: ReactNode }) {",
        '  return <html lang="en"><body>{children}</body></html>;',
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/app/page.tsx",
      content: [
        "export default function HomePage() {",
        "  return (",
        "    <main>",
        "      <span>Viby SDK</span>",
        "      <h1>Provider connection verified.</h1>",
        "      <p>This immutable Farm project was deployed through the provider-neutral integration API.</p>",
        "    </main>",
        "  );",
        "}",
        "",
      ].join("\n"),
    },
    {
      path: "src/app/globals.css",
      content: ":root{font-family:Inter,ui-sans-serif,system-ui;color:#17201b;background:#eff4ef}*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:24px}main{max-width:720px;padding:64px;border:1px solid #cdd8cf;border-radius:24px;background:#fff;box-shadow:0 24px 70px rgba(30,60,40,.12)}span{font-size:13px;font-weight:700;letter-spacing:.12em;text-transform:uppercase;color:#42815b}h1{font-size:clamp(40px,8vw,72px);line-height:.98;letter-spacing:-.055em;margin:24px 0}p{max-width:560px;font-size:18px;line-height:1.65;color:#5d6961;margin:0}\n",
    },
    {
      path: "tsconfig.json",
      content: JSON.stringify({
        compilerOptions: {
          target: "ES2020",
          lib: ["ES2020", "DOM", "DOM.Iterable"],
          module: "ESNext",
          moduleResolution: "bundler",
          jsx: "react-jsx",
          strict: true,
          skipLibCheck: true,
          isolatedModules: true,
          noEmit: true,
        },
        include: ["src", "farm.config.ts"],
      }, null, 2) + "\n",
    },
    {
      path: "README.md",
      content: "# Viby real integration check\n\nThis deterministic Farm project verifies repository and deployment adapters.\n",
    },
  ] as const;
}

function page(
  title: string,
  input: {
    notice?: string | null;
    error?: string | null;
    repositories?: readonly unknown[];
    deployments?: readonly unknown[];
    githubEnabled?: boolean;
  },
): string {
  const repositories = input.repositories ?? [];
  const deployments = input.deployments ?? [];
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title><style>
:root{font-family:Inter,ui-sans-serif,system-ui;color:#17201b;background:#edf2ed}*{box-sizing:border-box}body{margin:0;padding:32px}main{max-width:900px;margin:auto}.eyebrow{font-size:12px;font-weight:800;letter-spacing:.12em;text-transform:uppercase;color:#407b56}h1{font-size:clamp(40px,7vw,68px);line-height:1;letter-spacing:-.055em;margin:18px 0 14px}p{color:#5d6961;line-height:1.65}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:16px;margin-top:28px}.card{background:#fff;border:1px solid #d2dcd4;border-radius:20px;padding:22px;box-shadow:0 18px 50px rgba(30,60,40,.07)}h2{font-size:18px;margin:0 0 8px}.status{font:12px ui-monospace,SFMono-Regular,monospace;color:#69756c;white-space:pre-wrap;overflow-wrap:anywhere}form{display:inline-block;margin:12px 8px 0 0}button{appearance:none;border:0;border-radius:999px;padding:11px 16px;font-weight:700;background:#193c28;color:#fff;cursor:pointer}button.secondary{background:#e7eee8;color:#193c28}button:disabled{cursor:not-allowed;opacity:.42}.alert{padding:14px 16px;border-radius:14px;margin:18px 0;background:#e3f4e8;color:#245b36}.alert.error{background:#fae8e5;color:#8b3228}footer{margin-top:22px;color:#6e796f;font-size:13px}
</style></head><body><main><div class="eyebrow">Viby SDK · local verification</div><h1>${escapeHtml(title)}</h1><p>Connect user-owned accounts, then exercise the same immutable source snapshot through repository and deployment adapters.</p>
${input.notice ? `<div class="alert">${escapeHtml(input.notice)}</div>` : ""}
${input.error ? `<div class="alert error">${escapeHtml(input.error)}</div>` : ""}
<div class="grid">
<section class="card"><h2>GitHub repository</h2><p>${input.githubEnabled ? "OAuth is configured locally." : "Waiting for this GitHub App's OAuth client secret."}</p><div class="status">${escapeHtml(JSON.stringify(repositories, null, 2))}</div><form method="post" action="/connect/github"><button ${input.githubEnabled ? "" : "disabled"}>Connect GitHub</button></form><form method="post" action="/verify/github"><button class="secondary" ${input.githubEnabled ? "" : "disabled"}>Push fixture</button></form></section>
<section class="card"><h2>Vercel deployment</h2><p>Connect a workspace before creating the disposable preview.</p><div class="status">${escapeHtml(JSON.stringify(deployments, null, 2))}</div><form method="post" action="/connect/vercel"><button>Connect Vercel</button></form><form method="post" action="/verify/vercel"><button class="secondary">Deploy fixture</button></form></section>
<section class="card"><h2>OpenAI generation</h2><p>Runs a real model call, persists the result, and writes a source ZIP under this example's output directory.</p><form method="post" action="/verify/generation"><button>Generate and download</button></form></section>
</div><footer>Tenant: ${escapeHtml(scope.tenantId)} · User: ${escapeHtml(scope.userId)} · Callback: ${escapeHtml(callbackUrl.href)}</footer></main></body></html>`;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function redirect(response: ServerResponse, location: string): void {
  response.writeHead(303, { location });
  response.end();
}

function html(response: ServerResponse, status: number, body: string): void {
  response.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  response.end(body);
}

function withNotice(path: string, notice: string): string {
  const url = new URL(path, callbackUrl.origin);
  url.searchParams.set("notice", notice);
  return `${url.pathname}${url.search}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#039;",
  })[character]!);
}
