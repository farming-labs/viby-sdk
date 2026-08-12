import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  InlineSkillReference,
  LocalSkillReference,
  ResolvedSkill,
  SkillFile,
  SkillGroups,
  SkillReference,
  SkillResolverAdapter,
  SkillResolutionOutput,
  SkillsShSkillId,
} from "./types.js";
import { SkillResolutionError } from "./errors.js";
import { defineSkillResolver } from "./skill-resolver.js";
import { sha256 } from "./utils.js";

export { defineSkillResolver, skillFrom, skillInline } from "./skill-resolver.js";

const MAX_SKILL_FILES = 64;
const MAX_SKILL_BYTES = 1_000_000;

const CATEGORY_KEYWORDS: Record<string, readonly string[]> = {
  product: ["product", "requirement", "onboarding", "flow", "journey", "persona"],
  design: ["design", "ui", "interface", "dashboard", "website", "page", "layout", "visual"],
  frontend: ["frontend", "component", "react", "css", "responsive", "client", "form"],
  backend: ["backend", "api", "server", "authentication", "session", "webhook"],
  data: ["database", "schema", "query", "postgres", "migration", "storage"],
  ai: ["ai", "agent", "model", "llm", "prompt", "embedding", "generation"],
  testing: ["test", "testing", "spec", "playwright", "vitest", "coverage"],
  security: ["security", "auth", "permission", "secret", "token", "payment", "upload"],
  accessibility: ["accessibility", "accessible", "a11y", "keyboard", "screen reader"],
  performance: ["performance", "optimize", "bundle", "latency", "cache", "speed"],
  delivery: ["deploy", "deployment", "docker", "cloudflare", "vercel", "netlify", "ci"],
};

interface SkillFrontmatter {
  name: string;
  description: string;
}

interface GitHubTreeItem {
  path?: string;
  type?: string;
}

interface SkillsShResponse {
  id?: string;
  slug?: string;
  hash?: string | null;
  files?: Array<{ path?: string; contents?: string }> | null;
}

export function skillRead(path: string): LocalSkillReference {
  if (path.trim().length === 0) {
    throw new SkillResolutionError(path, "the path cannot be empty");
  }
  return { source: "file", path };
}

export class SkillResolver {
  readonly #groups: SkillGroups;
  readonly #rootDirectory: string;
  readonly #resolvers: readonly SkillResolverAdapter[];
  readonly #cache = new Map<string, Promise<Omit<ResolvedSkill, "category">>>();

  constructor(
    groups: SkillGroups = {},
    rootDirectory = process.cwd(),
    resolvers: readonly SkillResolverAdapter[] = [],
  ) {
    this.#groups = groups;
    this.#rootDirectory = rootDirectory;
    this.#resolvers = resolvers.map(defineSkillResolver);
  }

  async resolveForPrompt(prompt: string, groups: SkillGroups = this.#groups): Promise<ResolvedSkill[]> {
    const categories = selectCategories(prompt, Object.keys(groups));
    const selected: Array<{ category: string; reference: SkillReference }> = [];

    for (const category of categories) {
      for (const reference of groups[category] ?? []) {
        selected.push({ category, reference });
      }
    }

    const resolved = await Promise.all(
      selected.map(async ({ category, reference }) => ({
        ...(await this.#resolve(reference, category, prompt)),
        category,
      })),
    );

    const seen = new Set<string>();
    return resolved.filter((skill) => {
      const key = `${skill.category}:${skill.contentHash}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  #resolve(
    reference: SkillReference,
    category: string,
    prompt: string,
  ): Promise<Omit<ResolvedSkill, "category">> {
    const key = `${category}:${JSON.stringify(reference)}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const pending = this.#resolveUncached(reference, category, prompt);
    this.#cache.set(key, pending);
    return pending;
  }

  async #resolveUncached(
    reference: SkillReference,
    category: string,
    prompt: string,
  ): Promise<Omit<ResolvedSkill, "category">> {
    for (const resolver of this.#resolvers) {
      const output = await resolver.resolve({ reference, category, prompt });
      if (output) return normalizeResolverOutput(resolver.id, reference, output);
    }

    if (typeof reference === "string") return resolveRemoteSkill(reference);
    if (reference.source === "file") return resolveLocalSkill(reference, this.#rootDirectory);
    if (reference.source === "inline") return resolveInlineSkill(reference);
    throw new SkillResolutionError(
      `${reference.resolver}:${reference.locator}`,
      `no configured resolver handled ${reference.resolver}`,
    );
  }
}

export function selectCategories(prompt: string, configured: readonly string[]): string[] {
  const lowerPrompt = prompt.toLowerCase();
  const selected = new Set<string>();

  if (configured.includes("core")) selected.add("core");
  if (configured.includes("frontend")) selected.add("frontend");

  for (const category of configured) {
    if (category === "core" || category === "frontend") continue;
    const keywords = CATEGORY_KEYWORDS[category] ?? [category.toLowerCase()];
    if (keywords.some((keyword) => lowerPrompt.includes(keyword))) {
      selected.add(category);
    }
  }

  return [...selected];
}

function resolveInlineSkill(
  reference: InlineSkillReference,
): Promise<Omit<ResolvedSkill, "category">> {
  const files = normalizeSkillFiles(reference.name, reference.files);
  const name = normalizeSkillText(reference.name, "inline skill name");
  return Promise.resolve({
    name,
    description: reference.description?.trim() ?? "",
    source: "inline",
    locator: name,
    contentHash: hashSkillFiles(files),
    files,
  });
}

function normalizeResolverOutput(
  resolverId: string,
  reference: SkillReference,
  output: SkillResolutionOutput,
): Omit<ResolvedSkill, "category"> {
  if (!output || typeof output !== "object") {
    throw new SkillResolutionError(resolverId, "the resolver returned an invalid result");
  }
  const name = normalizeSkillText(output.name, "resolved skill name");
  const source = normalizeSkillText(output.source ?? resolverId, "resolved skill source");
  const locator = normalizeSkillText(
    output.locator ?? skillReferenceLocator(reference),
    "resolved skill locator",
  );
  const files = normalizeSkillFiles(locator, output.files);
  const contentHash = hashSkillFiles(files);
  if (output.contentHash !== undefined && output.contentHash !== contentHash) {
    throw new SkillResolutionError(locator, "the resolver content hash does not match its files");
  }
  return {
    name,
    description: output.description?.trim() ?? "",
    source,
    locator,
    contentHash,
    files,
  };
}

function normalizeSkillFiles(locator: string, value: readonly SkillFile[]): SkillFile[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new SkillResolutionError(locator, "a resolved skill must contain at least one file");
  }
  if (value.length > MAX_SKILL_FILES) {
    throw new SkillResolutionError(locator, `a skill cannot contain more than ${MAX_SKILL_FILES} files`);
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  return value.map((file) => {
    if (!file || typeof file !== "object" || typeof file.path !== "string" || typeof file.content !== "string") {
      throw new SkillResolutionError(locator, "resolved skill files must contain string paths and content");
    }
    const path = file.path.replaceAll("\\", "/");
    if (
      path.length === 0
      || path.startsWith("/")
      || path.includes("\0")
      || path.split("/").some((segment: string) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new SkillResolutionError(locator, `resolved skill file path is unsafe: ${file.path}`);
    }
    if (seen.has(path)) {
      throw new SkillResolutionError(locator, `resolved skill file path is duplicated: ${path}`);
    }
    seen.add(path);
    totalBytes += Buffer.byteLength(file.content);
    if (totalBytes > MAX_SKILL_BYTES) {
      throw new SkillResolutionError(locator, `a skill cannot exceed ${MAX_SKILL_BYTES} bytes`);
    }
    return { path, content: file.content };
  });
}

function skillReferenceLocator(reference: SkillReference): string {
  if (typeof reference === "string") return reference;
  if (reference.source === "file") return reference.path;
  if (reference.source === "inline") return reference.name;
  return reference.locator;
}

function normalizeSkillText(value: string, label: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (normalized.length === 0 || normalized.length > 500) {
    throw new SkillResolutionError(label, `${label} must contain 1-500 characters`);
  }
  return normalized;
}

async function resolveLocalSkill(
  reference: LocalSkillReference,
  rootDirectory: string,
): Promise<Omit<ResolvedSkill, "category">> {
  const requestedPath = resolve(rootDirectory, reference.path);
  let skillFilePath = requestedPath;

  try {
    if ((await stat(requestedPath)).isDirectory()) {
      skillFilePath = join(requestedPath, "SKILL.md");
    }
  } catch (error) {
    throw new SkillResolutionError(reference.path, "the local path does not exist", { cause: error });
  }

  const skillDirectory = dirname(skillFilePath);
  const files = await readSkillDirectory(skillDirectory);
  const mainFile = files.find((file) => file.path === basename(skillFilePath));
  if (!mainFile) {
    throw new SkillResolutionError(reference.path, "SKILL.md was not found");
  }

  const metadata = parseFrontmatter(mainFile.content, basename(skillDirectory));
  return {
    ...metadata,
    source: "file",
    locator: reference.path,
    contentHash: hashSkillFiles(files),
    files,
  };
}

async function readSkillDirectory(directory: string): Promise<SkillFile[]> {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files: SkillFile[] = [];
  let totalBytes = 0;

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parentPath = "parentPath" in entry && typeof entry.parentPath === "string"
      ? entry.parentPath
      : "path" in entry && typeof entry.path === "string"
        ? entry.path
        : directory;
    const absolutePath = join(parentPath, entry.name);
    const relativePath = relative(directory, absolutePath).split(sep).join("/");
    if (relativePath.startsWith("../") || relativePath.includes("/node_modules/") || relativePath.startsWith(".git/")) {
      continue;
    }
    if (files.length >= MAX_SKILL_FILES) {
      throw new SkillResolutionError(directory, `a skill cannot contain more than ${MAX_SKILL_FILES} files`);
    }
    const content = await readFile(absolutePath, "utf8");
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_SKILL_BYTES) {
      throw new SkillResolutionError(directory, `a skill cannot exceed ${MAX_SKILL_BYTES} bytes`);
    }
    files.push({ path: relativePath, content });
  }

  return files.sort((a, b) => a.path.localeCompare(b.path));
}

async function resolveRemoteSkill(
  id: SkillsShSkillId,
): Promise<Omit<ResolvedSkill, "category">> {
  const oidcToken = process.env.VERCEL_OIDC_TOKEN;
  if (oidcToken) {
    const fromCatalog = await resolveFromSkillsSh(id, oidcToken);
    if (fromCatalog) return fromCatalog;
  }
  return resolveFromGitHub(id);
}

async function resolveFromSkillsSh(
  id: SkillsShSkillId,
  token: string,
): Promise<Omit<ResolvedSkill, "category"> | null> {
  const response = await fetch(`https://skills.sh/api/v1/skills/${id}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!response.ok) return null;

  const data = (await response.json()) as SkillsShResponse;
  const files = (data.files ?? [])
    .filter((file): file is { path: string; contents: string } =>
      typeof file.path === "string" && typeof file.contents === "string")
    .map((file) => ({ path: file.path, content: file.contents }));
  const mainFile = files.find((file) => file.path === "SKILL.md");
  if (!mainFile) return null;
  const metadata = parseFrontmatter(mainFile.content, data.slug ?? id.split("/").at(-1) ?? "skill");

  return {
    ...metadata,
    source: "skills.sh",
    locator: id,
    contentHash: data.hash ?? hashSkillFiles(files),
    files,
  };
}

async function resolveFromGitHub(
  id: SkillsShSkillId,
): Promise<Omit<ResolvedSkill, "category">> {
  const [owner, repository, ...slugParts] = id.split("/");
  const slug = slugParts.join("/");
  if (!owner || !repository || !slug) {
    throw new SkillResolutionError(id, "expected a skills.sh ID in owner/repository/slug form");
  }

  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "User-Agent": "@viby/sdk",
  };
  if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;

  const repositoryResponse = await fetch(`https://api.github.com/repos/${owner}/${repository}`, { headers });
  if (!repositoryResponse.ok) {
    throw new SkillResolutionError(id, `GitHub returned ${repositoryResponse.status}`);
  }
  const repositoryData = (await repositoryResponse.json()) as { default_branch?: string };
  const branch = repositoryData.default_branch ?? "main";

  const treeResponse = await fetch(
    `https://api.github.com/repos/${owner}/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
    { headers },
  );
  if (!treeResponse.ok) {
    throw new SkillResolutionError(id, `GitHub tree lookup returned ${treeResponse.status}`);
  }
  const treeData = (await treeResponse.json()) as { tree?: GitHubTreeItem[] };
  const candidates = (treeData.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path?.endsWith("/SKILL.md"))
    .map((entry) => entry.path as string)
    .filter((path) => path === `${slug}/SKILL.md` || path.endsWith(`/${slug}/SKILL.md`))
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  const skillPath = candidates[0];
  if (!skillPath) {
    throw new SkillResolutionError(id, "SKILL.md was not found in the source repository");
  }

  const skillDirectory = dirname(skillPath).split(sep).join("/");
  const filePaths = (treeData.tree ?? [])
    .filter((entry) => entry.type === "blob" && entry.path?.startsWith(`${skillDirectory}/`))
    .map((entry) => entry.path as string)
    .slice(0, MAX_SKILL_FILES);
  const files: SkillFile[] = [];
  let totalBytes = 0;

  for (const path of filePaths) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${owner}/${repository}/${encodeURIComponent(branch)}/${path.split("/").map(encodeURIComponent).join("/")}`,
      { headers: { "User-Agent": "@viby/sdk" } },
    );
    if (!response.ok) continue;
    const content = await response.text();
    totalBytes += Buffer.byteLength(content);
    if (totalBytes > MAX_SKILL_BYTES) {
      throw new SkillResolutionError(id, `a skill cannot exceed ${MAX_SKILL_BYTES} bytes`);
    }
    files.push({ path: path.slice(skillDirectory.length + 1), content });
  }

  const mainFile = files.find((file) => file.path === "SKILL.md");
  if (!mainFile) {
    throw new SkillResolutionError(id, "SKILL.md could not be downloaded");
  }
  const metadata = parseFrontmatter(mainFile.content, slug.split("/").at(-1) ?? "skill");

  return {
    ...metadata,
    source: "skills.sh",
    locator: id,
    contentHash: hashSkillFiles(files),
    files,
  };
}

function parseFrontmatter(content: string, fallbackName: string): SkillFrontmatter {
  const frontmatter = content.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!frontmatter?.[1]) {
    return { name: fallbackName, description: "" };
  }
  const name = frontmatter[1].match(/^name:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ?? fallbackName;
  const description = frontmatter[1].match(/^description:\s*["']?(.+?)["']?\s*$/m)?.[1]?.trim() ?? "";
  return { name, description };
}

function hashSkillFiles(files: readonly SkillFile[]): string {
  return sha256(files.map((file) => `${file.path}\0${file.content}`).join("\0"));
}
