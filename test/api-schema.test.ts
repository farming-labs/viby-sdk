import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createVibyOpenApiDocument,
  VIBY_API_OPERATIONS,
  vibyJsonSchemas,
} from "../src/api-schema.js";
import { ConfigurationError } from "../src/errors.js";

test("exports a deterministic OpenAPI 3.1 document for every declared Web API operation", () => {
  const document = createVibyOpenApiDocument({
    title: "Product generation API",
    version: "2026-09-01",
    basePath: "/internal/viby",
    serverUrl: "https://app.example.test/",
  });
  assert.equal(document.openapi, "3.1.0");
  assert.deepEqual(document.info, {
    title: "Product generation API",
    version: "2026-09-01",
    description: "Durable, framework-neutral chats, generations, versions, previews, tools, and integrations.",
  });
  assert.deepEqual(document.servers, [{ url: "https://app.example.test" }]);

  const ids = new Set<string>();
  const routes = new Set<string>();
  for (const operation of VIBY_API_OPERATIONS) {
    assert.ok(!ids.has(operation.id), `duplicate operation id ${operation.id}`);
    ids.add(operation.id);
    const route = `${operation.method} ${operation.path}`;
    assert.ok(!routes.has(route), `duplicate operation route ${route}`);
    routes.add(route);
    const item = document.paths[`/internal/viby${operation.path}`] as Record<string, unknown>;
    const exported = item?.[operation.method] as Record<string, unknown>;
    assert.equal(exported.operationId, operation.id);
  }
  assert.ok(VIBY_API_OPERATIONS.length >= 80);
});

test("marks host-authenticated operations and single-use-state callbacks accurately", () => {
  const document = createVibyOpenApiDocument();
  const createChat = (document.paths["/api/viby/chats"] as any).post;
  const callback = (document.paths["/api/viby/integrations/callback"] as any).get;
  const compatibility = (document.paths["/api/viby/versions/{versionId}/iterations"] as any).post;

  assert.deepEqual(createChat.security, [{ hostSession: [] }]);
  assert.deepEqual(callback.security, []);
  assert.equal(compatibility.deprecated, true);
  assert.deepEqual(
    createChat.requestBody.content["application/json"].schema,
    { $ref: "#/components/schemas/CreateChatRequest" },
  );
});

test("exports a frozen JSON Schema 2020-12 bundle with resolvable OpenAPI references", () => {
  assert.equal(vibyJsonSchemas.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.ok(vibyJsonSchemas.$defs.Chat);
  assert.ok(vibyJsonSchemas.$defs.HealthReport);
  assert.equal(Object.isFrozen(vibyJsonSchemas), true);
  assert.equal(Object.isFrozen(vibyJsonSchemas.$defs), true);

  const document = createVibyOpenApiDocument();
  const serialized = JSON.stringify(document);
  for (const match of serialized.matchAll(/#\/components\/schemas\/([A-Za-z0-9]+)/g)) {
    assert.ok(
      (document.components as any).schemas[match[1]!],
      `unresolved OpenAPI schema ${match[1]}`,
    );
  }
  assert.equal(Object.isFrozen(document.paths), true);
});

test("validates OpenAPI document configuration", () => {
  assert.throws(
    () => createVibyOpenApiDocument({ basePath: "api/viby" }),
    ConfigurationError,
  );
  assert.throws(
    () => createVibyOpenApiDocument({ basePath: "/api/viby/" }),
    ConfigurationError,
  );
  assert.throws(
    () => createVibyOpenApiDocument({ serverUrl: "file:///tmp/viby" }),
    ConfigurationError,
  );
});
