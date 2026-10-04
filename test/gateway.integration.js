import "./isolated-host-env.js";
// Requires the targeted OpenClaw peer. Catalog changes are checked through public RPC.
import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { buildAuthModelAccessPatch } from "../src/auth.js";
import { installHostPlugin, resolveHostCli } from "./install-host-plugin.js";
const exec = promisify(execFile);
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

test("Gateway publishes additions, removals, capabilities and empty catalogs on the host-owned path", { timeout: 240000 }, async (t) => {
  let ids = ["model-a", "model-b"], context = 64000;
  const server = createServer((req, res) => {
    if (req.headers.authorization !== "Bearer test-key") { res.writeHead(401); res.end("{}"); return; }
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify(req.url.includes("?") ? { models: ids.map((slug) => ({ slug, context_window: context,
      supported_reasoning_levels: [{ effort: "high" }] })) } : { data: ids.map((id) => ({ id })) }));
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const probe = createServer();
  await new Promise((r) => probe.listen(0, "127.0.0.1", r));
  const port = probe.address().port;
  await new Promise((r) => probe.close(r));
  const stateDir = await mkdtemp(path.join(tmpdir(), "cpa-gateway-test-"));
  const configPath = path.join(stateDir, "openclaw.json");
  const token = "isolated-gateway-test-token";
  const config = { gateway: { mode: "local", port, bind: "loopback", auth: { mode: "token", token } },
    models: { providers: { cliproxyapi: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: "test-key", models: [] } } },
    plugins: { allow: ["cliproxyapi"], entries: { cliproxyapi: { enabled: true, config: { refreshSeconds: 10 } } } },
    agents: { defaults: { workspace: path.join(stateDir, "workspace"), model: { primary: "cliproxyapi/model-b" }, models: { "cliproxyapi/*": {} } } } };
  // Reproduce login on a host with a pre-existing policy that hides CPA.
  config.agents.defaults.modelPolicy = { allow: ["unrelated/model"] };
  Object.assign(config.agents.defaults, buildAuthModelAccessPatch(config).defaults);
  assert.deepEqual(config.agents.defaults.modelPolicy.allow, ["unrelated/model", "cliproxyapi/*"]);
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  const env = { ...process.env, OPENCLAW_STATE_DIR: stateDir, OPENCLAW_CONFIG_PATH: configPath,
    OPENCLAW_SKIP_CHANNELS: "1", OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1" };
  delete env.OPENCLAW_AGENT_DIR;
  const hostCli = resolveHostCli();
  await installHostPlugin((...args) => exec(hostCli, args, { env, timeout: 120000, maxBuffer: 4 * 1024 * 1024 }));
  const installedConfig = await readFile(configPath, "utf8");
  let child, log = "";
  function start() {
    child = spawn(hostCli, ["gateway", "run", "--port", String(port)], { env, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b) => log = (log + b.toString()).slice(-20000));
    child.stderr.on("data", (b) => log = (log + b.toString()).slice(-20000));
  }
  async function stop() {
    if (child.exitCode === null) { child.kill("SIGTERM"); await Promise.race([new Promise((r) => child.once("exit", r)), pause(5000)]); }
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise((r) => child.once("exit", r)); }
  }
  t.after(stop); start();
  const list = async () => {
    const result = await exec(hostCli, ["gateway", "call", "models.list", "--url", `ws://127.0.0.1:${port}`, "--token", token, "--json"],
      { env, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    return JSON.parse(result.stdout).models.filter((m) => m.provider === "cliproxyapi");
  };
  async function waitFor(read, predicate, label) {
    const until = Date.now() + 45000; let last;
    while (Date.now() < until) {
      if (child.exitCode !== null) throw new Error(`Gateway exited: ${log}`);
      try { last = await read(); if (predicate(last)) return last; } catch (e) { last = e.message; }
      await pause(1000);
    }
    throw new Error(`${label} failed: ${JSON.stringify(last)}\n${log}`);
  }
  await waitFor(list, (rows) => rows.some((m) => m.id === "model-a"), "initial discovery");
  const inspection = JSON.parse((await exec(hostCli,
    ["plugins", "inspect", "cliproxyapi", "--runtime", "--json"],
    { env, timeout: 30000, maxBuffer: 4 * 1024 * 1024 })).stdout);
  assert.equal(inspection.plugin.status, "loaded");
  assert.ok(inspection.plugin.providerIds.includes("cliproxyapi"));
  assert.equal(inspection.install.artifactKind, "npm-pack");
  ids = ["model-b", "model-c"]; context = 96000;
  const changed = await waitFor(list, (rows) => rows.some((m) => m.id === "model-c") && !rows.some((m) => m.id === "model-a"), "automatic publication");
  assert.equal(changed.find((m) => m.id === "model-b").contextWindow, 96000);
  ids = [];
  await waitFor(list, (rows) => rows.length === 0, "empty catalog publication");
  assert.equal(await readFile(configPath, "utf8"), installedConfig);
  t.diagnostic(`Catalog published without restart; isolated artifacts: ${stateDir}`);
});
