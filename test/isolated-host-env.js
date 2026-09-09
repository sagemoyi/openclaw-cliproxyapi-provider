// Load before any host SDK: older hosts must never open a user's newer state DB.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const stateDir = mkdtempSync(path.join(tmpdir(), "cpa-sdk-test-"));
process.env.OPENCLAW_STATE_DIR = stateDir;
process.env.OPENCLAW_CONFIG_PATH = path.join(stateDir, "openclaw.json");
delete process.env.OPENCLAW_AGENT_DIR;
// Ambient credentials can auto-enable/install unrelated host provider plugins.
// Mock suites supply their own keys and Gateway token through isolated config.
for (const name of Object.keys(process.env)) {
  if (/(?:_API_KEYS?|_TOKEN|_ACCESS_KEY_ID|_SECRET_ACCESS_KEY)$/.test(name)) delete process.env[name];
}
writeFileSync(process.env.OPENCLAW_CONFIG_PATH, "{}\n", { mode: 0o600 });
