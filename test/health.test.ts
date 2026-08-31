import assert from "node:assert/strict";
import { test } from "node:test";
import { createVibyWithDependencies } from "../src/client.js";
import { defineGenerationEngine } from "../src/generation-engine.js";
import { ConfigurationError } from "../src/errors.js";
import { SkillResolver } from "../src/skills.js";
import { MemoryRepository } from "./helpers/memory-repository.js";

const engine = defineGenerationEngine<"farm">({
  identity: { provider: "fixture", model: "health-v1" },
  async generate() {
    throw new Error("Health checks must not call the model.");
  },
});

function createHealthClient(
  repository: MemoryRepository = new MemoryRepository(),
  health?: Parameters<typeof createVibyWithDependencies<"farm">>[0]["health"],
) {
  return createVibyWithDependencies(
    {
      framework: "farm",
      generation: { engine },
      ...(health === undefined ? {} : { health }),
    },
    { repository, skillResolver: new SkillResolver({}) },
  );
}

test("reports persistence and configured capability readiness without external effects", async () => {
  const viby = createHealthClient();
  const report = await viby.health.check();

  assert.equal(report.status, "healthy");
  assert.equal(report.ok, true);
  assert.equal(report.checks.find((check) => check.id === "database")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "generation")?.status, "pass");
  assert.equal(report.checks.find((check) => check.id === "sandbox")?.status, "skipped");
  assert.ok(report.checkedAt instanceof Date);
  await viby.close();
});

test("redacts persistence and custom probe errors", async () => {
  class FailingRepository extends MemoryRepository {
    override async assertReady(): Promise<void> {
      throw new Error("postgresql://operator:very-secret@example.test/viby");
    }
  }
  const viby = createHealthClient(new FailingRepository(), {
    checks: [{
      id: "queue",
      label: "Generation queue",
      async check() {
        throw new Error("queue-token-that-must-not-leak");
      },
    }],
  });
  const report = await viby.health.check();
  const serialized = JSON.stringify(report);

  assert.equal(report.status, "unhealthy");
  assert.equal(report.ok, false);
  assert.doesNotMatch(serialized, /very-secret|queue-token/);
  await viby.close();
});

test("supports optional probes, timeouts, and caller cancellation", async () => {
  const viby = createHealthClient(new MemoryRepository(), {
    timeoutMs: 50,
    checks: [{
      id: "optional-gateway",
      label: "Optional gateway",
      critical: false,
      async check() {
        await new Promise(() => undefined);
        return { status: "pass", message: "unreachable" };
      },
    }],
  });
  const report = await viby.health.check();
  assert.equal(report.status, "degraded");
  assert.equal(report.checks.find((check) => check.id === "optional-gateway")?.status, "warning");
  assert.match(
    report.checks.find((check) => check.id === "optional-gateway")?.message ?? "",
    /timed out/,
  );

  const controller = new AbortController();
  controller.abort(new DOMException("caller cancelled", "AbortError"));
  await assert.rejects(() => viby.health.check({ signal: controller.signal }), /caller cancelled/);
  await viby.close();
});

test("validates custom health check configuration", () => {
  assert.throws(
    () => createHealthClient(new MemoryRepository(), {
      timeoutMs: 10,
    }),
    ConfigurationError,
  );
  assert.throws(
    () => createHealthClient(new MemoryRepository(), {
      checks: [{
        id: "database",
        label: "Duplicate",
        check: () => ({ status: "pass", message: "duplicate" }),
      }],
    }),
    /duplicated/,
  );
});
