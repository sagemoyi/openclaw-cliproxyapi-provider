// Explicit integration suite: requires an installed OpenClaw executable + peer SDK.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { createCpaProvider } from "../src/provider.js";
const exec = promisify(execFile);

test("real SDK fetch + streaming transport honor string efforts, adaptive, non-reasoning and tool schemas", async (t) => {
  const requests = [];
  let efforts = ["none", "low", "high", "max", "ultra", "auto"];
  const server = createServer(async (req, res) => {
    assert.equal(req.headers.authorization, "Bearer test-key");
    res.setHeader("Content-Type", "application/json");
    if (req.url.startsWith("/v1/models")) {
      const rich = req.url.includes("?");
      res.end(JSON.stringify(rich ? { models: [
        { id: "proxy-test", context_window: 64000, max_tokens: 2048, supported_reasoning_levels: efforts },
      ] } : { data: [{ id: "proxy-test" }] })); return;
    }
    let body = ""; for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    res.setHeader("Content-Type", "text/event-stream");
    res.write(`data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "proxy-test", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ id: "chat-test", object: "chat.completion.chunk", created: 1, model: "proxy-test", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const config = { models: { providers: { cliproxyapi: { baseUrl, models: [] } } } };
  const cpa = createCpaProvider({ config, fetchRows: fetchLiveProviderModelRows, resolveAuth: async () => ({ apiKey: "test-key" }) });
  const ctx = { config, modelId: "proxy-test" };
  await cpa.provider.catalog.run(ctx);
  const model = cpa.provider.resolveDynamicModel(ctx);
  assert.equal(model.maxTokens, 2048);
  for (const [thinkingLevel, exact, expected] of [["high", undefined, "high"], ["max", undefined, "max"], ["max", "ultra", "ultra"], ["off", undefined, "none"], ["adaptive", undefined, "auto"]]) {
    const wrapped = cpa.provider.wrapStreamFn({ ...ctx, thinkingLevel, extraParams: { cpaReasoningEffort: exact }, streamFn: streamSimple });
    const stream = await wrapped(model, { messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }],
      tools: [{ name: "lookup", description: "Lookup a value", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }] },
    { apiKey: "test-key", maxTokens: 32 });
    const result = await stream.result();
    assert.equal(result.stopReason, "stop", result.errorMessage);
    assert.equal(requests.at(-1).reasoning_effort, expected);
    assert.equal(requests.at(-1).tools[0].function.name, "lookup");
  }
  efforts = [];
  await cpa.discover(ctx, { force: true });
  const nonReasoning = cpa.provider.wrapStreamFn({ ...ctx, thinkingLevel: "high", streamFn: streamSimple });
  const stream = await nonReasoning(model, { messages: [{ role: "user", content: "Say OK", timestamp: Date.now() }] },
    { apiKey: "test-key", maxTokens: 32 });
  const result = await stream.result();
  assert.equal(result.stopReason, "stop", result.errorMessage);
  assert.equal(Object.hasOwn(requests.at(-1), "reasoning_effort"), false);
});

test("isolated OpenClaw CLI installs and loads the provider and fetches live catalogs", { timeout: 120000 }, async (t) => {
  let ids = ["model-a", "model-b"];
  const server = createServer((req, res) => {
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer test-key") { res.statusCode = 401; res.end("{}"); return; }
    res.end(JSON.stringify(req.url.includes("?") ? { models: ids.map((slug) => ({ slug, context_window: 64000,
      supported_reasoning_levels: [{ effort: "high" }] })) } : { data: ids.map((id) => ({ id })) }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const stateDir = await mkdtemp(path.join(tmpdir(), "cpa-openclaw-test-"));
  const configPath = path.join(stateDir, "openclaw.json");
  const config = { models: { providers: { cliproxyapi: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-key", models: [] } } },
    plugins: { allow: ["cliproxyapi"], load: { paths: [process.cwd()] }, entries: { cliproxyapi: { enabled: true } } },
    agents: { defaults: { workspace: path.join(stateDir, "workspace"), models: { "cliproxyapi/*": {} } } } };
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1" };
  delete env.OPENCLAW_AGENT_DIR;
  const cli = async (...args) => exec("openclaw", args, { env, timeout: 55000, maxBuffer: 4 * 1024 * 1024 });
  // This test installs the checked-out source into a fresh isolated state directory.
  // September hosts require explicit trust confirmation for local plugin sources.
  // July hosts reject --force with --link; detect the newer confirmation option.
  const installHelp = (await cli("plugins", "install", "--help")).stdout;
  const trustArgs = /Confirm non-ClawHub sources/.test(installHelp) ? ["--force"] : [];
  await cli("plugins", "install", "--link", ...trustArgs, process.cwd());
  const installedConfig = await readFile(configPath, "utf8");
  const listing = await cli("plugins", "list", "--json");
  const parsed = JSON.parse(listing.stdout);
  const plugin = parsed.plugins.find((p) => p.id === "cliproxyapi");
  assert.equal(plugin.status, "loaded", JSON.stringify(plugin));
  const initial = JSON.parse((await cli("cpa", "catalog")).stdout);
  assert.deepEqual(initial.models.map((m) => m.id), ids);
  assert.ok(!JSON.stringify(initial).includes("test-key"));
  const firstSync = JSON.parse((await cli("cpa", "sync")).stdout);
  assert.equal(firstSync.synced, true);
  const firstList = await cli("models", "list", "--all", "--provider", "cliproxyapi", "--json");
  t.diagnostic(`first models list: ${firstList.stdout.slice(0, 1200)}`);
  assert.ok(firstList.stdout.includes("cliproxyapi/model-a"));
  ids = ["model-b", "model-c"];
  const updated = JSON.parse((await cli("cpa", "catalog")).stdout);
  assert.deepEqual(updated.models.map((m) => m.id), ids);
  assert.equal(JSON.parse((await cli("cpa", "sync")).stdout).synced, true);
  const models = await cli("models", "list", "--all", "--provider", "cliproxyapi", "--json");
  assert.ok(models.stdout.includes("cliproxyapi/model-c"));
  assert.ok(!models.stdout.includes("cliproxyapi/model-a"));
  t.diagnostic(`models list: ${models.stdout.slice(0, 1000)}`);
  assert.equal((await readFile(configPath, "utf8")), installedConfig);
  t.diagnostic(`Isolated host artifacts retained for inspection: ${stateDir}`);
});
