import test from "node:test";
import assert from "node:assert/strict";
import { CatalogClient, projectCatalog, projectModel, normalizeBaseUrl, readCatalogRows } from "../src/catalog.js";
const basic = (id = "test-model", owned_by = "test") => ({ id, object: "model", owned_by });
const rich = (slug = "test-model", efforts = ["low", "high"]) => ({ slug, context_window: 64000, max_context_window: 128000,
  max_tokens: 12000, input_modalities: ["text", "image"], supported_reasoning_levels: efforts.map((effort) => ({ effort })), default_reasoning_level: efforts[0] });

test("endpoint normalization preserves reverse proxy prefixes and rejects credential-bearing URLs", () => {
  assert.equal(normalizeBaseUrl("http://localhost:8317"), "http://localhost:8317/v1");
  assert.equal(normalizeBaseUrl("https://proxy.test/cpa/v1/"), "https://proxy.test/cpa/v1");
  for (const url of ["file:///tmp/a", "http://user:secret@host", "https://host?key=secret", "https://host/#fragment", "not a url"])
    assert.throws(() => normalizeBaseUrl(url));
});
test("rich metadata uses default context, not maximum possible context, and keeps literal aliases", () => {
  const m = projectModel(basic("team/custom", "openai"), rich("team/custom"));
  assert.equal(m.id, "team/custom"); assert.equal(m.contextWindow, 64000); assert.equal(m.maxTokens, 12000);
  assert.equal(m.params.cpa.maxContextWindow, 128000); assert.equal(m.api, "openai-responses");
  assert.deepEqual(m.compat.supportedReasoningEfforts, ["low", "high"]);
});
test("empty effort list is authoritative; unknown models get conservative defaults", () => {
  assert.equal(projectModel(basic(), rich("test-model", [])).reasoning, false);
  const m = projectModel(basic());
  assert.equal(m.contextWindow, 32768); assert.equal(m.maxTokens, 4096); assert.equal(m.reasoning, false);
  assert.deepEqual(m.input, ["text"]);
});
test("CPA native metadata corrects template-inherited reasoning without replacing a changed live contract", () => {
  for (const id of ["kimi-k2", "grok-4.20-0309-non-reasoning"]) {
    const m = projectModel(basic(id, id === "kimi-k2" ? "moonshot" : "xai"), rich(id, ["low", "medium", "high", "xhigh"]));
    assert.equal(m.reasoning, false);
    assert.ok(m.params.cpa.warnings.some((w) => w.includes("template corrected")));
  }
  assert.equal(projectModel(basic("kimi-k2"), rich("kimi-k2", ["none", "high"])).reasoning, true);
});
test("budget-only Claude thinking survives a Codex projection with absent/empty levels", () => {
  for (const levels of [undefined, []]) {
    const r = rich("claude-haiku-4-5-20251001"); r.supported_reasoning_levels = levels;
    const m = projectModel(basic(r.slug, "anthropic"), r);
    assert.equal(m.reasoning, true); assert.ok(m.compat.supportedReasoningEfforts.includes("none"));
    assert.ok(m.compat.supportedReasoningEfforts.includes("high")); assert.ok(!m.compat.supportedReasoningEfforts.includes("minimal"));
  }
});
test("metadata cannot resurrect unavailable models; hidden media models are excluded", () => {
  assert.deepEqual(projectCatalog([], [rich()], {}), []);
  assert.deepEqual(projectCatalog([basic()], [{ ...rich(), visibility: "hide" }], {}), []);
  assert.equal(projectCatalog([basic(), basic()], [rich()], {}).length, 1);
});
test("invalid rows fail the snapshot instead of silently causing model deletions", () => {
  assert.throws(() => readCatalogRows({ error: "failure" }));
  assert.throws(() => projectCatalog([{ wrong: "id" }], [], {}));
  assert.throws(() => projectCatalog([basic()], [{ wrong: "slug" }], {}));
  assert.throws(() => projectCatalog([basic()], [rich(), rich()], {}));
});
test("invalid token limits do not escape to the runtime", () => {
  const m = projectModel(basic(), { ...rich(), context_window: -1, max_tokens: Infinity });
  assert.equal(m.contextWindow, 32768); assert.equal(m.maxTokens, 4096);
});
function fixture() {
  let time = 1000, calls = 0, failure, models = ["a"], levels = ["low", "high"];
  const client = new CatalogClient({ now: () => time, ttlMs: 100, staleMs: 200, useBundledMetadata: false,
    fetchRows: async ({ endpoint }) => { calls++; if (failure) throw failure;
      return models.map((id) => endpoint.includes("?") ? rich(id, levels) : basic(id)); } });
  const args = { baseUrl: "http://localhost:8317/v1", apiKey: "key-a" };
  return { client, args, calls: () => calls, advance: (ms) => time += ms,
    fail: (status) => failure = Object.assign(new Error("secret upstream error"), { status }),
    change: (ids, efforts = levels) => { models = ids; levels = efforts; failure = undefined; } };
}
test("TTL cache coalesces concurrent requests and atomically adds/deletes/updates models", async () => {
  const f = fixture(); const values = await Promise.all(Array.from({ length: 10 }, () => f.client.get(f.args)));
  assert.equal(f.calls(), 2); assert.equal(values[0].models[0].id, "a");
  f.change(["b"], ["none", "max"]); f.advance(101); const next = await f.client.get(f.args);
  assert.deepEqual(next.models.map((m) => m.id), ["b"]); assert.deepEqual(next.models[0].compat.supportedReasoningEfforts, ["none", "max"]);
  assert.notEqual(next.revision, values[0].revision); f.change([]); f.advance(101);
  assert.deepEqual((await f.client.get(f.args)).models, []);
});
test("transient errors use a bounded stale snapshot without extending its expiry", async () => {
  const f = fixture(); await f.client.get(f.args); f.advance(101); f.fail(503);
  const old = await f.client.get(f.args); assert.equal(old.stale, true); assert.equal(old.models[0].id, "a");
  const calls = f.calls(); await f.client.get(f.args); assert.equal(f.calls(), calls);
  f.advance(201); await assert.rejects(f.client.get(f.args), /HTTP 503/);
  assert.equal(f.client.peek(f.args.baseUrl, f.args.apiKey), undefined);
});
test("auth errors invalidate cached models; diagnostics do not contain upstream secrets", async () => {
  for (const status of [401, 403]) {
    const f = fixture(); await f.client.get(f.args); f.advance(101); f.fail(status);
    await assert.rejects(f.client.get(f.args), (e) => e.status === status && !e.message.includes("secret"));
    assert.equal(f.client.peek(f.args.baseUrl, f.args.apiKey), undefined);
  }
});
test("different keys and endpoints cannot share a cached catalog", async () => {
  const f = fixture(); await f.client.get(f.args); f.change(["b"]);
  assert.equal((await f.client.get({ ...f.args, apiKey: "key-b" })).models[0].id, "b");
  assert.equal((await f.client.get(f.args)).models[0].id, "a");
  assert.equal((await f.client.get({ ...f.args, baseUrl: "http://localhost:8318/v1" })).models[0].id, "b");
});
test("older servers fall back only for unsupported discovery, not auth/server errors", async () => {
  for (const status of [404, 405, 401, 500]) {
    const c = new CatalogClient({ fetchRows: async ({ endpoint }) => {
      if (endpoint.includes("?")) throw Object.assign(new Error(), { status }); return [basic()];
    } });
    if ([404, 405].includes(status)) assert.equal((await c.get({ baseUrl: "http://localhost" })).models.length, 1);
    else await assert.rejects(c.get({ baseUrl: "http://localhost" }));
  }
});
test("servers ignoring client_version still produce a usable catalog", async () => {
  const c = new CatalogClient({ fetchRows: async () => [basic()] });
  const result = await c.get({ baseUrl: "http://localhost" }); assert.equal(result.rich, false); assert.equal(result.models.length, 1);
});
