import { realpathSync } from "node:fs";
import path from "node:path";

// 2026.9.5's installer reports spurious ownership conflicts when the running CLI itself
// lives inside the linked package (npm run prefers ./node_modules/.bin). Spawn the
// first PATH entry that resolves outside the repository instead.
export function resolveHostCli(cwd = process.cwd(), pathEnv = process.env.PATH ?? "") {
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "openclaw");
    let real;
    try { real = realpathSync(candidate); } catch { continue; }
    if (real !== cwd && !real.startsWith(cwd + path.sep)) return candidate;
  }
  return "openclaw";
}
// Install only the checked-out source into the caller's isolated test state.
export async function installHostPlugin(cli) {
  const help = (await cli("plugins", "install", "--help")).stdout;
  // July rejects --force with --link; newer hosts use it for source consent.
  const args = [];
  if (/Confirm non-ClawHub sources/.test(help)) args.push("--force");
  if (help.includes("--accept-capabilities")) args.push("--accept-capabilities");
  await cli("plugins", "install", "--link", ...args, process.cwd());
}
