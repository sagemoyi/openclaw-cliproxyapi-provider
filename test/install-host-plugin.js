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

// Install the packed plugin, not a --link of the checkout. OpenClaw 2026.9.5+ rejects a
// linked checkout when its node_modules contains the running OpenClaw package: the install
// record owns the whole repository, so the host package is reported as a conflicting child.
export async function installHostPlugin(cli, cwd = process.cwd()) {
  const help = (await cli("plugins", "install", "--help")).stdout;
  // July rejects --force with --link; newer hosts use it for source consent.
  const args = [];
  if (/Confirm non-ClawHub sources/.test(help)) args.push("--force");
  if (help.includes("--accept-capabilities")) args.push("--accept-capabilities");
  const packDir = await mkdtemp(path.join(tmpdir(), "cpa-plugin-pack-"));
  try {
    const packed = await exec("npm", ["pack", "--pack-destination", packDir, "--json"], { cwd });
    const archive = JSON.parse(packed.stdout).at(-1)?.filename;
    if (!archive) throw new Error(`npm pack produced no archive: ${packed.stdout}`);
    await cli("plugins", "install", ...args, path.join(packDir, archive));
  } finally {
    await rm(packDir, { recursive: true, force: true });
  }
}
