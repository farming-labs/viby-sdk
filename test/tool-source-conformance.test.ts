import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ToolSourceAdapterConformanceError,
  verifyToolSourceAdapter,
} from "../src/tool-source-conformance.js";
import { defineToolSourceAdapter } from "../src/tool-source-registry.js";
import type { ToolSourceCredentialContext } from "../src/tool-source-authorization.js";

const now = new Date("2026-08-13T00:00:00.000Z");
const registration = {
  id: "catalog-source",
  type: "catalog",
  name: "Catalog",
  description: "Disposable conformance catalog",
  configuration: { endpoint: "https://tools.example.test" },
  status: "active" as const,
  createdAt: now,
  updatedAt: now,
};
const context = {
  tenantId: "tenant",
  userId: "user",
  chatId: "chat",
  generationId: "generation",
  attemptId: "attempt",
  framework: "farm" as const,
  metadata: {},
};
const call = {
  name: "lookup",
  arguments: { id: "42" },
  idempotencyKey: "lookup-42",
};

test("runs a reusable tool-source adapter conformance contract", async () => {
  let closeCalls = 0;
  const adapter = defineToolSourceAdapter<"farm">({
    type: "catalog",
    open: ({ source }) => ({
      id: source.id,
      list: async () => [{
        name: "lookup",
        description: "Look up one catalog item.",
        inputSchema: { type: "object" },
        effect: "read",
      }],
      call: async ({ arguments: arguments_ }) => ({ item: arguments_.id ?? null }),
      close: async () => { closeCalls += 1; },
    }),
  });

  const report = await verifyToolSourceAdapter({
    adapter,
    source: registration,
    context,
    call,
    validateTools(tools) {
      assert.equal(tools[0]?.effect, "read");
    },
    validateResult(result) {
      assert.deepEqual(result, { item: "42" });
    },
  });

  assert.deepEqual(report, {
    type: "catalog",
    sourceId: "catalog-source",
    toolNames: ["lookup"],
    credentialRequests: 0,
    checks: ["identity", "open", "list", "call", "close"],
  });
  assert.equal(closeCalls, 1);
});

test("keeps resolved credentials out of tools, results, and reports", async () => {
  const secret = "conformance-secret-value";
  const credential: ToolSourceCredentialContext = {
    tenantId: context.tenantId,
    userId: context.userId,
    connectionId: "connection",
    account: { id: "account", name: "Fixture account" },
    credential: new TextEncoder().encode(secret),
    scopes: ["catalog.read"],
  };
  let token = "";
  const adapter = defineToolSourceAdapter<"farm">({
    type: "catalog",
    open: ({ source, credential: resolveCredential }) => ({
      id: source.id,
      async list(context_) {
        token = new TextDecoder().decode((await resolveCredential!(context_.signal)).credential);
        return [{
          name: "lookup",
          description: "Look up one catalog item.",
          inputSchema: { type: "object" },
          effect: "read",
        }];
      },
      async call({ arguments: arguments_ }) {
        assert.equal(token, secret);
        return { item: arguments_.id ?? null };
      },
    }),
  });

  const report = await verifyToolSourceAdapter({
    adapter,
    source: registration,
    context,
    call,
    credential: async () => credential,
  });

  assert.equal(report.credentialRequests, 1);
  assert.ok(report.checks.includes("credential-boundary"));
  assert.equal(JSON.stringify(report).includes(secret), false);
});

test("rejects adapter identity mismatches before opening", async () => {
  const adapter = defineToolSourceAdapter<"farm">({
    type: "other",
    open: () => { throw new Error("must not open"); },
  });
  await assert.rejects(
    () => verifyToolSourceAdapter({ adapter, source: registration, context, call }),
    (error: unknown) => error instanceof ToolSourceAdapterConformanceError
      && error.check === "identity",
  );
});

test("rejects credential exposure and still closes the source", async () => {
  const secret = "must-not-reach-the-model";
  let closeCalls = 0;
  const adapter = defineToolSourceAdapter<"farm">({
    type: "catalog",
    open: ({ source, credential }) => ({
      id: source.id,
      async list() {
        const resolved = await credential!();
        return [{
          name: "lookup",
          description: new TextDecoder().decode(resolved.credential),
          inputSchema: { type: "object" },
          effect: "read",
        }];
      },
      call: async () => null,
      close: async () => { closeCalls += 1; },
    }),
  });
  await assert.rejects(
    () => verifyToolSourceAdapter({
      adapter,
      source: registration,
      context,
      call,
      credential: async () => ({
        tenantId: context.tenantId,
        userId: context.userId,
        connectionId: "connection",
        account: { id: "account", name: "Fixture account" },
        credential: new TextEncoder().encode(secret),
        scopes: [],
      }),
    }),
    (error: unknown) => error instanceof ToolSourceAdapterConformanceError
      && error.check === "list",
  );
  assert.equal(closeCalls, 1);
});

test("requires the harmless call probe to reference a listed tool", async () => {
  const adapter = defineToolSourceAdapter<"farm">({
    type: "catalog",
    open: ({ source }) => ({
      id: source.id,
      list: async () => [{
        name: "different",
        description: "A different harmless tool.",
        inputSchema: { type: "object" },
        effect: "read",
      }],
      call: async () => null,
    }),
  });
  await assert.rejects(
    () => verifyToolSourceAdapter({ adapter, source: registration, context, call }),
    (error: unknown) => error instanceof ToolSourceAdapterConformanceError
      && error.check === "call",
  );
});
