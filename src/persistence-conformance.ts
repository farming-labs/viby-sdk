import type { LanguageModelUsage } from "ai";
import { createVibyWithDependencies } from "./client.js";
import { ConfigurationError, NotFoundError } from "./errors.js";
import type { GeneratorOutput } from "./generator.js";
import type { PersistenceAdapter } from "./persistence.js";
import { SkillResolver } from "./skills.js";
import { sha256 } from "./utils.js";

export interface PersistenceConformanceInput {
  /** Creates an isolated, migrated adapter that the suite may close. */
  readonly create: () => PersistenceAdapter | Promise<PersistenceAdapter>;
}

export interface PersistenceConformanceReport {
  readonly checks: readonly (
    | "readiness"
    | "chat-metadata"
    | "durable-generation"
    | "event-cursors"
    | "source-history"
    | "generated-artifacts"
    | "visual-artifacts"
    | "design-evaluations"
    | "tenant-isolation"
    | "retention-purge"
    | "close"
  )[];
}

export class PersistenceConformanceError extends Error {
  override readonly name = "PersistenceConformanceError";
}

const usage: LanguageModelUsage = {
  inputTokens: 2,
  inputTokenDetails: { noCacheTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
  outputTokens: 3,
  outputTokenDetails: { textTokens: 3, reasoningTokens: 0 },
  totalTokens: 5,
};

/** Exercises portable durability, isolation, history, cursor, and artifact behavior. */
export async function verifyPersistenceAdapter(
  input: PersistenceConformanceInput,
): Promise<PersistenceConformanceReport> {
  if (!input || typeof input.create !== "function") {
    throw new ConfigurationError("Persistence conformance requires a create function.");
  }
  const persistence = await input.create();
  if (!persistence || typeof persistence !== "object") {
    throw new ConfigurationError("Persistence conformance create() returned no adapter.");
  }
  const checks: PersistenceConformanceReport["checks"][number][] = [];
  let closed = false;
  try {
    await persistence.assertReady();
    checks.push("readiness");

    const source = "export const conformance = true;\n";
    const output: GeneratorOutput = {
      kind: "project",
      title: "Persistence conformance",
      summary: "Portable durable lifecycle fixture.",
      files: [{
        path: "src/index.ts",
        content: source,
        mediaType: "text/javascript",
        size: Buffer.byteLength(source),
        checksum: sha256(source),
        locked: false,
      }],
      artifacts: [{
        filename: "conformance.png",
        mediaType: "image/png",
        bytes: new Uint8Array([137, 80, 78, 71]),
      }],
      usage,
      finishReason: "stop",
    };
    const viby = createVibyWithDependencies({
      framework: "persistence-conformance",
      engine: {
        identity: { provider: "conformance", model: "fixture-v1" },
        async generate(_generationInput, options) {
          options?.signal?.throwIfAborted();
          return output;
        },
      },
      retention: { deletedChatsMs: 0 },
    }, {
      repository: persistence,
      skillResolver: new SkillResolver({}),
    });
    const suffix = crypto.randomUUID();
    const scope = { tenantId: `conformance-${suffix}`, userId: `owner-${suffix}` };
    const owner = viby.forUser(scope);
    const chat = await owner.chats.create({
      title: "Conformance fixture",
      metadata: { conformance: { run: suffix } },
    });
    const updated = await chat.update({ metadata: { conformance: { run: suffix, ready: true } } });
    assertConformance(updated.metadata.conformance !== undefined, "Chat metadata was not durable.");
    checks.push("chat-metadata");

    const generation = await chat.start({ prompt: "Persist a complete project" });
    const outcome = await generation.wait({ pollIntervalMs: 10 });
    assertConformance(outcome.status === "succeeded", "Generation did not persist successfully.");
    if (outcome.status !== "succeeded") throw new PersistenceConformanceError("Missing version.");
    assertConformance((await generation.attempts()).length === 1, "Attempt history was not durable.");
    assertConformance((await chat.listMessages()).items.length === 2, "Messages were not durable.");
    assertConformance((await outcome.version.files())[0]?.content === source, "Version files changed.");
    checks.push("durable-generation");

    const firstEvents = await generation.events({ limit: 2 });
    assertConformance(firstEvents.events.length === 2 && firstEvents.nextCursor !== null, "Event page is incomplete.");
    const nextEvents = await generation.events({ after: firstEvents.nextCursor!, limit: 100 });
    assertConformance(nextEvents.events.length > 0, "Event cursor did not resume.");
    checks.push("event-cursors");

    const child = await outcome.version.apply({
      title: "Persistence conformance edit",
      summary: "Created an immutable child.",
      changes: [{ type: "write", path: "src/index.ts", content: "export const conformance = 2;\n" }],
    });
    assertConformance(child.parentVersionId === outcome.version.id, "Version lineage was not retained.");
    assertConformance((await chat.listVersions()).items.length === 2, "Version history was not durable.");
    checks.push("source-history");

    const [artifact] = await generation.artifacts();
    assertConformance(artifact?.versionId === outcome.version.id, "Artifact ownership is incomplete.");
    assertConformance(
      (await generation.getArtifact(artifact!.id)).checksum === artifact!.checksum,
      "Artifact content did not roundtrip.",
    );
    checks.push("generated-artifacts");

    const screenshot = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const visualArtifactId = crypto.randomUUID();
    await persistence.createVisualArtifact(scope, {
      id: visualArtifactId,
      chatId: outcome.version.chatId,
      versionId: outcome.version.id,
      pageId: "home",
      path: "/",
      url: "https://preview.example.test/",
      filename: "home.png",
      mediaType: "image/png",
      width: 1280,
      height: 720,
      bytes: screenshot,
      size: screenshot.byteLength,
      checksum: sha256(screenshot),
    });
    assertConformance(
      (await persistence.getVisualArtifact(scope, outcome.version.id, visualArtifactId))?.checksum
        === sha256(screenshot),
      "Visual artifact content did not roundtrip.",
    );
    assertConformance(
      (await persistence.listVisualArtifacts(scope, outcome.version.id))[0]?.id === visualArtifactId,
      "Visual artifact metadata was not durable.",
    );
    checks.push("visual-artifacts");

    const evaluation = await outcome.version.recordDesignEvaluation({
      evaluator: "persistence-conformance@1",
      status: "passed",
      score: 100,
      summary: "Portable evidence fixture.",
      criteria: [{
        id: "source",
        label: "Source",
        status: "passed",
        score: 100,
        summary: "Source persisted.",
        evidence: [{ type: "version-file", path: "src/index.ts" }],
      }],
      evidence: [{ type: "artifact", artifactId: visualArtifactId }],
    });
    assertConformance(
      (await outcome.version.getDesignEvaluation(evaluation.id)).id === evaluation.id,
      "Design evaluation was not durable.",
    );
    checks.push("design-evaluations");

    const outsider = viby.forUser({ tenantId: scope.tenantId, userId: `other-${suffix}` });
    await outsider.chats.get(chat.id).then(
      () => { throw new PersistenceConformanceError("Adapter exposed another user's chat."); },
      (error) => {
        if (!(error instanceof NotFoundError)) throw error;
      },
    );
    checks.push("tenant-isolation");

    await chat.delete({ retentionMs: 0 });
    assertConformance(await owner.chats.purgeDeleted() === 1, "Retention purge did not remove the chat.");
    checks.push("retention-purge");
    await viby.close();
    closed = true;
    checks.push("close");
  } finally {
    if (!closed) await persistence.close().catch(() => undefined);
  }
  return Object.freeze({ checks: Object.freeze(checks) });
}

function assertConformance(value: unknown, message: string): asserts value {
  if (!value) throw new PersistenceConformanceError(message);
}
