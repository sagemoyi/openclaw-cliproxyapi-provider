import { CatalogClient, PROVIDER, EFFORTS, normalizeBaseUrl } from "./catalog.js";

const toLevel = (effort) => effort === "none" ? "off" : effort === "auto" ? "adaptive" : effort;
const toEffort = (level) => level === "off" ? "none" : level === "adaptive" ? "auto" : level;

export function thinkingProfile(model) {
  const efforts = model?.compat?.supportedReasoningEfforts ?? [];
  // OpenClaw's embedded runner uses ultra as an orchestration mode and sends max.
  const usable = efforts.filter((x) => EFFORTS.includes(x) && x !== "ultra");
  const levels = usable.map((x) => ({ id: toLevel(x) }));
  if (!levels.length || model?.reasoning === false) return { levels: [{ id: "off" }], defaultLevel: "off" };
  const preferred = toLevel(model?.params?.cpa?.defaultEffort);
  return { levels, defaultLevel: levels.some((x) => x.id === preferred) ? preferred : levels[0].id };
}

export function selectEffort(model, requested, exact) {
  const supported = model.compat?.supportedReasoningEfforts ?? [];
  if (exact !== undefined) {
    if (typeof exact !== "string" || !supported.includes(exact)) throw new Error("cpaReasoningEffort is not advertised by the selected CPA model");
    return exact;
  }
  if (!model.reasoning) return undefined;
  const wanted = toEffort(requested);
  if (supported.includes(wanted)) return wanted;
  // off cannot mean 'omit' for an always-thinking model: omission lets CPA use its default.
  // Fall back by strength for stale session settings, matching OpenClaw's thinking profiles.
  if (wanted && !["none", "auto"].includes(wanted)) {
    const rank = EFFORTS.indexOf(wanted);
    const lower = supported.filter((x) => !["none", "auto", "ultra"].includes(x) && EFFORTS.indexOf(x) <= rank)
      .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
    if (lower.length) return lower.at(-1);
  }
  const fallback = model.params?.cpa?.defaultEffort;
  return supported.includes(fallback) ? fallback : supported.find((x) => x !== "ultra");
}

export function patchPayload(payload, api, effort) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("CPA transport produced an invalid payload");
  if (api === "openai-responses") {
    // Keep the host's other reasoning settings, but never force a summary on a model with no controls.
    if (effort === undefined) delete payload.reasoning;
    else payload.reasoning = { ...(payload.reasoning ?? {}), effort };
  } else {
    if (effort === undefined) delete payload.reasoning_effort;
    else payload.reasoning_effort = effort;
  }
  return payload;
}

export function mergeExplicit(model, config) {
  const provider = config?.models?.providers?.[PROVIDER];
  const explicit = provider?.models?.find((m) => m.id === model.id);
  const merged = { ...model, ...explicit, api: explicit?.api ?? provider?.api ?? model.api,
    compat: { ...model.compat, ...explicit?.compat }, params: { ...model.params, ...explicit?.params } };
  if (merged.reasoning === false) merged.compat.supportsReasoningEffort = false;
  return merged;
}

export function createCpaProvider({ fetchRows, resolveAuth, config = {}, logger = { warn() {} }, now, replayHooks = {} }) {
  const settings = config.plugins?.entries?.[PROVIDER]?.config ?? {};
  const client = new CatalogClient({ fetchRows, now, ttlMs: (settings.refreshSeconds ?? 60) * 1000,
    staleMs: (settings.staleSeconds ?? 300) * 1000, timeoutMs: settings.timeoutMs ?? 10000,
    useBundledMetadata: settings.useBundledMetadata ?? true, warn: (m) => logger.warn(m) });
  const bindings = new Map();
  const scope = (ctx, baseUrl) => `${ctx.agentDir ?? ""}\0${baseUrl}`;
  const endpoint = (ctx) => normalizeBaseUrl((ctx.config ?? config).models?.providers?.[PROVIDER]?.baseUrl);
  function remember(ctx, baseUrl, apiKey) {
    const key = scope(ctx, baseUrl);
    if (bindings.size >= 16 && !bindings.has(key)) bindings.delete(bindings.keys().next().value);
    bindings.set(key, { ctx, baseUrl, apiKey });
  }
  async function discover(ctx = {}, { force = false, apiKey } = {}) {
    const cfg = ctx.config ?? config;
    if (!cfg.models?.providers?.[PROVIDER]?.baseUrl) return null;
    const baseUrl = endpoint(ctx);
    let persistedKey;
    if (!apiKey) {
      const auth = ctx.resolveProviderAuth?.(PROVIDER) ?? ctx.resolveProviderApiKey?.(PROVIDER);
      persistedKey = auth?.apiKey;
      apiKey = auth?.discoveryApiKey ?? auth?.apiKey;
      if (!apiKey) apiKey = (await resolveAuth({ provider: PROVIDER, cfg, agentDir: ctx.agentDir, workspaceDir: ctx.workspaceDir }))?.apiKey;
    }
    if (!apiKey) return null;
    remember(ctx, baseUrl, apiKey);
    const value = await client.get({ baseUrl, apiKey, force, signal: ctx.signal });
    return { ...value, persistedKey: persistedKey ?? apiKey };
  }
  function current(ctx) {
    let baseUrl;
    try { baseUrl = endpoint(ctx); } catch { return undefined; }
    const binding = bindings.get(scope(ctx, baseUrl));
    return binding ? client.peek(baseUrl, binding.apiKey) : undefined;
  }
  function runtimeModel(model, ctx, baseUrl) {
    return { ...mergeExplicit(model, ctx.config ?? config), provider: PROVIDER, baseUrl };
  }
  function wrap(ctx) {
    if (!ctx.streamFn) return undefined;
    return async (model, messages, options = {}) => {
      const snapshot = await discover({ ...ctx, signal: options.signal }, { apiKey: options.apiKey });
      if (!snapshot) throw new Error("CPA is not configured; set endpoint and credentials");
      const row = snapshot.models.find((m) => m.id === model.id);
      if (!row) throw new Error(`Model is no longer advertised by CPA: ${model.id}`);
      const resolved = runtimeModel(row, ctx, snapshot.baseUrl);
      const effort = selectEffort(resolved, ctx.thinkingLevel ?? options.reasoning,
        ctx.extraParams?.cpaReasoningEffort ?? resolved.params?.cpaReasoningEffort);
      return ctx.streamFn({ ...model, ...resolved }, messages, { ...options,
        onPayload: async (payload, wireModel) => {
          const previous = await options.onPayload?.(payload, wireModel);
          return patchPayload(previous ?? payload, resolved.api, effort);
        },
      });
    };
  }
  const provider = {
    id: PROVIDER, label: "CLIProxyAPI", envVars: ["CPA_API_KEY"], auth: [], ...replayHooks,
    catalog: { order: "simple", async run(ctx) {
      const snapshot = await discover(ctx);
      if (!snapshot) return null;
      return { provider: { baseUrl: snapshot.baseUrl, apiKey: snapshot.persistedKey, api: "openai-completions", models: snapshot.models } };
    } },
    staticCatalog: { order: "simple", async run() { return null; } },
    async prepareDynamicModel(ctx) { await discover(ctx); },
    resolveDynamicModel(ctx) {
      const snapshot = current(ctx);
      const row = snapshot?.models.find((m) => m.id === ctx.modelId);
      return row ? runtimeModel(row, ctx, snapshot.baseUrl) : undefined;
    },
    normalizeResolvedModel(ctx) {
      const snapshot = current(ctx);
      const row = snapshot?.models.find((m) => m.id === ctx.modelId);
      return row ? { ...ctx.model, ...runtimeModel(row, ctx, snapshot.baseUrl) } : undefined;
    },
    resolveThinkingProfile(ctx) {
      // Prefer current model metadata passed by the host, which includes explicit user overrides.
      if (ctx.compat?.supportedReasoningEfforts) return thinkingProfile(ctx);
      const snapshots = [...bindings.values()].map((b) => client.peek(b.baseUrl, b.apiKey)).filter(Boolean);
      if (snapshots.length === 1) return thinkingProfile(snapshots[0].models.find((m) => m.id === ctx.modelId));
      return thinkingProfile(ctx);
    },
    wrapStreamFn: wrap,
    wrapSimpleCompletionStreamFn: wrap,
    buildUnknownModelHint() { return " Check `openclaw cpa catalog`; CPA availability can change with account health and quota."; },
  };
  return { provider, client, discover, current, async refreshKnown() {
    const results = await Promise.allSettled([...bindings.values()].map((b) => discover(b.ctx, { force: true })));
    for (const result of results) if (result.status === "rejected") logger.warn(result.reason.message);
  } };
}
