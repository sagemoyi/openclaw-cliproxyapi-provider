import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { fetchLiveProviderModelRows } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import { isNonSecretApiKeyMarker } from "openclaw/plugin-sdk/provider-auth";
import { resolveApiKeyForProvider } from "openclaw/plugin-sdk/provider-auth-runtime";
import { buildProviderReplayFamilyHooks } from "openclaw/plugin-sdk/provider-model-shared";
import { createCpaProvider, mergeExplicit } from "./src/provider.js";
import { PROVIDER, normalizeBaseUrl } from "./src/catalog.js";
import { buildAuthModelAccessPatch } from "./src/auth.js";
import { materializeCatalog } from "./src/sync.js";
import { createCatalogSynchronizer, createCatalogService } from "./src/lifecycle.js";

export default definePluginEntry({
  id: PROVIDER,
  name: "OpenClaw CLIProxyAPI Provider",
  description: "Discover CPA models and capabilities without hand-maintained model lists",
  register(api) {
    const cpa = createCpaProvider({ config: api.config, logger: api.logger, fetchRows: fetchLiveProviderModelRows,
      resolveAuth: resolveApiKeyForProvider, isApiKeyMarker: isNonSecretApiKeyMarker, replayHooks: buildProviderReplayFamilyHooks({ family: "openai-compatible" }) });
    cpa.provider.auth = [{
      id: "api-key", label: "CPA endpoint and API key", kind: "api_key",
      async run(ctx) {
        const baseUrl = normalizeBaseUrl(await ctx.prompter.text({ message: "CPA endpoint",
          initialValue: ctx.config.models?.providers?.[PROVIDER]?.baseUrl ?? "http://127.0.0.1:8317/v1",
          validate(value) { try { normalizeBaseUrl(value); } catch (e) { return e.message; } } }));
        const key = (await ctx.prompter.text({ message: "CPA API key", sensitive: true,
          validate: (v) => v.trim() ? undefined : "API key is required" })).trim();
        const providerConfig = { ...ctx.config.models?.providers?.[PROVIDER], baseUrl,
          models: ctx.config.models?.providers?.[PROVIDER]?.models ?? [] };
        const config = { ...ctx.config, models: { ...ctx.config.models, providers: { ...ctx.config.models?.providers,
          [PROVIDER]: providerConfig } } };
        const catalog = await cpa.discover({ ...ctx, config }, { apiKey: key, force: true });
        return {
          profiles: [{ profileId: `${PROVIDER}:default`, credential: { type: "api_key", provider: PROVIDER, key } }],
          configPatch: { models: { providers: { [PROVIDER]: { baseUrl, models: providerConfig.models } } },
            agents: buildAuthModelAccessPatch(ctx.config) },
          notes: [`Discovered ${catalog.models.length} text models. Select one with openclaw models set cliproxyapi/<model-id>.`],
        };
      },
    }];
    api.registerProvider(cpa.provider);
    api.registerModelCatalogProvider({ provider: PROVIDER, kinds: ["text"],
      staticCatalog: () => [],
      async liveCatalog(ctx) {
        const snapshot = await cpa.discover(ctx);
        return snapshot?.models.map((row) => {
          const model = mergeExplicit(row, ctx.config);
          return { kind: "text", provider: PROVIDER, model: model.id, label: model.name, source: "live" };
        }) ?? [];
      },
    });
    const sync = createCatalogSynchronizer({
      discover: cpa.discover, config: api.config,
      publish: async (config, snapshot, ctx) => materializeCatalog(config, snapshot,
        await import("openclaw/plugin-sdk/agent-runtime"), ctx),
    });
    api.registerService(createCatalogService({ sync, intervalMs: cpa.client.ttlMs }));
    api.registerCli(({ program, config }) => {
      const command = program.command("cpa").description("CLIProxyAPI model discovery diagnostics");
      command.command("sync").description("Refresh OpenClaw model catalog state without editing configuration")
        .action(async () => console.log(JSON.stringify(await sync({ config }, true), null, 2)));
      command.command("catalog").description("Fetch the live catalog, including metadata sources and limitations")
        .action(async () => {
          const result = await cpa.discover({ config }, { force: true });
          if (!result) throw new Error("Configure models.providers.cliproxyapi.baseUrl and CPA credentials first");
          // Only publish diagnostic fields, excluding endpoint and auth state.
          const { models, fetchedAt, stale, rich, revision } = result;
          console.log(JSON.stringify({ models, fetchedAt, stale, rich, revision }, null, 2));
        });
    }, { commands: ["cpa"] });
  },
});
