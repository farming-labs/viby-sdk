import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import type { LanguageModel, LanguageModelUsage } from "ai";
import { strFromU8, unzipSync } from "fflate";
import { createVibyWithDependencies } from "../../src/client.js";
import type {
  GeneratorInput,
  GeneratorOptions,
  GeneratorOutput,
  ProjectGenerator,
} from "../../src/generator.js";
import { SkillResolver } from "../../src/skills.js";
import type {
  DesignEvaluationCriterionInput,
  FrameworkId,
  SourceChange,
  VersionFile,
} from "../../src/types.js";
import { sha256 } from "../../src/utils.js";
import { MemoryRepository } from "../helpers/memory-repository.js";
import {
  GENERATED_PROJECT_QUALITY_MATRIX,
  type GeneratedProjectQualityScenario,
} from "../fixtures/quality/matrix.js";

const execFileAsync = promisify(execFile);
const usage: LanguageModelUsage = {
  inputTokens: 100,
  inputTokenDetails: {
    noCacheTokens: 100,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  },
  outputTokens: 200,
  outputTokenDetails: { textTokens: 200, reasoningTokens: 0 },
  totalTokens: 300,
};

for (const scenario of GENERATED_PROJECT_QUALITY_MATRIX) {
  test(`generated-project quality matrix: ${scenario.id}`, async (context) => {
    const repository = new MemoryRepository();
    const generator = new MatrixGenerator(scenario);
    const viby = createVibyWithDependencies(
      {
        framework: scenario.framework,
        model: "quality/deterministic" as LanguageModel,
        skills: {},
      },
      { repository, generator, skillResolver: new SkillResolver({}) },
    );
    context.after(() => viby.close());
    const chat = await viby
      .forUser({ tenantId: `quality-${scenario.id}`, userId: "quality-runner" })
      .chats.create({ title: scenario.title, metadata: { matrix: scenario.id } });
    const reference = new TextEncoder().encode(`reference:${scenario.id}`);
    const initial = await chat.generate({
      prompt: scenario.prompt,
      instructions: "Include loading, empty, error, responsive, and keyboard interaction states.",
      metadata: { matrix: scenario.id, release: 1 },
      attachments: [{
        filename: "design-reference.txt",
        mediaType: "text/plain",
        bytes: reference,
      }],
    });

    assert.equal(initial.framework, scenario.framework);
    assert.equal(generator.calls[0]?.framework, scenario.framework);
    assert.deepEqual(generator.calls[0]?.metadata, { matrix: scenario.id, release: 1 });
    assert.deepEqual(generator.calls[0]?.attachments?.[0]?.bytes, reference);
    const initialCriteria = await verifyGeneratedVersion(scenario, 1, await initial.files());
    await verifyDownload(initialCriteria.files, await initial.download());
    await runGeneratedProject(scenario, 1, initialCriteria.files, context);
    const initialEvaluation = await initial.recordDesignEvaluation({
      evaluator: "viby-quality-matrix@1",
      status: "passed",
      score: 100,
      summary: "All deterministic generated-project quality gates passed.",
      criteria: initialCriteria.criteria,
      metadata: { matrix: scenario.id, release: 1 },
    });
    assert.equal(initialEvaluation.versionId, initial.id);

    const iterated = await initial.iterate({
      prompt: "Refine the release while preserving every verified quality state.",
      metadata: { matrix: scenario.id, release: 2 },
    });
    assert.equal(iterated.parentVersionId, initial.id);
    assert.equal((await iterated.changes()).length, 2);
    const iteratedCriteria = await verifyGeneratedVersion(scenario, 2, await iterated.files());
    await verifyDownload(iteratedCriteria.files, await iterated.download());
    await runGeneratedProject(scenario, 2, iteratedCriteria.files, context);
    await iterated.recordDesignEvaluation({
      evaluator: "viby-quality-matrix@1",
      status: "passed",
      score: 100,
      summary: "The iteration preserved every generated-project quality gate.",
      criteria: iteratedCriteria.criteria,
      metadata: { matrix: scenario.id, release: 2 },
    });
    assert.equal((await initial.listDesignEvaluations()).items.length, 1);
    assert.equal((await iterated.listDesignEvaluations()).items.length, 1);
  });
}

class MatrixGenerator<Framework extends FrameworkId> implements ProjectGenerator<Framework> {
  readonly calls: Array<GeneratorInput<Framework>> = [];
  readonly #scenario: GeneratedProjectQualityScenario;

  constructor(scenario: GeneratedProjectQualityScenario) {
    this.#scenario = scenario;
  }

  async generate(
    input: GeneratorInput<Framework>,
    options: GeneratorOptions = {},
  ): Promise<GeneratorOutput> {
    this.calls.push(input);
    const release = input.previousFiles.length === 0 ? 1 : 2;
    await options.onDelta?.(`quality-release-${release}`);
    const files = generatedFiles(this.#scenario, release);
    if (release === 1) {
      return {
        kind: "project",
        title: this.#scenario.title,
        summary: "Generated a complete quality-matrix project.",
        files,
        usage,
        finishReason: "stop",
      };
    }
    const mutablePaths = new Set([
      "public/index.html",
      `${this.#scenario.sourceDirectory}/app.js`,
    ]);
    const changes: SourceChange[] = files
      .filter((file) => mutablePaths.has(file.path))
      .map((file) => ({
        type: "write",
        path: file.path,
        content: file.content,
        mediaType: file.mediaType,
      }));
    return {
      kind: "changes",
      title: `${this.#scenario.title} release 2`,
      summary: "Refined the project without regressing its quality contract.",
      changes,
      usage,
      finishReason: "stop",
    };
  }
}

function generatedFiles(
  scenario: GeneratedProjectQualityScenario,
  release: number,
): VersionFile[] {
  const entry = `${scenario.sourceDirectory}/app.js`;
  const styles = `${scenario.sourceDirectory}/styles.css`;
  const packageJson = JSON.stringify({
    name: scenario.id,
    private: true,
    type: "module",
    scripts: {
      check: "node scripts/quality-check.mjs",
      build: `node --check ${entry} && node --check scripts/preview.mjs`,
      preview: "node scripts/preview.mjs",
    },
  }, null, 2);
  return [
    file("package.json", packageJson),
    file("public/index.html", html(scenario, release), "text/html"),
    file(entry, clientScript(release), "text/javascript"),
    file(styles, css(scenario), "text/css"),
    file("scripts/quality-check.mjs", qualityCheckScript(entry, styles), "text/javascript"),
    file("scripts/preview.mjs", previewScript(), "text/javascript"),
    file("README.md", `# ${scenario.title}\n\nGenerated for ${scenario.framework}. Release ${release}.\n`, "text/markdown"),
  ].sort((left, right) => left.path.localeCompare(right.path));
}

function html(scenario: GeneratedProjectQualityScenario, release: number): string {
  return `<!doctype html>
<html lang="en" data-release="${release}">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="${scenario.accent}" />
    <title>${scenario.title}</title>
    <link rel="stylesheet" href="/${scenario.sourceDirectory}/styles.css" />
  </head>
  <body>
    <a class="skip-link" href="#content">Skip to content</a>
    <nav aria-label="Primary navigation"><strong>${scenario.title}</strong></nav>
    <main id="content" tabindex="-1">
      <header><p class="eyebrow">Release ${release}</p><h1>Operational overview</h1></header>
      <section aria-labelledby="metrics-heading"><h2 id="metrics-heading">Key metrics</h2></section>
      <section id="loading-state" aria-live="polite">Loading workspace data…</section>
      <section id="empty-state" hidden><h2>No results yet</h2><p>Adjust the active filters.</p></section>
      <section id="error-state" role="alert" hidden><h2>Data could not be loaded</h2><button type="button">Retry</button></section>
      <button id="refresh" type="button" aria-controls="loading-state">Refresh data</button>
    </main>
    <script type="module" src="/${scenario.sourceDirectory}/app.js"></script>
  </body>
</html>`;
}

function clientScript(release: number): string {
  return `const release = ${release};
const refresh = document.querySelector("#refresh");
const loading = document.querySelector("#loading-state");
refresh?.addEventListener("click", () => {
  loading?.removeAttribute("hidden");
  loading?.setAttribute("data-release", String(release));
});
export { release };
`;
}

function css(scenario: GeneratedProjectQualityScenario): string {
  return `:root { color-scheme: light; --accent: ${scenario.accent}; --surface: #ffffff; --text: #171717; }
* { box-sizing: border-box; }
body { margin: 0; color: var(--text); background: #f5f5f4; font: 16px/1.5 system-ui, sans-serif; }
nav, main { width: min(72rem, calc(100% - 2rem)); margin-inline: auto; }
nav { display: flex; min-height: 4rem; align-items: center; border-bottom: 1px solid #d6d3d1; }
main { display: grid; gap: 1rem; padding-block: 2rem; }
section { padding: 1rem; border: 1px solid #e7e5e4; border-radius: .75rem; background: var(--surface); }
button { min-height: 2.75rem; border: 0; border-radius: .5rem; color: white; background: var(--accent); }
:focus-visible { outline: 3px solid var(--accent); outline-offset: 3px; }
.skip-link { position: fixed; inset: .5rem auto auto .5rem; transform: translateY(-200%); }
.skip-link:focus { transform: translateY(0); }
@media (min-width: 48rem) { main { grid-template-columns: repeat(2, minmax(0, 1fr)); } header { grid-column: 1 / -1; } }
@media (prefers-reduced-motion: reduce) { *, *::before, *::after { scroll-behavior: auto !important; } }
`;
}

function qualityCheckScript(entry: string, styles: string): string {
  return `import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
const html = await readFile("public/index.html", "utf8");
const css = await readFile(${JSON.stringify(styles)}, "utf8");
const script = await readFile(${JSON.stringify(entry)}, "utf8");
for (const marker of ["aria-live", "empty-state", "role=\\\"alert\\\"", "type=\\\"button\\\""]) assert.ok(html.includes(marker), marker);
for (const marker of [":focus-visible", "@media (min-width", "prefers-reduced-motion"]) assert.ok(css.includes(marker), marker);
assert.ok(script.includes("addEventListener"));
assert.doesNotMatch(html + css + script, /TODO|FIXME|lorem ipsum/i);
console.log("quality-contract:pass");
`;
}

function previewScript(): string {
  return `import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
const html = await readFile("public/index.html", "utf8");
const server = createServer((_request, response) => {
  response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  response.end(html);
});
server.listen(0, "127.0.0.1", () => {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing preview port");
  console.log("VIBY_PREVIEW_PORT=" + address.port);
});
`;
}

async function verifyGeneratedVersion(
  scenario: GeneratedProjectQualityScenario,
  release: number,
  files: readonly VersionFile[],
): Promise<{ files: readonly VersionFile[]; criteria: readonly DesignEvaluationCriterionInput[] }> {
  assert.equal(files.length, 7);
  assert.deepEqual(
    files.map((file) => file.path),
    [...files.map((file) => file.path)].sort((left, right) => left.localeCompare(right)),
  );
  for (const generated of files) {
    assert.equal(generated.size, Buffer.byteLength(generated.content));
    assert.equal(generated.checksum, sha256(generated.content));
    assert.equal(generated.locked, false);
  }
  const byPath = new Map(files.map((file) => [file.path, file]));
  const packageJson = JSON.parse(byPath.get("package.json")!.content) as {
    scripts: Record<string, string>;
  };
  assert.deepEqual(Object.keys(packageJson.scripts).sort(), ["build", "check", "preview"]);
  assert.match(byPath.get("public/index.html")!.content, new RegExp(`data-release="${release}"`));
  assert.match(byPath.get("public/index.html")!.content, new RegExp(scenario.title));
  return {
    files,
    criteria: [
      criterion("source-integrity", "Source integrity", "Every file has stable size and checksum metadata."),
      criterion("interaction-states", "Interaction states", "Loading, empty, error, and retry states are present."),
      criterion("accessibility", "Accessibility", "Landmarks, labels, focus visibility, and reduced motion are present."),
      criterion("responsive-layout", "Responsive layout", "The project includes a bounded responsive layout."),
      criterion("runtime-contract", "Runtime contract", "Check, build, and preview scripts are declared."),
    ],
  };
}

function criterion(id: string, label: string, summary: string): DesignEvaluationCriterionInput {
  return { id, label, status: "passed", score: 100, summary };
}

async function verifyDownload(
  expected: readonly VersionFile[],
  artifact: { readonly bytes: Uint8Array },
): Promise<void> {
  const archive = unzipSync(artifact.bytes);
  assert.deepEqual(Object.keys(archive).sort(), expected.map((file) => file.path).sort());
  for (const file of expected) assert.equal(strFromU8(archive[file.path]!), file.content);
}

async function runGeneratedProject(
  scenario: GeneratedProjectQualityScenario,
  release: number,
  files: readonly VersionFile[],
  context: { after(callback: () => void | Promise<void>): void },
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), `viby-quality-${scenario.id}-`));
  context.after(() => rm(directory, { recursive: true, force: true }));
  for (const file of files) {
    const destination = join(directory, ...file.path.split("/"));
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, file.content);
  }
  const check = await execFileAsync("npm", ["run", "check"], { cwd: directory });
  assert.match(check.stdout, /quality-contract:pass/);
  await execFileAsync("npm", ["run", "build"], { cwd: directory });
  const preview = spawn(process.execPath, ["scripts/preview.mjs"], {
    cwd: directory,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  preview.stderr.setEncoding("utf8");
  preview.stderr.on("data", (chunk) => { stderr += chunk; });
  try {
    const port = await previewPort(preview);
    const response = await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(response.status, 200);
    const body = await response.text();
    assert.match(body, new RegExp(scenario.title));
    assert.match(body, new RegExp(`data-release="${release}"`));
  } finally {
    preview.kill("SIGTERM");
    await Promise.race([
      once(preview, "exit"),
      new Promise((resolve) => setTimeout(resolve, 2_000)),
    ]);
  }
  assert.equal(stderr, "");
}

async function previewPort(process: ReturnType<typeof spawn>): Promise<number> {
  process.stdout!.setEncoding("utf8");
  return new Promise<number>((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => reject(new Error("Generated preview did not become ready.")), 5_000);
    process.stdout!.on("data", (chunk) => {
      stdout += chunk;
      const match = stdout.match(/VIBY_PREVIEW_PORT=(\d+)/);
      if (!match) return;
      clearTimeout(timeout);
      resolve(Number(match[1]));
    });
    process.once("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`Generated preview exited before readiness with code ${code}.`));
    });
    process.once("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function file(path: string, content: string, mediaType?: string): VersionFile {
  return {
    path,
    content,
    mediaType: mediaType ?? (path.endsWith(".json") ? "application/json" : "text/plain"),
    size: Buffer.byteLength(content),
    checksum: sha256(content),
    locked: false,
  };
}
