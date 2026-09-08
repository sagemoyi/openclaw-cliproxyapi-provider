import { createHash } from "node:crypto";

/** Serialize discovery + publication, so an older write cannot finish last. */
export function createCatalogSynchronizer({ discover, publish, config }) {
  let tail = Promise.resolve();
  let publishedKey;
  return (ctx, force = false) => {
    const run = tail.then(async () => {
      const snapshot = await discover(ctx, { force });
      if (!snapshot) return { synced: false, reason: "unconfigured" };
      if (snapshot.stale) return { synced: false, reason: "stale" };
      const currentConfig = ctx.config ?? config;
      // Hash rather than retain serialized config: it may contain credentials.
      const key = createHash("sha256").update(JSON.stringify([
        snapshot.baseUrl, snapshot.revision, ctx.agentDir, currentConfig,
      ])).digest("hex");
      if (!force && key === publishedKey) return { synced: false, reason: "unchanged" };
      const result = await publish(currentConfig, snapshot);
      if (result.synced) publishedKey = key;
      return result;
    });
    tail = run.catch(() => {});
    return run;
  };
}

/** One loop per service generation; stop also waits for startup discovery. */
export function createCatalogService({ sync, intervalMs, schedule = setTimeout, cancel = clearTimeout }) {
  let generation = 0;
  let active = false;
  let timer;
  let pending = Promise.resolve();
  return {
    id: "cliproxyapi-catalog",
    async start(ctx) {
      if (active) return pending;
      active = true;
      const mine = ++generation;
      const tick = () => {
        if (!active || mine !== generation) return Promise.resolve();
        pending = Promise.resolve().then(() => sync(ctx)).catch(() => {
          ctx.logger.warn("CPA catalog sync failed; retrying on the next interval");
        }).finally(() => {
          if (active && mine === generation) {
            timer = schedule(tick, intervalMs);
            timer.unref?.();
          }
        });
        return pending;
      };
      await tick();
    },
    async stop() {
      active = false;
      generation++;
      cancel(timer);
      await pending;
    },
  };
}
