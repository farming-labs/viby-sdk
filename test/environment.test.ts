import assert from "node:assert/strict";
import { test } from "node:test";
import { EnvironmentManager } from "../src/environment.js";
import { MemoryEnvironmentVariableStore } from "./helpers/memory-environment-store.js";
import { MemorySecretStore } from "./helpers/memory-integration-store.js";

const scope = { tenantId: "tenant", userId: "user" };

test("stores scoped public values and redacted secret references", async () => {
  const store = new MemoryEnvironmentVariableStore();
  const secrets = new MemorySecretStore();
  const environment = new EnvironmentManager(store, secrets);
  const variables = environment.forChat(scope, "chat");

  await variables.set({
    environment: "preview",
    name: "PUBLIC_API_ORIGIN",
    value: "https://api.example",
  });
  await variables.set({
    environment: "preview",
    name: "SERVICE_TOKEN",
    value: "first-secret",
    secret: true,
  });

  assert.deepEqual((await variables.list()).map((variable) => ({
    name: variable.name,
    value: variable.value,
    secret: variable.secret,
  })), [
    { name: "PUBLIC_API_ORIGIN", value: "https://api.example", secret: false },
    { name: "SERVICE_TOKEN", value: null, secret: true },
  ]);
  assert.deepEqual(await environment.resolve(scope, "chat", "preview"), {
    PUBLIC_API_ORIGIN: "https://api.example",
    SERVICE_TOKEN: "first-secret",
  });

  const firstReference = store.variables.find((variable) => variable.name === "SERVICE_TOKEN")?.secretRef;
  await variables.set({
    environment: "preview",
    name: "SERVICE_TOKEN",
    value: "rotated-secret",
    secret: true,
  });
  assert.equal(firstReference ? secrets.secrets.has(firstReference) : true, false);
  assert.equal((await environment.resolve(scope, "chat", "preview")).SERVICE_TOKEN, "rotated-secret");
  assert.equal(await variables.delete({ environment: "preview", name: "SERVICE_TOKEN" }), true);
  assert.equal(secrets.secrets.size, 0);
});

test("isolates environment variables by tenant, chat, and environment", async () => {
  const store = new MemoryEnvironmentVariableStore();
  const environment = new EnvironmentManager(store, new MemorySecretStore());
  await environment.set(scope, "chat-a", {
    environment: "preview",
    name: "VALUE",
    value: "preview-a",
  });
  await environment.set(scope, "chat-a", {
    environment: "production",
    name: "VALUE",
    value: "production-a",
  });
  await environment.set({ tenantId: "other", userId: "user" }, "chat-a", {
    environment: "preview",
    name: "VALUE",
    value: "other-tenant",
  });

  assert.deepEqual(await environment.resolve(scope, "chat-a", "preview"), { VALUE: "preview-a" });
  assert.deepEqual(await environment.resolve(scope, "chat-a", "production"), { VALUE: "production-a" });
  assert.deepEqual(await environment.resolve(scope, "chat-b", "preview"), {});
});
