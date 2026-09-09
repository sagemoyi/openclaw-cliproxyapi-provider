import { CatalogClient, PLUGIN_ID, PROVIDER, EFFORTS, normalizeBaseUrl } from "./catalog.js";

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
  if (!model.reasoning || model.compat?.supportsReasoningEffort === false) {
    if (exact !== undefined) throw new Error("cpaReasoningEffort conflicts with disabled reasoning controls");
    return undefined;
  }
  if (exact !== undefined) {
    if (typeof exact !== "string" || !supported.includes(exact)) throw new Error("cpaReasoningEffort is not advertised by the selected CPA model");
    return exact;
  }
  // Logical /think ultra belongs to OpenClaw orchestration. Raw CPA ultra
  // is an explicitly opted-in wire override only (handled above).
  const wanted = toEffort(requested === "ultra" ? "max" : requested);
  if (supported.includes(wanted)) return wanted;
  // off cannot mean 'omit' for an always-thinking model: omission lets CPA use its default.
  // Fall back by strength for stale session settings, matching OpenClaw's thinking profiles.
  if (wanted && !["none", "auto"].includes(wanted)) {
    const rank = EFFORTS.indexOf(wanted);
    const lower = supported.filter((x) => !["none", "auto", "ultra"].includes(x) && EFFORTS.indexOf(x) <= rank)
      .sort((a, b) => EFFORTS.indexOf(a) - EFFORTS.indexOf(b));
    if (lower.length) return lower.at(-1);
  }
  const advertisedDefault = model.params?.cpa?.defaultEffort;
  const fallback = advertisedDefault === "ultra" ? "max" : advertisedDefault;
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

export function createCpaProvider({ fetchRows, resolveAuth, config = {}, logger = { warn() {} }, now, replayHooks = {}, isApiKeyMarker }) {
  const settings = config.plugins?.entries?.[PLUGIN_ID]?.config ?? {};
  const client = new CatalogClient({ fetchRows, now, ttlMs: (settings.refreshSeconds ?? 60) * 1000,
    staleMs: (settings.staleSeconds ?? 300) * 1000, timeoutMs: settings.timeoutMs ?? 10000,
    useBundledMetadata: settings.useBundledMetadata ?? true, warn: (m) => logger.warn(m) });
  const bindings = new Map();
  const scope = (ctx, baseUrl) => JSON.stringify([ctx.agentDir, ctx.workspaceDir, ctx.authProfileId, baseUrl]);
  const endpoint = (ctx) => normalizeBaseUrl((ctx.config ?? config).models?.providers?.[PROVIDER]?.baseUrl);
  function remember(ctx, baseUrl, apiKey) {
    const key = scope(ctx, baseUrl);
    if (bindings.size >= 16 && !bindings.has(key)) bindings.delete(bindings.keys().next().value);
    // Keep only the cache fingerprint, not a second copy of credentials/config.
    bindings.set(key, client.key(baseUrl, apiKey));
  }
  async function discover(ctx = {}, { force = false, apiKey } = {}) {
    ctx.signal?.throwIfAborted();
    // Scoped catalog reads must remain scoped even when this plugin is enabled.
    if (ctx.providerIds && !ctx.providerIds.includes(PROVIDER)) return null;
    const cfg = ctx.config ?? config;
    if (!cfg.models?.providers?.[PROVIDER]?.baseUrl) return null;
    const baseUrl = endpoint(ctx);
    let persistedKey;
    if (!apiKey) {
      const resolver = ctx.resolveProviderAuth ?? ctx.resolveProviderApiKey;
      if (resolver) {
        // A host-owned selection is authoritative; never retry it using another
        // profile or a new auth generation after preparation failed or returned none.
        const auth = resolver(PROVIDER);
        if (auth?.preparationFailed) {
          bindings.delete(scope(ctx, baseUrl));
          throw new Error("CPA credential preparation failed; check OpenClaw provider authentication");
        }
        persistedKey = auth?.apiKey;
        apiKey = auth?.discoveryApiKey;
        if (!apiKey && auth?.apiKey) {
          // Only the host knows its marker grammar. Fail closed without that
          // classifier; do not send an unresolved placeholder to the server.
          if (!isApiKeyMarker || isApiKeyMarker(auth.apiKey)) {
            bindings.delete(scope(ctx, baseUrl));
            throw new Error("CPA discovery requires resolved credentials, not an auth marker");
          }
          apiKey = auth.apiKey;
        }
      } else {
        apiKey = (await resolveAuth({ provider: PROVIDER, cfg, agentDir: ctx.agentDir,
          workspaceDir: ctx.workspaceDir, profileId: ctx.authProfileId }))?.apiKey;
      }
    }
    ctx.signal?.throwIfAborted();
    if (!apiKey) {
      bindings.delete(scope(ctx, baseUrl));
      return null;
    }
    remember(ctx, baseUrl, apiKey);
    const value = await client.get({ baseUrl, apiKey, force, signal: ctx.signal });
    return { ...value, persistedKey: persistedKey ?? apiKey };
  }
  function current(ctx) {
    let baseUrl;
    try { baseUrl = endpoint(ctx); } catch { return undefined; }
    const binding = bindings.get(scope(ctx, baseUrl));
    return binding ? client.peekByKey(binding) : undefined;
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
    async prepareDynamicModel(ctx) {
      const snapshot = await discover(ctx);
      const row = snapshot?.models.find((m) => m.id === ctx.modelId);
      return row ? runtimeModel(row, ctx, snapshot.baseUrl) : undefined;
    },
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
      // This hook has no agent/endpoint/auth scope. Only host-supplied facts are
      // safe; a process-wide "only cached model" is not the selected model.
      if (ctx.reasoning === false || Array.isArray(ctx.compat?.supportedReasoningEfforts)) return thinkingProfile(ctx);
      return undefined;
    },
    wrapStreamFn: wrap,
    wrapSimpleCompletionStreamFn: wrap,
    buildUnknownModelHint() { return " Check `openclaw cpa catalog`; CPA availability can change with account health and quota."; },
  };
  return { provider, client, discover, current };
}
