import test from "node:test";
import assert from "node:assert/strict";
import { materializeCatalog } from "../src/sync.js";
const config = { models: { providers: { unrelated: { baseUrl: "https://other.example", models: [] }, cliproxyapi: { baseUrl: "http://localhost/v1", models: [] } } } };
const snapshot = { models: [{ id: "a", compat: {}, params: {} }], baseUrl: "http://localhost/v1", revision: "r1" };
test("legacy publication uses a temporary view and never modifies user config", async () => {
  const before = structuredClone(config);
  let received;
  const result = await materializeCatalog(config, snapshot, { loadModelCatalog: async (args) => { received = args; return [{ provider: "cliproxyapi", id: "a" }]; } });
  assert.equal(result.mode, "legacy"); assert.deepEqual(config, before); assert.equal(received.useCache, false);
  assert.equal(received.config.models.providers.cliproxyapi.models[0].id, "a");
  assert.deepEqual(received.config.models.providers.unrelated, config.models.providers.unrelated);
});
test("new prepared API refreshes the actual config owner, not a synthetic generation", async () => {
  let received;
  const result = await materializeCatalog(config, snapshot, { loadPreparedModelCatalog: async (args) => { received = args; return [{ provider: "cliproxyapi", id: "a" }]; } });
  assert.equal(result.mode, "prepared"); assert.equal(received.config, config); assert.equal(received.refreshFullCatalog, true);
});
test("failed/partial publication is not reported as successful; stale snapshots are not published", async () => {
  await assert.rejects(materializeCatalog(config, snapshot, { loadModelCatalog: async () => [] }), /did not publish/);
  assert.equal((await materializeCatalog(config, { ...snapshot, stale: true }, {})).synced, false);
});
