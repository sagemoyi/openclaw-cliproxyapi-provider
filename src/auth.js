import { PROVIDER } from "./catalog.js";

/** Keep legacy hosts compatible while honoring an explicit modern default policy. */
export function buildAuthModelAccessPatch(config) {
  const wildcard = `${PROVIDER}/*`;
  const defaults = config.agents?.defaults;
  const allow = defaults?.modelPolicy?.allow;
  return { defaults: {
    models: { [wildcard]: defaults?.models?.[wildcard] ?? {} },
    // Do not introduce a new policy on legacy hosts or replace other allowed models.
    ...(Array.isArray(allow) ? { modelPolicy: {
      allow: allow.includes(wildcard) ? [...allow] : [...allow, wildcard],
    } } : {}),
  } };
}
