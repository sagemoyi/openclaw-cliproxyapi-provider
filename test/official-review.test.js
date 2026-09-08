import test from "node:test";
import assert from "node:assert/strict";
import { CatalogClient, projectModel, readCatalogRows } from "../src/catalog.js";
import { thinkingProfile, selectEffort } from "../src/provider.js";
import { materializeCatalog } from "../src/sync.js";
import { createCatalogSynchronizer, createCatalogService } from "../src/lifecycle.js";

const deferred = () => {
  let resolve, reject;
  const promise = new Promise((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
};
const flush = () => new Promise((r) => setImmediate(r));
const args = { baseUrl: "http://localhost/v1", apiKey: "test-key" };
const snapshot = { baseUrl: args.baseUrl, revision: "r1", models: [{ id: "a", compat: {}, params: {} }] };

test("official-compatible string/object efforts normalize without losing sparse levels", () => {
  const m = projectModel({ id: "custom" }, { supported_reasoning_levels:
    [" NONE ", { effort: "HIGH" }, "high", "max", "auto", null, {}, "invalid"],
    max_tokens: 2048, context_window: 64000 }, { useBundledMetadata: false });
  assert.deepEqual(m.compat.supportedReasoningEfforts, ["none", "high", "max", "auto"]);
  assert.deepEqual(thinkingProfile(m).levels.map((x) => x.id), ["off", "high", "max", "adaptive"]);
  assert.equal(selectEffort(m, "adaptive"), "auto");
  assert.equal(m.maxTokens, 2048);
  assert.equal(projectModel({ id: "custom" }, { visibility: " HIDE " }), null);
});

test("id-based rich rows and top-level arrays retain metadata rather than triggering old-server fallback", async () => {
  const client = new CatalogClient({ fetchRows: async ({ endpoint, readRows }) => readRows(
    endpoint.includes("?") ? [{ id: "a", context_window: 64000, supported_reasoning_levels: ["high"] }] : [{ id: "a" }]) });
  const result = await client.get(args);
  assert.equal(result.rich, true);
  assert.equal(result.models[0].contextWindow, 64000);
  assert.deepEqual(result.models[0].compat.supportedReasoningEfforts, ["high"]);
  const limitsOnly = new CatalogClient({ fetchRows: async ({ endpoint }) =>
    endpoint.includes("?") ? [{ id: "a", max_tokens: 2048 }] : [{ id: "a" }] });
  const minimal = await limitsOnly.get(args);
  assert.equal(minimal.rich, true);
  assert.equal(minimal.models[0].maxTokens, 2048);
  assert.throws(() => readCatalogRows("not JSON"));
  assert.throws(() => readCatalogRows({ error: "bad gateway" }));
});

test("synchronous cache reads expose expiration, never a fresh-looking stale snapshot", async () => {
  let time = 0;
  const client = new CatalogClient({ now: () => time, ttlMs: 100, staleMs: 200, fetchRows: async () => [] });
  await client.get(args);
  assert.equal(client.peek(args.baseUrl, args.apiKey).stale, false);
  time = 100;
  assert.equal(client.peek(args.baseUrl, args.apiKey).stale, true);
  time = 301;
  assert.equal(client.peek(args.baseUrl, args.apiKey), undefined);
});

test("rich-endpoint auth failure invalidates cached data even when plain endpoint returns 503", async () => {
  for (const status of [401, 403]) {
    let fail = false;
    const client = new CatalogClient({ fetchRows: async ({ endpoint }) => {
      if (fail) throw Object.assign(new Error("private body"), { status: endpoint.includes("?") ? status : 503 });
      return [];
    } });
    await client.get(args);
    fail = true;
    await assert.rejects(client.get({ ...args, force: true }), (e) => e.status === status && !e.message.includes("private"));
    assert.equal(client.peek(args.baseUrl, args.apiKey), undefined);
  }
});

test("publication detects retained removals including an empty new catalog, but permits explicit user rows", async () => {
  const runtime = { loadModelCatalog: async () => [{ provider: "cliproxyapi", id: "a" }, { provider: "cliproxyapi", id: "removed" }] };
  await assert.rejects(materializeCatalog({}, snapshot, runtime), /retained removed/);
  await assert.rejects(materializeCatalog({}, { ...snapshot, models: [] }, runtime), /retained removed/);
  const config = { models: { providers: { cliproxyapi: { models: [{ id: "removed" }] } } } };
  assert.equal((await materializeCatalog(config, snapshot, runtime)).synced, true);
});

test("sync fingerprints endpoint, config and agent scope, not only model rows", async () => {
  let current = snapshot, writes = 0;
  const sync = createCatalogSynchronizer({ config: {}, discover: async () => current,
    publish: async () => { writes++; return { synced: true }; } });
  await sync({});
  assert.equal((await sync({})).reason, "unchanged");
  current = { ...snapshot, baseUrl: "http://other/v1" };
  await sync({});
  await sync({ config: { override: true } });
  await sync({ config: { override: true }, agentDir: "/tmp/other-agent" });
  assert.equal(writes, 4);
  await sync({ config: { override: true }, agentDir: "/tmp/other-agent" }, true);
  assert.equal(writes, 5);
});

test("sync serializes discovery and publication so old requests cannot publish last", async () => {
  const gate = deferred(), events = [];
  const sync = createCatalogSynchronizer({ discover: async (ctx) => {
    events.push("discover:" + ctx.id); return { ...snapshot, revision: ctx.id };
  }, publish: async (_, value) => {
    events.push("start:" + value.revision);
    if (value.revision === "old") await gate.promise;
    events.push("end:" + value.revision); return { synced: true };
  } });
  const first = sync({ id: "old" });
  await flush();
  const second = sync({ id: "new" });
  await flush();
  assert.deepEqual(events, ["discover:old", "start:old"]);
  gate.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["discover:old", "start:old", "end:old", "discover:new", "start:new", "end:new"]);
});

test("failed publication can retry; stale and unconfigured snapshots are not published", async () => {
  let current = snapshot, writes = 0;
  const sync = createCatalogSynchronizer({ discover: async () => current, publish: async () => {
    if (++writes === 1) throw Error("temporary"); return { synced: true };
  } });
  await assert.rejects(sync({}), /temporary/);
  assert.equal((await sync({})).synced, true);
  current = { ...snapshot, stale: true };
  assert.equal((await sync({}, true)).reason, "stale");
  current = null;
  assert.equal((await sync({})).reason, "unconfigured");
  assert.equal(writes, 2);
});

test("stopping during startup waits for discovery and never schedules a new timer", async () => {
  const gate = deferred();
  let scheduled = 0, stopped = false;
  const service = createCatalogService({ sync: () => gate.promise, intervalMs: 10,
    schedule: () => { scheduled++; return {}; }, cancel() {} });
  const starting = service.start({ logger: { warn() {} } });
  const stopping = service.stop().then(() => { stopped = true; });
  await flush();
  assert.equal(stopped, false);
  gate.resolve();
  await Promise.all([starting, stopping]);
  assert.equal(scheduled, 0);
});

test("duplicate starts do not create extra loops and a stopped callback cannot resurrect one", async () => {
  let scheduled = [], calls = 0;
  const service = createCatalogService({ sync: async () => { calls++; }, intervalMs: 10,
    schedule: (fn) => { scheduled.push(fn); return {}; }, cancel() {} });
  const ctx = { logger: { warn() {} } };
  await Promise.all([service.start(ctx), service.start(ctx)]);
  assert.equal(calls, 1);
  assert.equal(scheduled.length, 1);
  const oldCallback = scheduled[0];
  await service.stop();
  await service.start(ctx);
  await oldCallback();
  assert.equal(calls, 2);
  assert.equal(scheduled.length, 2);
  await service.stop();
});
