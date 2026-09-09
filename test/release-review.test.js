import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as turn } from "node:timers/promises";
import { CatalogClient, projectModel } from "../src/catalog.js";
import { createCpaProvider, selectEffort } from "../src/provider.js";
import { createCatalogSynchronizer } from "../src/lifecycle.js";
import { materializeCatalog } from "../src/sync.js";

const config = { models: { providers: { cliproxyapi: { baseUrl: "http://localhost/v1", models: [] } } } };
const args = { baseUrl: "http://localhost/v1", apiKey: "test-key" };
const rows = ({ endpoint }) => endpoint.includes("?")
  ? [{ slug: "shared-id", supported_reasoning_levels: ["low", "high"], context_window: 64000 }]
  : [{ id: "shared-id" }];
const fixture = (overrides = {}) => createCpaProvider({ config, fetchRows: async (p) => rows(p),
  resolveAuth: async () => ({ apiKey: "test-key" }), ...overrides });
function deferred() {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
}

test("cancelling the first waiter must not cancel another caller's shared discovery", async () => {
  const gate = deferred();
  const controller = new AbortController();
  let calls = 0;
  const client = new CatalogClient({ fetchRows: async ({ signal }) => {
    calls++;
    await Promise.race([gate.promise, ...(signal ? [new Promise((_, reject) => {
      if (signal.aborted) reject(signal.reason);
      else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })] : [])]);
    return [];
  } });
  const first = client.get({ ...args, signal: controller.signal });
  const rejected = assert.rejects(first, { name: "AbortError" });
  const second = client.get(args).then((value) => ({ value }), (error) => ({ error }));
  controller.abort();
  gate.resolve();
  await rejected;
  const result = await second;
  assert.equal(result.error, undefined);
  assert.deepEqual(result.value.models, []);
  assert.equal(calls, 2, "one plain request and one rich request");
  assert.equal((await client.get(args)).stale, false, "caller cancellation must not start failure backoff");
});

test("an already aborted cache hit is rejected without invalidating the cache", async () => {
  let calls = 0;
  const client = new CatalogClient({ fetchRows: async () => { calls++; return []; } });
  await client.get(args);
  await assert.rejects(client.get({ ...args, signal: AbortSignal.abort() }), { name: "AbortError" });
  assert.deepEqual((await client.get(args)).models, []);
  assert.equal(calls, 2);
});

test("a joining waiter can cancel independently and promptly", async () => {
  const gate = deferred();
  const client = new CatalogClient({ fetchRows: async () => { await gate.promise; return []; } });
  const first = client.get(args);
  const controller = new AbortController();
  let settled = false;
  const joining = client.get({ ...args, signal: controller.signal }).then(
    () => ({ fulfilled: true }), (error) => { settled = true; return { error }; });
  controller.abort();
  await turn();
  const promptly = settled;
  gate.resolve();
  await first;
  const result = await joining;
  assert.equal(promptly, true);
  assert.equal(result.error?.name, "AbortError");
});

test("providerIds scope is checked before credentials or the network", async () => {
  const cpa = fixture({ resolveAuth: () => { assert.fail("out-of-scope auth"); },
    fetchRows: () => { assert.fail("out-of-scope network"); } });
  assert.equal(await cpa.provider.catalog.run({ config, providerIds: ["unrelated"] }), null);
  assert.equal(await cpa.discover({ config, providerIds: [] }), null);
});

test("failed host credential preparation is not retried through another auth path", async () => {
  let fallback = 0, calls = 0;
  const cpa = fixture({ resolveAuth: async () => { fallback++; return { apiKey: "other-profile-key" }; },
    fetchRows: async () => { calls++; return []; } });
  await assert.rejects(cpa.discover({ config, resolveProviderAuth: () => ({
    mode: "none", source: "none", apiKey: undefined, preparationFailed: true,
  }) }), /credential preparation/i);
  assert.equal(fallback, 0);
  assert.equal(calls, 0);
});

test("a supplied host auth resolver reporting no credential is authoritative", async () => {
  let fallback = 0;
  const cpa = fixture({ resolveAuth: async () => { fallback++; return { apiKey: "other-profile-key" }; } });
  assert.equal(await cpa.discover({ config, resolveProviderAuth: () => ({ mode: "none", source: "none" }) }), null);
  assert.equal(fallback, 0);
});

test("resolved discovery bytes are passed through the SDK's discoveryApiKey channel", async () => {
  const received = [];
  const cpa = fixture({ fetchRows: async (params) => { received.push(params); return rows(params); } });
  const result = await cpa.discover({ config, resolveProviderAuth: () => ({
    apiKey: "CPA_API_KEY", discoveryApiKey: "resolved-test-key", mode: "api_key", source: "env",
  }) });
  assert.equal(result.persistedKey, "CPA_API_KEY");
  assert.equal(received.length, 2);
  assert.ok(received.every((r) => r.discoveryApiKey === "resolved-test-key"));
});

test("dynamic auth preparation forwards the host-selected profile", async () => {
  let selected;
  const cpa = fixture({ resolveAuth: async (params) => { selected = params; return { apiKey: "key-b" }; } });
  await cpa.provider.prepareDynamicModel({ config, modelId: "shared-id", authProfileId: "cliproxyapi:b" });
  assert.equal(selected.profileId, "cliproxyapi:b");
});

test("a dynamic prepare returns its own model, not a later caller's cached binding", async () => {
  const cpa = fixture();
  const model = await cpa.provider.prepareDynamicModel({ config, modelId: "shared-id" });
  assert.equal(model?.id, "shared-id");
  assert.equal(model.contextWindow, 64000);
});

test("synchronous runtime bindings do not cross workspaces", async () => {
  const cpa = fixture();
  const ctx = { config, modelId: "shared-id", agentDir: "/agent", workspaceDir: "/workspace-a" };
  await cpa.discover(ctx);
  assert.equal(cpa.provider.resolveDynamicModel({ ...ctx, workspaceDir: "/workspace-b" }), undefined);
});

test("thinking hooks never infer another context's model capabilities from global cache size", async () => {
  const cpa = fixture();
  await cpa.discover({ config, agentDir: "/private-agent" });
  assert.equal(cpa.provider.resolveThinkingProfile({ provider: "cliproxyapi", modelId: "shared-id" }), undefined);
  assert.deepEqual(cpa.provider.resolveThinkingProfile({ provider: "cliproxyapi", modelId: "shared-id",
    reasoning: true, compat: { supportedReasoningEfforts: ["high"] } }).levels, [{ id: "high" }]);
  assert.deepEqual(cpa.provider.resolveThinkingProfile({ provider: "cliproxyapi", modelId: "shared-id",
    reasoning: false }).levels, [{ id: "off" }]);
});

test("reasoning:false cannot be bypassed by a stale exact effort override", () => {
  assert.throws(() => selectEffort({ reasoning: false,
    compat: { supportedReasoningEfforts: ["high"] } }, "high", "high"), /disabled/i);
});

test("explicit supportsReasoningEffort:false is honored on the wire", () => {
  assert.equal(selectEffort({ reasoning: true,
    compat: { supportsReasoningEffort: false, supportedReasoningEfforts: ["high"] } }, "high"), undefined);
});

test("mismatched ownership never borrows capabilities from a same-ID bundled model", () => {
  const m = projectModel({ id: "gpt-5.5", owned_by: "private-router" });
  assert.equal(m.contextWindow, 32768);
  assert.equal(m.maxTokens, 4096);
  assert.deepEqual(m.input, ["text"]);
  assert.equal(m.reasoning, false);
});

test("input modality and default effort normalization matches CPA's string normalization", () => {
  const m = projectModel({ id: "custom" }, { input_modalities: [" TEXT ", " IMAGE "],
    supported_reasoning_levels: ["low", "high"], default_reasoning_level: " HIGH " });
  assert.deepEqual(m.input, ["text", "image"]);
  assert.equal(m.params.cpa.defaultEffort, "high");
});

const snapshot = { baseUrl: args.baseUrl, revision: "rev", models: [{ id: "shared-id", compat: {}, params: {} }] };
test("catalog publication carries the same agent/workspace scope as discovery", async () => {
  const scope = { config, agentId: "secondary", agentDir: "/agents/secondary", workspaceDir: "/work/secondary" };
  let receivedScope, receivedLoad;
  const runtime = { loadPreparedModelCatalog: async (params) => {
    receivedLoad = params; return [{ provider: "cliproxyapi", id: "shared-id" }];
  } };
  const sync = createCatalogSynchronizer({ config, discover: async () => snapshot,
    publish: async (cfg, value, ctx) => {
      receivedScope = ctx;
      return materializeCatalog(cfg, value, runtime, ctx);
    } });
  assert.equal((await sync(scope)).synced, true);
  assert.equal(receivedScope?.agentDir, scope.agentDir);
  assert.equal(receivedLoad.agentId, scope.agentId);
  assert.equal(receivedLoad.agentDir, scope.agentDir);
  assert.equal(receivedLoad.workspaceDir, scope.workspaceDir);
  assert.equal(receivedLoad.config, config);
});

test("a workspace change is not skipped as an unchanged publication", async () => {
  let writes = 0;
  const sync = createCatalogSynchronizer({ config, discover: async () => snapshot,
    publish: async () => { writes++; return { synced: true }; } });
  await sync({ config, workspaceDir: "/a" });
  await sync({ config, workspaceDir: "/b" });
  assert.equal(writes, 2);
});

test("an unresolved host auth marker never goes to CPA or a second profile", async () => {
  let calls = 0;
  const cpa = fixture({ isApiKeyMarker: (value) => value === "test-secretref-marker",
    fetchRows: async () => { calls++; return []; },
    resolveAuth: async () => { assert.fail("must not retry auth"); } });
  await assert.rejects(cpa.discover({ config, resolveProviderAuth: () => ({
    apiKey: "test-secretref-marker", mode: "api_key", source: "profile",
  }) }), /resolved credentials/);
  assert.equal(calls, 0);
});

test("host-classified literal keys and explicit raw credentials remain usable", async () => {
  const cpa = fixture({ isApiKeyMarker: (value) => value === "looks-like-a-marker" });
  assert.ok(await cpa.discover({ config, resolveProviderApiKey: () => ({ apiKey: "real-literal-key" }) }));
  // Inference options carry actual bytes, even when those bytes happen to resemble a marker.
  assert.ok(await cpa.discover({ config }, { apiKey: "looks-like-a-marker" }));
});

test("selected auth profiles have independent synchronous model bindings", async () => {
  const cpa = fixture({ resolveAuth: async ({ profileId }) => ({ apiKey: profileId }),
    fetchRows: async ({ endpoint, discoveryApiKey }) => endpoint.includes("?")
      ? [{ slug: discoveryApiKey, supported_reasoning_levels: [] }] : [{ id: discoveryApiKey }] });
  const a = { config, authProfileId: "profile-a", modelId: "profile-a" };
  const b = { config, authProfileId: "profile-b", modelId: "profile-b" };
  await cpa.discover(a);
  await cpa.discover(b);
  assert.equal(cpa.provider.resolveDynamicModel(a)?.id, "profile-a");
  assert.equal(cpa.provider.resolveDynamicModel(b)?.id, "profile-b");
});

test("clearing prepared credentials removes the previous synchronous binding", async () => {
  const cpa = fixture();
  const ctx = { config, modelId: "shared-id" };
  await cpa.discover(ctx);
  assert.ok(cpa.provider.resolveDynamicModel(ctx));
  await cpa.discover({ ...ctx, resolveProviderAuth: () => ({ mode: "none", source: "none" }) });
  assert.equal(cpa.provider.resolveDynamicModel(ctx), undefined);
});
