import { PROVIDER } from "./catalog.js";
import { mergeExplicit } from "./provider.js";

/** All catalog writes and locking stay in the host. Never write openclaw.json. */
export async function materializeCatalog(config, snapshot, runtime) {
  if (snapshot.stale) return { synced: false, reason: "stale" };
  let rows, mode;
  if (typeof runtime.loadPreparedModelCatalog === "function") {
    // September SDK: refresh the published inventory on its real lifecycle owner.
    // Do not create a synthetic config generation in the new atomic runtime.
    rows = await runtime.loadPreparedModelCatalog({ config, readOnly: false, refreshFullCatalog: true });
    mode = "prepared";
  } else if (typeof runtime.loadModelCatalog === "function") {
    // July SDK: the legacy source fingerprint otherwise has no discovery TTL.
    // A temporary config view with the new models lets the official loader own
    // persistence, secret handling and the plugin catalog sidecar. It does not
    // invalidate the separate, private Gateway models.list cache (see research).
    const provider = config.models?.providers?.[PROVIDER];
    const view = { ...config, models: { ...config.models, providers: { ...config.models?.providers,
      [PROVIDER]: { ...provider, baseUrl: snapshot.baseUrl,
        models: snapshot.models.map((model) => mergeExplicit(model, config)) },
    } } };
    rows = await runtime.loadModelCatalog({ config: view, useCache: false });
    mode = "legacy";
  } else throw new Error("This OpenClaw version has no supported catalog publication API");
  const published = new Set(rows.filter((r) => r.provider === PROVIDER).map((r) => r.id));
  if (snapshot.models.some((m) => !published.has(m.id))) throw new Error("OpenClaw did not publish the complete CPA catalog; sync will retry");
  return { synced: true, models: snapshot.models.length, revision: snapshot.revision, mode,
    ...(mode === "legacy" ? { pickerRefresh: "Existing Gateway models.list caches require a Gateway restart/config reload" } : {}) };
}
