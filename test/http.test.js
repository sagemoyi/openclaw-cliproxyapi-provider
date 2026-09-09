// Real loopback HTTP integration for our catalog logic, NOT an OpenClaw SDK/CPA-server E2E.
// The production plugin still uses OpenClaw's guarded acquisition helper, not this adapter.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { CatalogClient } from "../src/catalog.js";
import { createCpaProvider } from "../src/provider.js";

async function fetchRowsOverHttp({ endpoint, discoveryApiKey, apiKey, signal, readRows }) {
  const key = discoveryApiKey ?? apiKey;
  const response = await fetch(endpoint, { signal, redirect: "error",
    headers: key ? { Authorization: `Bearer ${key}` } : {} });
  if (!response.ok) {
    await response.body?.cancel();
    throw Object.assign(new Error("HTTP failure"), { status: response.status });
  }
  return readRows(await response.json());
}
async function serve(t, handler) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return `http://127.0.0.1:${server.address().port}`;
}
const send = (res, data, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};
const payload = (url, ids) => url.includes("?")
  ? { models: ids.map((slug) => ({ slug, context_window: 64000, max_tokens: 2048,
      supported_reasoning_levels: ["none", "high"] })) }
  : { data: ids.map((id) => ({ id })) };

test("loopback HTTP: reverse-proxy prefix, authentication and raw key rotation", async (t) => {
  const seen = [];
  const origin = await serve(t, (req, res) => {
    seen.push([req.url, req.headers.authorization]);
    const id = req.headers.authorization === "Bearer test-a" ? "model-a" : "model-b";
    send(res, payload(req.url, [id]));
  });
  const config = { models: { providers: { cliproxyapi: { baseUrl: `${origin}/cpa`, models: [] } } } };
  const cpa = createCpaProvider({ config, fetchRows: fetchRowsOverHttp,
    resolveAuth: async () => ({ apiKey: "test-a" }) });
  assert.deepEqual((await cpa.discover()).models.map((m) => m.id), ["model-a"]);
  assert.deepEqual((await cpa.discover({}, { apiKey: "test-b" })).models.map((m) => m.id), ["model-b"]);
  assert.deepEqual(seen.map(([url]) => url).sort(), [
    "/cpa/v1/models", "/cpa/v1/models", "/cpa/v1/models?client_version=", "/cpa/v1/models?client_version=",
  ]);
  assert.equal(seen.filter(([, auth]) => auth === "Bearer test-b").length, 2);
});

test("loopback HTTP: a successful empty snapshot removes every live model", async (t) => {
  let ids = ["a", "b"];
  const baseUrl = await serve(t, (req, res) => send(res, payload(req.url, ids)));
  const client = new CatalogClient({ fetchRows: fetchRowsOverHttp });
  const first = await client.get({ baseUrl, apiKey: "test-key" });
  ids = [];
  const next = await client.get({ baseUrl, apiKey: "test-key", force: true });
  assert.equal(first.models.length, 2);
  assert.deepEqual(next.models, []);
  assert.equal(next.stale, false);
  assert.notEqual(first.revision, next.revision);
});

test("loopback HTTP: rich 401 takes precedence over plain 503 and destroys stale state", async (t) => {
  let failure = false;
  const baseUrl = await serve(t, (req, res) => {
    if (failure) send(res, { error: "private diagnostic that must not escape" }, req.url.includes("?") ? 401 : 503);
    else send(res, payload(req.url, ["a"]));
  });
  const client = new CatalogClient({ fetchRows: fetchRowsOverHttp });
  const args = { baseUrl, apiKey: "test-key" };
  await client.get(args);
  failure = true;
  await assert.rejects(client.get({ ...args, force: true }), (error) =>
    error.status === 401 && !error.message.includes("private"));
  assert.equal(client.peek(baseUrl, args.apiKey), undefined);
});

test("loopback HTTP: malformed JSON serves bounded stale data then recovers", async (t) => {
  let malformed = false, time = 1000;
  const baseUrl = await serve(t, (req, res) => {
    if (malformed && req.url.includes("?")) { res.end("not JSON"); return; }
    send(res, payload(req.url, ["a"]));
  });
  const client = new CatalogClient({ fetchRows: fetchRowsOverHttp, now: () => time, ttlMs: 10, staleMs: 20 });
  const args = { baseUrl, apiKey: "test-key" };
  await client.get(args);
  malformed = true; time = 1011;
  assert.equal((await client.get(args)).stale, true);
  time = 1031;
  await assert.rejects(client.get(args), /invalid catalog/);
  malformed = false;
  assert.equal((await client.get({ ...args, force: true })).stale, false);
});

test("loopback HTTP: unsupported rich discovery falls back, server failure does not", async (t) => {
  let status = 404;
  const baseUrl = await serve(t, (req, res) => {
    if (req.url.includes("?")) send(res, {}, status);
    else send(res, { data: [{ id: "private-model" }] });
  });
  let time = 1000;
  const client = new CatalogClient({ fetchRows: fetchRowsOverHttp, staleMs: 0, ttlMs: 0, now: () => time });
  const args = { baseUrl, apiKey: "test-key" };
  const result = await client.get(args);
  assert.equal(result.rich, false);
  assert.equal(result.models[0].contextWindow, 32768);
  status = 500; time++;
  await assert.rejects(client.get({ ...args, force: true }), /HTTP 500/);
});

test("loopback HTTP: shared discovery stays bounded when callers all cancel", async (t) => {
  let count = 0;
  const baseUrl = await serve(t, (_req, _res) => { count++; /* Deliberately never respond. */ });
  const client = new CatalogClient({ fetchRows: fetchRowsOverHttp, timeoutMs: 250 });
  const controller = new AbortController();
  const args = { baseUrl, apiKey: "test-key" };
  const cancelled = assert.rejects(client.get({ ...args, signal: controller.signal }), { name: "AbortError" });
  const survivor = assert.rejects(client.get(args), /network or invalid catalog/);
  controller.abort();
  await cancelled;
  await survivor;
  assert.equal(count, 2);
  assert.equal(client.peek(baseUrl, args.apiKey), undefined);
});
