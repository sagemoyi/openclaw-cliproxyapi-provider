import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// Plugin management identity is separate from model and auth references.
export const PLUGIN_ID = "openclaw-cliproxyapi-provider";
export const PROVIDER = "cliproxyapi";
export const SNAPSHOT = JSON.parse(readFileSync(new URL("../data/cpa-models.json", import.meta.url), "utf8"));
const ZERO_COST = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra", "auto"];
const BUDGETS = { minimal: 512, low: 1024, medium: 8192, high: 24576, xhigh: 32768, max: 128000 };
const TEMPLATE_EFFORTS = ["low", "medium", "high", "xhigh"];
const positive = (n) => Number.isSafeInteger(n) && n > 0 ? n : undefined;
const record = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const strings = (x) => Array.isArray(x) ? [...new Set(x.filter((s) => typeof s === "string").map((s) => s.trim().toLowerCase()).filter(Boolean))] : [];
const idOf = (row, key) => record(row) && typeof row[key] === "string" && row[key].trim() && !/[\x00-\x1f\x7f]/.test(row[key]) ? row[key].trim() : undefined;

export function normalizeBaseUrl(value) {
  if (typeof value !== "string" || !value.trim()) throw new Error("Set models.providers.cliproxyapi.baseUrl to your CPA endpoint");
  let url;
  try { url = new URL(value); } catch { throw new Error("CPA endpoint must be an absolute HTTP(S) URL"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("CPA endpoint must be HTTP(S), without embedded credentials, query or fragment");
  }
  const path = url.pathname.replace(/\/+$/, "");
  url.pathname = path.endsWith("/v1") ? path : path + "/v1";
  return url.toString().replace(/\/+$/, "");
}

export function readCatalogRows(body) {
  if (Array.isArray(body)) return body;
  if (!record(body)) throw new Error("CPA catalog must be a JSON object or array");
  if (Array.isArray(body.models)) return body.models;
  if (Array.isArray(body.data)) return body.data;
  throw new Error("CPA catalog must contain models[] or data[]");
}

function knownModel(id, owner, enabled) {
  if (!enabled) return undefined;
  const candidates = Object.hasOwn(SNAPSHOT.models, id) ? SNAPSHOT.models[id] : [];
  const matching = owner ? candidates.filter((m) => m.owner === owner) : candidates;
  // A reused ID owned by a different deployment/provider is not a native match.
  const rows = matching;
  // Keep only field-level consensus across plans/providers; never choose a larger context arbitrarily.
  if (!rows.length) return undefined;
  return Object.fromEntries(Object.entries(rows[0]).filter(([key, value]) =>
    rows.every((row) => JSON.stringify(row[key]) === JSON.stringify(value))));
}

function budgetEfforts(thinking) {
  const levels = Object.entries(BUDGETS).filter(([, value]) => value >= (thinking.min ?? 0) && value <= thinking.max).map(([name]) => name);
  if (thinking.zero_allowed) levels.unshift("none");
  if (thinking.dynamic_allowed) levels.push("auto");
  return levels;
}

export function projectModel(basic, rich, { useBundledMetadata = true } = {}) {
  const id = idOf(basic, "id");
  if (!id) throw new Error("CPA returned an invalid model ID");
  const native = knownModel(id, basic.owned_by, useBundledMetadata);
  // CPA hides image/video models in the Codex catalog. Do not expose them as chat models.
  if (String(rich?.visibility ?? "").trim().toLowerCase() === "hide" || native?.type === "openai-image" ||
      (useBundledMetadata && SNAPSHOT.nonTextModelIds?.includes(id))) return null;
  const warnings = [];
  let source = rich ? "cpa-live" : native ? "cpa-bundled" : "conservative-default";
  let efforts = Array.isArray(rich?.supported_reasoning_levels)
    ? [...new Set(rich.supported_reasoning_levels.map((x) => typeof x === "string" ? x : x?.effort)
      .filter((x) => typeof x === "string").map((x) => x.trim().toLowerCase()).filter((x) => EFFORTS.includes(x)))]
    : undefined;
  if (native?.thinking === null && (!efforts || JSON.stringify(efforts) === JSON.stringify(TEMPLATE_EFFORTS))) {
    efforts = [];
    source = "cpa-live+bundled";
    warnings.push("Reasoning template corrected using CPA native metadata");
  } else if (native?.thinking && !native.thinking.levels?.length && native.thinking.max > 0) {
    // The Codex projection loses token-budget-only thinking. CPA accepts these effort-to-budget conversions.
    if (!efforts?.length) {
      efforts = budgetEfforts(native.thinking);
      source = "cpa-live+bundled";
      warnings.push("Reasoning levels derived from CPA token-budget conversion");
    }
  } else if (efforts === undefined && native?.thinking?.levels) {
    efforts = native.thinking.levels.filter((x) => EFFORTS.includes(x));
    source = "cpa-live+bundled";
  }
  if (efforts === undefined) {
    efforts = [];
    warnings.push("Reasoning controls unknown; no effort will be injected");
  }
  if (!native && rich) warnings.push("CPA metadata may include synthesized template defaults; native provenance is not exposed");
  if (native?.thinking?.levels && efforts.some((effort) => !native.thinking.levels.includes(effort))) {
    warnings.push("Live advertised reasoning levels differ from the bundled CPA request-validation metadata; advertised controls may be rejected by the server");
  }
  if (efforts.includes("ultra")) warnings.push("CPA advertises ultra, which may be rejected by its request validator; logical /think ultra maps to max, not raw ultra");
  const contextWindow = positive(rich?.context_window) ?? native?.contextWindow ?? 32768;
  const maxTokens = Math.min(positive(rich?.max_tokens) ?? native?.maxTokens ?? 4096, contextWindow);
  if (!positive(rich?.max_tokens) && !native?.maxTokens) warnings.push("Output limit unknown; conservative 4096-token fallback");
  if (!positive(rich?.context_window) && !native?.contextWindow) warnings.push("Context limit unknown; conservative 32768-token fallback");
  const input = strings(rich?.input_modalities ?? native?.input).filter((x) => ["text", "image"].includes(x));
  if (!input.includes("text")) input.unshift("text");
  // The ordinary list carries ownership; CPA's rich projection omits it. Aliases remain literal.
  const api = native?.type === "codex" || basic.owned_by === "openai" ? "openai-responses" : "openai-completions";
  const reasoning = efforts.some((x) => x !== "none");
  const advertisedDefault = typeof rich?.default_reasoning_level === "string"
    ? rich.default_reasoning_level.trim().toLowerCase() : undefined;
  const defaultEffort = efforts.includes(advertisedDefault) ? advertisedDefault
    : efforts.includes("medium") ? "medium" : efforts.find((x) => x !== "none") ?? "none";
  return {
    id,
    name: typeof rich?.display_name === "string" && rich.display_name.trim() ? rich.display_name : id,
    api, reasoning, input, contextWindow, maxTokens, cost: { ...ZERO_COST },
    compat: {
      supportsReasoningEffort: reasoning,
      supportedReasoningEfforts: efforts,
      thinkingFormat: "openai",
      supportsStore: false,
      supportsDeveloperRole: api === "openai-responses",
      supportsUsageInStreaming: true,
      supportsStrictMode: false,
      maxTokensField: "max_tokens",
    },
    params: { cpa: { source, defaultEffort, nativeReasoningEfforts: native?.thinking?.levels,
      maxContextWindow: positive(rich?.max_context_window), warnings } },
  };
}

export function projectCatalog(basicRows, richRows, options) {
  const richById = new Map();
  for (const row of richRows) {
    const id = idOf(row, "slug") || idOf(row, "id");
    if (!id) throw new Error("CPA rich catalog contains an invalid row");
    if (richById.has(id)) throw new Error("CPA rich catalog contains duplicate IDs");
    richById.set(id, row);
  }
  const seen = new Set();
  const models = [];
  for (const row of basicRows) {
    const id = idOf(row, "id");
    if (!id) throw new Error("CPA model list contains an invalid row");
    if (seen.has(id)) continue;
    seen.add(id);
    // Plain list is the availability authority; metadata never resurrects a removed model.
    const model = projectModel(row, richById.get(id), options);
    if (model) models.push(model);
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

/** A caller owns its wait, not the shared, timeout-bounded acquisition. */
function waitForCatalog(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const cancelled = () => {
      signal.removeEventListener("abort", cancelled);
      reject(signal.reason);
    };
    signal.addEventListener("abort", cancelled, { once: true });
    pending.then((value) => {
      signal.removeEventListener("abort", cancelled);
      resolve(value);
    }, (error) => {
      signal.removeEventListener("abort", cancelled);
      reject(error);
    });
  });
}

export class CatalogClient {
  constructor({ fetchRows, now = Date.now, ttlMs = 60000, staleMs = 300000, timeoutMs = 10000, useBundledMetadata = true, warn = () => {} }) {
    Object.assign(this, { fetchRows, now, ttlMs, staleMs, timeoutMs, useBundledMetadata, warn });
    this.entries = new Map();
  }
  key(baseUrl, apiKey) {
    return createHash("sha256").update(baseUrl).update("\0").update(apiKey ?? "").digest("hex");
  }
  peek(baseUrl, apiKey) {
    return this.peekByKey(this.key(normalizeBaseUrl(baseUrl), apiKey));
  }
  peekByKey(key) {
    const entry = this.entries.get(key);
    return entry?.value && this.now() - entry.at <= this.ttlMs + this.staleMs
      ? { ...entry.value, stale: this.now() - entry.at >= this.ttlMs } : undefined;
  }
  async get({ baseUrl, apiKey, signal, force = false }) {
    signal?.throwIfAborted();
    baseUrl = normalizeBaseUrl(baseUrl);
    const key = this.key(baseUrl, apiKey);
    let entry = this.entries.get(key);
    if (!entry) {
      // Bound memory when users rotate many keys/endpoints in one process.
      if (this.entries.size >= 16) this.entries.delete(this.entries.keys().next().value);
      entry = { at: 0, retryAt: 0 };
      this.entries.set(key, entry);
    }
    if (entry.pending) return waitForCatalog(entry.pending, signal);
    if (!force && entry.value && this.now() - entry.at < this.ttlMs) return entry.value;
    if (!force && this.now() < entry.retryAt) {
      if (entry.value && this.now() - entry.at <= this.ttlMs + this.staleMs) return { ...entry.value, stale: true };
      throw entry.error;
    }
    // apiKey is already resolved by discover(). The SDK must not reinterpret its
    // bytes as an environment/SecretRef marker. It still owns SSRF and body limits.
    const requestSignal = AbortSignal.timeout(this.timeoutMs);
    const fetch = (suffix) => this.fetchRows({ providerId: PROVIDER, endpoint: baseUrl + suffix, apiKey,
      discoveryApiKey: apiKey, signal: requestSignal, timeoutMs: this.timeoutMs,
      readRows: readCatalogRows, requireHttps: false });
    entry.pending = (async () => {
      try {
        const results = await Promise.allSettled([fetch("/models"), fetch("/models?client_version=")]);
        // Authentication failure on either endpoint must invalidate stale metadata.
        const authError = results.find((r) => r.status === "rejected" && [401, 403].includes(r.reason?.status));
        if (authError) throw authError.reason;
        if (results[0].status === "rejected") throw results[0].reason;
        const basic = results[0].value;
        let rich = [];
        if (results[1].status === "fulfilled") {
          const rows = results[1].value;
          // Older CPA servers ignore the query parameter and return the ordinary list.
          if (rows.length && rows.every((r) => idOf(r, "id") && !r.slug &&
            !["supported_reasoning_levels", "default_reasoning_level", "context_window", "max_context_window",
              "max_tokens", "input_modalities", "visibility", "display_name", "name"].some((key) => Object.hasOwn(r, key)))) {
            this.warn("CPA has no rich catalog; using exact bundled metadata and conservative defaults");
          } else rich = rows;
        } else if ([404, 405].includes(results[1].reason?.status)) {
          this.warn("CPA rich catalog unavailable; using exact bundled metadata and conservative defaults");
        } else throw results[1].reason;
        const models = projectCatalog(basic, rich, this);
        entry.at = this.now();
        entry.retryAt = 0;
        entry.error = undefined;
        entry.value = { models, baseUrl, fetchedAt: entry.at, stale: false, rich: rich.length > 0,
          revision: createHash("sha256").update(JSON.stringify(models)).digest("hex") };
        return entry.value;
      } catch (error) {
        const authFailure = [401, 403].includes(error?.status);
        if (authFailure) entry.value = undefined;
        // Error bodies/URLs can contain secrets. Expose only bounded, controlled diagnostics.
        const safe = new Error(`CPA discovery failed${error?.status ? ` (HTTP ${error.status})` : " (network or invalid catalog)"}`);
        safe.status = error?.status;
        entry.error = safe;
        entry.retryAt = this.now() + Math.min(this.ttlMs, 10000);
        if (!authFailure && entry.value && this.now() - entry.at <= this.ttlMs + this.staleMs) {
          this.warn(`${safe.message}; temporarily using last successful catalog`);
          return { ...entry.value, stale: true };
        }
        throw safe;
      } finally { entry.pending = undefined; }
    })();
    return waitForCatalog(entry.pending, signal);
  }
}
