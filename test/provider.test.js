import test from "node:test";
import assert from "node:assert/strict";
import { createCpaProvider, thinkingProfile, selectEffort, patchPayload, mergeExplicit } from "../src/provider.js";
const model = (efforts) => ({ id: "custom", reasoning: efforts.some((x) => x !== "none"),
  compat: { supportedReasoningEfforts: efforts }, params: { cpa: { defaultEffort: efforts[0] } } });
test("thinking UI exposes actual wire controls and respects sparse/non-reasoning contracts", () => {
  assert.deepEqual(thinkingProfile(model(["low", "high"])).levels.map((x) => x.id), ["low", "high"]);
  assert.deepEqual(thinkingProfile(model(["none", "high", "auto"])).levels.map((x) => x.id), ["off", "high", "adaptive"]);
  assert.deepEqual(thinkingProfile(model([])).levels, [{ id: "off" }]);
  assert.deepEqual(thinkingProfile(model(["low", "max", "ultra"])).levels.map((x) => x.id), ["low", "max"]);
});
test("exact ultra is distinct from max; unsupported overrides fail", () => {
  const m = model(["low", "high", "max", "ultra"]);
  assert.equal(selectEffort(m, "max"), "max"); assert.equal(selectEffort(m, "max", "ultra"), "ultra");
  assert.throws(() => selectEffort(model(["low"]), "low", "ultra"));
  assert.equal(selectEffort(model(["low", "high"]), "medium"), "low");
  assert.equal(selectEffort(model(["none", "low"]), "off"), "none"); assert.equal(selectEffort(model([]), "high"), undefined);
});
test("payload rewriting preserves fields and strips unsupported reasoning", () => {
  assert.deepEqual(patchPayload({ model: "a", reasoning: { effort: "low", summary: "auto" }, tools: [1] }, "openai-responses", "max"),
    { model: "a", reasoning: { effort: "max", summary: "auto" }, tools: [1] });
  assert.deepEqual(patchPayload({ model: "a", reasoning_effort: "high" }, "openai-completions", undefined), { model: "a" });
});
test("standard explicit provider/model overrides win", () => {
  const m = { ...model(["high"]), api: "openai-responses", contextWindow: 64000 };
  const result = mergeExplicit(m, { models: { providers: { cliproxyapi: { api: "openai-completions",
    models: [{ id: "custom", contextWindow: 32000, reasoning: false }] } } } });
  assert.equal(result.api, "openai-completions"); assert.equal(result.contextWindow, 32000); assert.equal(result.compat.supportsReasoningEffort, false);
});
test("provider refreshes capabilities, refuses deleted models, and composes payload callbacks", async () => {
  let ids = ["custom"], efforts = ["low", "high"], time = 1, payload;
  const cfg = { models: { providers: { cliproxyapi: { baseUrl: "http://localhost:8317/v1", models: [] } } },
    plugins: { entries: { "openclaw-cliproxyapi-provider": { config: { refreshSeconds: 10 } } } } };
  const cpa = createCpaProvider({ config: cfg, now: () => time, resolveAuth: async () => ({ apiKey: "secret" }),
    fetchRows: async ({ endpoint }) => ids.map((id) => endpoint.includes("?") ? { slug: id, context_window: 64000,
      supported_reasoning_levels: efforts.map((effort) => ({ effort })) } : { id }) });
  const ctx = { config: cfg, modelId: "custom", agentDir: "/tmp/cpa-test-agent" };
  assert.equal((await cpa.provider.catalog.run(ctx)).provider.models.length, 1);
  assert.equal(cpa.provider.resolveDynamicModel(ctx).contextWindow, 64000);
  const wrapped = cpa.provider.wrapStreamFn({ ...ctx, thinkingLevel: "high", streamFn: async (m, messages, options) => {
    payload = await options.onPayload({ model: m.id, reasoning_effort: "low" }, m); return { model: m, messages };
  } });
  const result = await wrapped({ id: "custom" }, { messages: [] }, { onPayload: async (p) => ({ ...p, retained: true }) });
  assert.equal(result.model.reasoning, true); assert.equal(payload.reasoning_effort, "high"); assert.equal(payload.retained, true);
  efforts = []; time += 10001; await wrapped({ id: "custom" }, { messages: [] }); assert.equal(payload.reasoning_effort, undefined);
  ids = ["new-model"]; time += 10001;
  await assert.rejects(wrapped({ id: "custom" }, { messages: [] }), /no longer advertised/);
  await cpa.provider.prepareDynamicModel({ ...ctx, modelId: "new-model" });
  assert.equal(cpa.provider.resolveDynamicModel({ ...ctx, modelId: "new-model" }).id, "new-model");
});
test("unconfigured provider stays offline", async () => {
  const cpa = createCpaProvider({ fetchRows: () => { throw Error("network"); }, resolveAuth: () => { throw Error("auth"); } });
  assert.equal(await cpa.provider.catalog.run({ config: {} }), null); assert.equal(await cpa.provider.staticCatalog.run({}), null);
});
