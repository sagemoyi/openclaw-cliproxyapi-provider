import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

// Prefer the peer installed in this checkout so the CLI matches the SDK under test.
// A global binary on PATH can be a newer host than the package the suite just installed.
export function resolveHostCli(cwd = process.cwd(), pathEnv = process.env.PATH ?? "") {
  const local = path.join(cwd, "node_modules", ".bin", "openclaw");
  try { realpathSync(local); return local; } catch { /* use PATH */ }
  for (const dir of pathEnv.split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, "openclaw");
    try { realpathSync(candidate); return candidate; } catch { /* keep looking */ }
  }
  return "openclaw";
}

// Exercise the managed npm installation users receive. A raw archive copy can
// hide missing runtime dependencies that happen to exist in the source checkout.
export async function installHostPlugin(cli, cwd = process.cwd()) {
  const help = (await cli("plugins", "install", "--help")).stdout;
  const args = [];
  if (/Confirm non-ClawHub sources/.test(help)) args.push("--force");
  if (help.includes("--accept-capabilities")) args.push("--accept-capabilities");
  const packDir = await mkdtemp(path.join(tmpdir(), "cpa-plugin-pack-"));
  try {
    const packed = await exec("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd });
    const archive = JSON.parse(packed.stdout).at(-1)?.filename;
    if (!archive) throw new Error(`npm pack produced no archive: ${packed.stdout}`);
    await cli("plugins", "install", ...args, `npm-pack:${path.join(packDir, archive)}`);
  } finally {
    await rm(packDir, { recursive: true, force: true });
  }
}
