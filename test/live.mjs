// Explicit opt-in: sends real, small requests to CPA and may consume provider quota.
// Credentials are read from CPA_BASE_URL + CPA_API_KEY, never printed.
import assert from "node:assert/strict";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { streamSimple } from "openclaw/plugin-sdk/llm";
import { createCpaProvider } from "../src/provider.js";

const { CPA_BASE_URL, CPA_API_KEY } = process.env;
if (!CPA_BASE_URL || !CPA_API_KEY) throw new Error("Set CPA_BASE_URL and CPA_API_KEY to run the opt-in live test");
const config = { models: { providers: { cliproxyapi: { baseUrl: CPA_BASE_URL, models: [] } } } };
const cpa = createCpaProvider({ config, fetchRows: fetchLiveProviderModelRows, resolveAuth: async () => ({ apiKey: CPA_API_KEY }) });
const catalog = await cpa.discover({ config });
console.log(JSON.stringify({ discovered: catalog.models.length, rich: catalog.rich,
  reasoningContracts: [...new Set(catalog.models.map((m) => m.compat.supportedReasoningEfforts.join(",")))] }));
const cases = process.env.CPA_LIVE_CASES ? JSON.parse(process.env.CPA_LIVE_CASES) : [
  { id: "gpt-5.6-luna", level: "low" },
  { id: "grok-4.3", level: "off" },
  { id: "kimi-k3-256k", level: "high" },
];
for (const entry of cases) {
  const ctx = { config, modelId: entry.id, thinkingLevel: entry.level, extraParams: { cpaReasoningEffort: entry.exact } };
  const model = cpa.provider.resolveDynamicModel(ctx);
  assert.ok(model, `CPA did not advertise ${entry.id}`);
  let wireEffort;
  const capture = (m, messages, opts) => streamSimple(m, messages, { ...opts, onPayload: async (p, wireModel) => {
    const body = await opts.onPayload(p, wireModel);
    wireEffort = body.reasoning?.effort ?? body.reasoning_effort;
    return body;
  } });
  const stream = await cpa.provider.wrapStreamFn({ ...ctx, streamFn: capture })(model,
    { messages: [{ role: "user", content: "Reply with only the word OK.", timestamp: Date.now() }] },
    { apiKey: CPA_API_KEY, maxTokens: 512, signal: AbortSignal.timeout(60000) });
  const result = await stream.result();
  console.log(JSON.stringify({ id: entry.id, api: model.api, requested: entry.level, exact: entry.exact,
    wireEffort, stopReason: result.stopReason, output: result.content.filter((x) => x.type === "text").map((x) => x.text).join(""),
    inputTokens: result.usage?.input, outputTokens: result.usage?.output,
    // Do not print raw provider errors (they may contain upstream request data).
    error: result.stopReason === "error" ? "Upstream request failed" : undefined }));
  assert.notEqual(result.stopReason, "error", `Live request failed for ${entry.id}`);
  assert.notEqual(result.stopReason, "aborted", `Live request aborted for ${entry.id}`);
}
