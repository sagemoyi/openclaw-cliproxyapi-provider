// Developer maintenance utility. Fetch data from a pinned upstream commit, not executable code.
import { writeFile, rename } from "node:fs/promises";
import { randomUUID } from "node:crypto";
const commit = process.argv[2];
if (!/^[a-f0-9]{40}$/.test(commit ?? "")) throw new Error("Usage: node scripts/update-metadata.mjs <40-character CPA commit SHA>");
const base = `https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/${commit}/internal/registry/`;
const fetchText = async (file) => {
  const res = await fetch(base + file, { signal: AbortSignal.timeout(30000), redirect: "error" });
  if (!res.ok) throw new Error(`Metadata download failed: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > 4 * 1024 * 1024) throw new Error("Metadata response too large");
  return text;
};
const [json, definitions] = await Promise.all([fetchText("models/models.json"), fetchText("model_definitions.go")]);
const models = {};
for (const rows of Object.values(JSON.parse(json))) {
  if (!Array.isArray(rows)) continue;
  for (const m of rows) {
    if (typeof m.id !== "string" || ["__proto__", "constructor", "prototype"].includes(m.id)) continue;
    const value = { type: m.type, owner: m.owned_by, contextWindow: m.context_length ?? m.inputTokenLimit,
      maxTokens: m.max_completion_tokens ?? m.outputTokenLimit,
      input: m.supportedInputModalities?.map((x) => x.toLowerCase()), thinking: m.thinking ?? null };
    models[m.id] ??= [];
    if (!models[m.id].some((e) => JSON.stringify(e) === JSON.stringify(value))) models[m.id].push(value);
  }
}
const nonTextModelIds = [...definitions.matchAll(/(?:codex|xai)Builtin\w*ID\s*=\s*"([^"]+)"/g)].map((match) => match[1]);
if (!Object.keys(models).length || !nonTextModelIds.length) throw new Error("Upstream metadata format changed; inspect before updating");
const data = { source: "https://github.com/router-for-me/CLIProxyAPI", commit,
  path: "internal/registry/models/models.json", nonTextSource: "internal/registry/model_definitions.go", nonTextModelIds, models };
const destination = new URL("../data/cpa-models.json", import.meta.url);
const temporary = new URL(`../data/.cpa-models-${randomUUID()}.json`, import.meta.url);
await writeFile(temporary, JSON.stringify(data, null, 2) + "\n");
await rename(temporary, destination);
console.log(`Updated ${Object.keys(models).length} exact model IDs from ${commit}. Review the diff and run npm test.`);
