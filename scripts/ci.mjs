import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const cwd = fileURLToPath(new URL("../", import.meta.url));
const readJson = (file) => JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8"));
const pkg = readJson("../package.json");
const target = pkg.peerDependencies.openclaw;
for (const [field, value] of Object.entries({
  "compat.pluginApi": pkg.openclaw.compat.pluginApi,
  "compat.minGatewayVersion": pkg.openclaw.compat.minGatewayVersion,
  "build.openclawVersion": pkg.openclaw.build.openclawVersion,
  "build.pluginSdkVersion": pkg.openclaw.build.pluginSdkVersion,
})) {
  if (value !== target) throw new Error(`openclaw.${field} must match peerDependencies.openclaw (${target})`);
}
let host;
try { host = readJson("../node_modules/openclaw/package.json"); }
catch { throw new Error(`Install the test host first: npm install --no-save --package-lock=false openclaw@${target}`); }
if (host.version !== target) throw new Error(`Installed OpenClaw ${host.version} does not match target ${target}`);

// The integration suites create temporary state/config and their own Gateway;
// this entry point never starts or changes a persistent dev/prod service.
for (const [command, args] of [
  ["git", ["diff", "--check"]],
  ["npm", ["run", "check"]],
  ["npm", ["test"]],
  ["npm", ["run", "test:host"]],
  ["npm", ["run", "test:gateway"]],
]) {
  const result = spawnSync(command, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
