import test from "node:test";
import assert from "node:assert/strict";
import { materializeCatalog } from "../src/sync.js";
const config = { models: { providers: { unrelated: { baseUrl: "https://other.example", models: [] }, cliproxyapi: { baseUrl: "http://localhost/v1", models: [] } } } };
const snapshot = { models: [{ id: "a", compat: {}, params: {} }], baseUrl: "http://localhost/v1", revision: "r1" };
test("an older catalog API is rejected instead of published through a compatibility view", async () => {
  await assert.rejects(materializeCatalog(config, snapshot, { loadModelCatalog: async () => [] }), /2026\.9\.8/);
});
test("new prepared API refreshes the actual config owner, not a synthetic generation", async () => {
  let received;
  const result = await materializeCatalog(config, snapshot, { loadPreparedModelCatalog: async (args) => { received = args; return [{ provider: "cliproxyapi", id: "a" }]; } });
  assert.equal(result.mode, "prepared"); assert.equal(received.config, config); assert.equal(received.refreshFullCatalog, true);
});
test("failed/partial publication is not reported as successful; stale snapshots are not published", async () => {
  await assert.rejects(materializeCatalog(config, snapshot, { loadPreparedModelCatalog: async () => [] }), /did not publish/);
  assert.equal((await materializeCatalog(config, { ...snapshot, stale: true }, {})).synced, false);
});
