import { PROVIDER } from "./catalog.js";

/** All catalog writes and locking stay in the host. Never write openclaw.json. */
export async function materializeCatalog(config, snapshot, runtime, ctx = {}) {
  if (snapshot.stale) return { synced: false, reason: "stale" };
  if (typeof runtime.loadPreparedModelCatalog !== "function") {
    throw new Error("This plugin targets OpenClaw 2026.9.8. Older hosts should install the plugin release built for that host.");
  }
  // Refresh the published inventory on its real lifecycle owner.
  // Do not create a synthetic config generation in the atomic runtime.
  const rows = await runtime.loadPreparedModelCatalog({ config, readOnly: false, refreshFullCatalog: true,
    ...(ctx.agentId ? { agentId: ctx.agentId } : {}),
    ...(ctx.agentDir ? { agentDir: ctx.agentDir } : {}),
    ...(ctx.workspaceDir ? { workspaceDir: ctx.workspaceDir } : {}),
  });
  const published = new Set(rows.filter((r) => r.provider === PROVIDER).map((r) => r.id));
  if (snapshot.models.some((m) => !published.has(m.id))) throw new Error("OpenClaw did not publish the complete CPA catalog; sync will retry");
  const allowed = new Set([...snapshot.models, ...(config.models?.providers?.[PROVIDER]?.models ?? [])].map((m) => m.id));
  if ([...published].some((id) => !allowed.has(id))) throw new Error("OpenClaw retained removed CPA models; sync will retry");
  return { synced: true, models: snapshot.models.length, revision: snapshot.revision, mode: "prepared" };
}
