import type {
  BrowserAccessibilityImpact,
  BrowserAccessibilityOptions,
  BrowserAccessibilityReport,
  BrowserAdapter,
  BrowserConsoleError,
  BrowserDomInspectionOptions,
  BrowserDomSnapshot,
  BrowserReadinessOptions,
  BrowserScreenshot,
  BrowserScreenshotOptions,
  BrowserViewport,
} from "./browser.js";
import { openBrowserSession } from "./browser.js";
import { ConfigurationError } from "./errors.js";
import type { Repository } from "./repository.js";
import type { SandboxReadinessOptions, SandboxSession } from "./sandbox.js";
import type {
  ChatMetadata,
  DesignEvaluationData,
  DesignEvaluationStatus,
  FrameworkId,
  RecordDesignEvaluationInput,
  UserScope,
  VersionData,
  VisualArtifactData,
} from "./types.js";
import { assertIdentifier, createId, sha256, slugify } from "./utils.js";

const MAX_VISUAL_PAGES = 20;
const MAX_VISUAL_ARTIFACT_BYTES = 25_000_000;

export type VisualPreviewSource =
  | {
      readonly type: "url";
      readonly url: string;
    }
  | {
      readonly type: "sandbox";
      readonly sandbox: SandboxSession;
      readonly port: number;
      readonly path?: string;
      readonly readiness?: SandboxReadinessOptions;
    };

export interface VisualEvaluationPage {
  readonly id: string;
  readonly path?: string;
  readonly readiness?: Omit<BrowserReadinessOptions, "url" | "signal">;
  readonly screenshot?: Omit<BrowserScreenshotOptions, "signal">;
  readonly dom?: Omit<BrowserDomInspectionOptions, "signal">;
  readonly accessibility?: Omit<BrowserAccessibilityOptions, "signal">;
}

export interface VisualEvaluationCapture {
  readonly pageId: string;
  readonly path: string;
  readonly artifact: VisualArtifactData;
  readonly screenshot: BrowserScreenshot;
  readonly dom: BrowserDomSnapshot;
  readonly consoleErrors: readonly BrowserConsoleError[];
  readonly accessibility: BrowserAccessibilityReport;
}

export interface VisualQualityGateContext<Framework extends FrameworkId = FrameworkId> {
  readonly version: VersionData<Framework>;
  readonly captures: readonly VisualEvaluationCapture[];
  readonly signal?: AbortSignal;
}

export interface VisualQualityGateResult {
  readonly status: DesignEvaluationStatus;
  readonly score: number;
  readonly summary: string;
  /** Omit to link all captures to this criterion. */
  readonly captureIds?: readonly string[];
}

/** A quality gate may use rules, a vision model, an agent, or any external evaluator. */
export interface VisualQualityGate<Framework extends FrameworkId = FrameworkId> {
  readonly id: string;
  readonly label: string;
  evaluate(
    context: VisualQualityGateContext<Framework>,
  ): VisualQualityGateResult | Promise<VisualQualityGateResult>;
}

export interface VisualEvaluationInput<Framework extends FrameworkId = FrameworkId> {
  readonly evaluator: string;
  readonly preview: VisualPreviewSource;
  readonly pages?: readonly VisualEvaluationPage[];
  readonly gates: readonly VisualQualityGate<Framework>[];
  readonly viewport?: BrowserViewport;
  readonly allowExternalNavigation?: boolean;
  readonly metadata?: ChatMetadata;
  readonly signal?: AbortSignal;
}

export interface VisualEvaluationResult {
  readonly evaluation: DesignEvaluationData;
  readonly captures: readonly VisualEvaluationCapture[];
  readonly artifacts: readonly VisualArtifactData[];
}

interface VisualEvaluationDependencies<Framework extends FrameworkId> {
  readonly browser: BrowserAdapter;
  readonly repository: Repository;
  readonly scope: UserScope;
  readonly version: VersionData<Framework>;
  readonly record: (input: RecordDesignEvaluationInput) => Promise<DesignEvaluationData>;
}

export async function runVisualEvaluation<Framework extends FrameworkId>(
  input: VisualEvaluationInput<Framework>,
  dependencies: VisualEvaluationDependencies<Framework>,
): Promise<VisualEvaluationResult> {
  const normalized = normalizeWorkflow(input);
  const baseUrl = normalized.preview.type === "sandbox"
    ? await normalized.preview.sandbox.waitForPort(normalized.preview.port, {
        ...(normalized.preview.readiness ?? {}),
        path: normalized.preview.readiness?.path ?? normalized.preview.path ?? "/",
        ...(normalized.signal ? { signal: normalized.signal } : {}),
      })
    : normalized.preview.url;
  const browser = await openBrowserSession(dependencies.browser, {
    baseUrl,
    context: {
      ...dependencies.scope,
      chatId: dependencies.version.chatId,
      versionId: dependencies.version.id,
      ...(normalized.preview.type === "sandbox"
        ? { sandboxId: normalized.preview.sandbox.id }
        : {}),
    },
    ...(normalized.viewport ? { viewport: normalized.viewport } : {}),
    ...(normalized.allowExternalNavigation ? { allowExternalNavigation: true } : {}),
    ...(normalized.signal ? { signal: normalized.signal } : {}),
  });
  const captures: VisualEvaluationCapture[] = [];
  try {
    for (const page of normalized.pages) {
      normalized.signal?.throwIfAborted();
      const errorOffset = (await browser.consoleErrors(
        normalized.signal ? { signal: normalized.signal } : {},
      )).length;
      const navigation = await browser.navigate({
        url: page.path,
        ...(page.readiness?.waitUntil ? { waitUntil: page.readiness.waitUntil } : {}),
        ...(page.readiness?.timeoutMs === undefined ? {} : { timeoutMs: page.readiness.timeoutMs }),
        ...(normalized.signal ? { signal: normalized.signal } : {}),
      });
      if (page.readiness) {
        await browser.waitForReady({
          ...page.readiness,
          url: navigation.url,
          ...(normalized.signal ? { signal: normalized.signal } : {}),
        });
      }
      const screenshot = await browser.screenshot({
        ...page.screenshot,
        ...(normalized.signal ? { signal: normalized.signal } : {}),
      });
      const [dom, allErrors, accessibility] = await Promise.all([
        browser.inspect({ ...page.dom, ...(normalized.signal ? { signal: normalized.signal } : {}) }),
        browser.consoleErrors(normalized.signal ? { signal: normalized.signal } : {}),
        browser.accessibility({
          ...page.accessibility,
          ...(normalized.signal ? { signal: normalized.signal } : {}),
        }),
      ]);
      const id = createId();
      if (screenshot.bytes.byteLength > MAX_VISUAL_ARTIFACT_BYTES) {
        throw new ConfigurationError(
          `Visual evaluation screenshots cannot exceed ${MAX_VISUAL_ARTIFACT_BYTES} bytes.`,
        );
      }
      if (screenshot.width > 100_000 || screenshot.height > 100_000) {
        throw new ConfigurationError("Visual evaluation screenshot dimensions cannot exceed 100000 pixels.");
      }
      const checksum = sha256(screenshot.bytes);
      const extension = screenshot.mediaType === "image/jpeg" ? "jpg" : "png";
      const artifact = await dependencies.repository.createVisualArtifact(dependencies.scope, {
        id,
        chatId: dependencies.version.chatId,
        versionId: dependencies.version.id,
        pageId: page.id,
        path: page.path,
        url: screenshot.url,
        filename: `${slugify(page.id)}.${extension}`,
        mediaType: screenshot.mediaType,
        width: screenshot.width,
        height: screenshot.height,
        bytes: screenshot.bytes,
        size: screenshot.bytes.byteLength,
        checksum,
      });
      captures.push({
        pageId: page.id,
        path: page.path,
        artifact,
        screenshot,
        dom,
        consoleErrors: allErrors.slice(errorOffset),
        accessibility,
      });
    }
  } finally {
    // Cleanup must still run after cancellation; do not forward an already-aborted signal.
    await browser.close().catch(() => undefined);
  }

  const gateResults = await Promise.all(normalized.gates.map(async (gate) => ({
    gate,
    result: normalizeGateResult(await gate.evaluate({
      version: dependencies.version,
      captures,
      ...(normalized.signal ? { signal: normalized.signal } : {}),
    }), gate.id, new Set(captures.map((capture) => capture.pageId))),
  })));
  const criteria = gateResults.map(({ gate, result }) => ({
    id: gate.id,
    label: gate.label,
    status: result.status,
    score: result.score,
    summary: result.summary,
    evidence: captures
      .filter((capture) => !result.captureIds || result.captureIds.includes(capture.pageId))
      .map((capture) => ({
        type: "artifact" as const,
        artifactId: capture.artifact.id,
        description: `${capture.pageId} screenshot`,
      })),
  }));
  const status = aggregateStatus(criteria.map((criterion) => criterion.status));
  const score = criteria.reduce((sum, criterion) => sum + criterion.score, 0) / criteria.length;
  const failed = criteria.filter((criterion) => criterion.status === "failed");
  const warning = criteria.filter((criterion) => criterion.status === "warning");
  const summary = failed.length > 0
    ? `${failed.length} of ${criteria.length} visual quality gates failed.`
    : warning.length > 0
      ? `${warning.length} of ${criteria.length} visual quality gates need attention.`
      : `All ${criteria.length} visual quality gates passed.`;
  const evaluation = await dependencies.record({
    evaluator: normalized.evaluator,
    status,
    score,
    summary,
    criteria,
    evidence: captures.map((capture) => ({
      type: "artifact",
      artifactId: capture.artifact.id,
      description: `${capture.pageId} screenshot at ${capture.artifact.url}`,
    })),
    metadata: normalized.metadata,
  });
  return { evaluation, captures, artifacts: captures.map((capture) => capture.artifact) };
}

export interface ConsoleErrorGateOptions {
  readonly id?: string;
  readonly label?: string;
  readonly maxErrors?: number;
  readonly status?: Exclude<DesignEvaluationStatus, "passed">;
}

export function consoleErrorGate<Framework extends FrameworkId = FrameworkId>(
  options: ConsoleErrorGateOptions = {},
): VisualQualityGate<Framework> {
  const maxErrors = nonNegativeInteger(options.maxErrors ?? 0, "Console error gate maxErrors");
  return {
    id: normalizeGateId(options.id ?? "console-errors"),
    label: normalizeText(options.label ?? "Console errors", "Console error gate label", 200),
    evaluate({ captures }) {
      const count = captures.reduce((sum, capture) => sum + capture.consoleErrors.length, 0);
      const passed = count <= maxErrors;
      return {
        status: passed ? "passed" : options.status ?? "failed",
        score: passed ? 100 : Math.max(0, 100 - (count - maxErrors) * 20),
        summary: passed
          ? `Observed ${count} console error${count === 1 ? "" : "s"}; limit is ${maxErrors}.`
          : `Observed ${count} console errors; limit is ${maxErrors}.`,
        captureIds: captures.filter((capture) => capture.consoleErrors.length > 0)
          .map((capture) => capture.pageId),
      };
    },
  };
}

export interface AccessibilityGateOptions {
  readonly id?: string;
  readonly label?: string;
  readonly maxIssues?: number;
  readonly impacts?: readonly BrowserAccessibilityImpact[];
  readonly status?: Exclude<DesignEvaluationStatus, "passed">;
}

export function accessibilityGate<Framework extends FrameworkId = FrameworkId>(
  options: AccessibilityGateOptions = {},
): VisualQualityGate<Framework> {
  const maxIssues = nonNegativeInteger(options.maxIssues ?? 0, "Accessibility gate maxIssues");
  const impacts = new Set(options.impacts ?? ["serious", "critical"]);
  return {
    id: normalizeGateId(options.id ?? "accessibility"),
    label: normalizeText(options.label ?? "Accessibility", "Accessibility gate label", 200),
    evaluate({ captures }) {
      const affected = captures.map((capture) => ({
        id: capture.pageId,
        count: capture.accessibility.issues.filter((issue) => impacts.has(issue.impact)).length,
      }));
      const count = affected.reduce((sum, page) => sum + page.count, 0);
      const passed = count <= maxIssues;
      return {
        status: passed ? "passed" : options.status ?? "failed",
        score: passed ? 100 : Math.max(0, 100 - (count - maxIssues) * 10),
        summary: passed
          ? `Found ${count} matching accessibility issue${count === 1 ? "" : "s"}; limit is ${maxIssues}.`
          : `Found ${count} matching accessibility issues; limit is ${maxIssues}.`,
        captureIds: affected.filter((page) => page.count > 0).map((page) => page.id),
      };
    },
  };
}

function normalizeWorkflow<Framework extends FrameworkId>(input: VisualEvaluationInput<Framework>) {
  if (!input || typeof input !== "object") throw new ConfigurationError("Visual evaluation input is required.");
  if (!Array.isArray(input.gates) || input.gates.length < 1 || input.gates.length > 50) {
    throw new ConfigurationError("Visual evaluation requires 1-50 quality gates.");
  }
  const gates = input.gates.map((gate) => {
    if (!gate || typeof gate.evaluate !== "function") {
      throw new ConfigurationError("Each visual quality gate must implement evaluate(context).");
    }
    return {
      ...gate,
      id: normalizeGateId(gate.id),
      label: normalizeText(gate.label, "Visual quality gate label", 200),
    };
  });
  if (new Set(gates.map((gate) => gate.id)).size !== gates.length) {
    throw new ConfigurationError("Visual quality gate ids cannot contain duplicates.");
  }
  if (input.pages !== undefined && !Array.isArray(input.pages)) {
    throw new ConfigurationError("Visual evaluation pages must be an array.");
  }
  const defaultPath = input.preview?.type === "sandbox" ? input.preview.path ?? "/" : "/";
  const pages = (input.pages ?? [{ id: "default", path: defaultPath }]).map(normalizePage);
  if (pages.length < 1 || pages.length > MAX_VISUAL_PAGES) {
    throw new ConfigurationError(`Visual evaluation requires 1-${MAX_VISUAL_PAGES} pages.`);
  }
  if (new Set(pages.map((page) => page.id)).size !== pages.length) {
    throw new ConfigurationError("Visual evaluation page ids cannot contain duplicates.");
  }
  if (!input.preview || (input.preview.type !== "url" && input.preview.type !== "sandbox")) {
    throw new ConfigurationError("Visual evaluation preview must be a URL or sandbox source.");
  }
  return {
    ...input,
    evaluator: normalizeText(input.evaluator, "Visual evaluator", 200),
    pages,
    gates,
    metadata: input.metadata ?? {},
  };
}

function normalizePage(page: VisualEvaluationPage): Required<Pick<VisualEvaluationPage, "id" | "path">> & VisualEvaluationPage {
  if (!page || typeof page !== "object") throw new ConfigurationError("Visual evaluation page must be an object.");
  const id = normalizeGateId(page.id);
  const path = page.path?.trim() || "/";
  if (path.length > 2_048) throw new ConfigurationError("Visual evaluation page path is too long.");
  return { ...page, id, path };
}

function normalizeGateResult(
  result: VisualQualityGateResult,
  gateId: string,
  pageIds: ReadonlySet<string>,
): VisualQualityGateResult {
  if (!result || typeof result !== "object") {
    throw new ConfigurationError(`Visual quality gate ${gateId} returned an invalid result.`);
  }
  if (result.status !== "passed" && result.status !== "warning" && result.status !== "failed") {
    throw new ConfigurationError(`Visual quality gate ${gateId} returned an invalid status.`);
  }
  if (!Number.isFinite(result.score) || result.score < 0 || result.score > 100) {
    throw new ConfigurationError(`Visual quality gate ${gateId} score must be between 0 and 100.`);
  }
  const captureIds = result.captureIds?.map((id) => normalizeGateId(id));
  for (const id of captureIds ?? []) {
    if (!pageIds.has(id)) throw new ConfigurationError(`Visual quality gate ${gateId} referenced unknown capture ${id}.`);
  }
  return {
    status: result.status,
    score: result.score,
    summary: normalizeText(result.summary, `Visual quality gate ${gateId} summary`, 2_000),
    ...(captureIds ? { captureIds } : {}),
  };
}

function aggregateStatus(statuses: readonly DesignEvaluationStatus[]): DesignEvaluationStatus {
  if (statuses.includes("failed")) return "failed";
  if (statuses.includes("warning")) return "warning";
  return "passed";
}

function normalizeGateId(value: string): string {
  const id = assertIdentifier(value, "Visual quality gate id");
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(id)) {
    throw new ConfigurationError(`Visual quality gate id is invalid: ${id}`);
  }
  return id;
}

function normalizeText(value: string, label: string, max: number): string {
  if (typeof value !== "string") throw new ConfigurationError(`${label} must be a string.`);
  const normalized = value.trim();
  if (!normalized || normalized.length > max) {
    throw new ConfigurationError(`${label} must contain 1-${max} characters.`);
  }
  return normalized;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isInteger(value) || value < 0 || value > 10_000) {
    throw new ConfigurationError(`${label} must be an integer between 0 and 10000.`);
  }
  return value;
}
