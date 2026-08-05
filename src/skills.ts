import { readFile, readdir, stat } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import type {
  LocalSkillReference,
  ResolvedSkill,
  SkillFile,
  SkillGroups,
  SkillReference,
  SkillsShSkillId,
} from "./types.js";
import { SkillResolutionError } from "./errors.js";
import { sha256 } from "./utils.js";

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
  readonly #cache = new Map<string, Promise<Omit<ResolvedSkill, "category">>>();

  constructor(groups: SkillGroups = {}, rootDirectory = process.cwd()) {
    this.#groups = groups;
    this.#rootDirectory = rootDirectory;
  }

  async resolveForPrompt(prompt: string): Promise<ResolvedSkill[]> {
    const categories = selectCategories(prompt, Object.keys(this.#groups));
    const selected: Array<{ category: string; reference: SkillReference }> = [];

    for (const category of categories) {
      for (const reference of this.#groups[category] ?? []) {
        selected.push({ category, reference });
      }
    }

    const resolved = await Promise.all(
      selected.map(async ({ category, reference }) => ({
        ...(await this.#resolve(reference)),
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

  #resolve(reference: SkillReference): Promise<Omit<ResolvedSkill, "category">> {
    const key = typeof reference === "string" ? `remote:${reference}` : `file:${reference.path}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const pending = typeof reference === "string"
      ? resolveRemoteSkill(reference)
      : resolveLocalSkill(reference, this.#rootDirectory);
    this.#cache.set(key, pending);
    return pending;
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
