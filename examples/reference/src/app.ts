import {
  ConfigurationError,
  createVibyApi,
  type FrameworkId,
  type SandboxCommand,
  type SandboxProcess,
  type SandboxReadinessOptions,
  type SandboxSession,
  type UserScope,
  type Version,
  type Viby,
} from "@viby/sdk";

export interface ReferenceAsset {
  readonly body: string;
  readonly contentType: string;
}

export interface ReferencePreviewRecipe {
  readonly port: number;
  readonly install?: SandboxCommand;
  readonly start: SandboxCommand;
  readonly readyPath?: string;
  readonly timeoutMs?: number;
  readonly readinessCheck?: SandboxReadinessOptions["check"];
}

export interface ReferenceAppOptions<Framework extends FrameworkId> {
  readonly viby: Viby<Framework>;
  readonly scope: UserScope;
  readonly assets?: Readonly<Record<string, ReferenceAsset>>;
  readonly preview?: ReferencePreviewRecipe;
}

export interface ReferenceApp {
  fetch(request: Request): Promise<Response>;
}

interface ActivePreview {
  readonly session: SandboxSession;
  readonly process: SandboxProcess;
  readonly url: string;
}

/** Complete framework-neutral product example powered by the standard Viby API host. */
export function createReferenceApp<Framework extends FrameworkId>(
  options: ReferenceAppOptions<Framework>,
): ReferenceApp {
  const previews = new Map<string, ActivePreview>();
  const preview = options.preview;
  const api = createVibyApi({
    viby: options.viby,
    basePath: "/api",
    // The example has one fixed user. Real products derive this from their auth session.
    authenticate: async () => options.scope,
    ...(preview ? {
      preview: async ({ version }) => {
        const existing = previews.get(version.id);
        if (existing) {
          return {
            url: existing.url,
            provider: existing.session.provider,
            leaseId: existing.session.leaseId ?? null,
            cached: true,
          };
        }
        const active = await startPreview(version, preview);
        previews.set(version.id, active);
        return {
          url: active.url,
          provider: active.session.provider,
          leaseId: active.session.leaseId ?? null,
          cached: false,
        };
      },
    } : {}),
  });
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && !url.pathname.startsWith("/api/")) {
        const asset = options.assets?.[url.pathname === "/" ? "/index.html" : url.pathname];
        if (asset) {
          return new Response(asset.body, {
            headers: { "Content-Type": asset.contentType, "Cache-Control": "no-cache" },
          });
        }
      }
      return api.fetch(request);
    },
  };
}

async function startPreview<Framework extends FrameworkId>(
  version: Version<Framework>,
  recipe: ReferencePreviewRecipe,
): Promise<ActivePreview> {
  const session = await version.sandbox({ ports: [recipe.port] });
  try {
    if (!session.capabilities.commands || !session.capabilities.backgroundProcesses
      || !session.capabilities.portUrls) {
      throw new ConfigurationError(
        `Sandbox provider ${session.provider} needs commands, backgroundProcesses, and portUrls for previews.`,
      );
    }
    if (recipe.install) {
      const installation = await session.run(recipe.install);
      if (installation.exitCode !== 0) {
        throw new Error(`Dependency installation failed: ${installation.stderr || installation.stdout}`);
      }
    }
    const process = await session.start(recipe.start);
    const url = await session.waitForPort(recipe.port, {
      path: recipe.readyPath ?? "/",
      timeoutMs: recipe.timeoutMs ?? 120_000,
      ...(recipe.readinessCheck ? { check: recipe.readinessCheck } : {}),
    });
    return { session, process, url };
  } catch (error) {
    await session.stop().catch(() => undefined);
    throw error;
  }
}
