// Install only the checked-out source into the caller's isolated test state.
export async function installHostPlugin(cli) {
  const help = (await cli("plugins", "install", "--help")).stdout;
  // July rejects --force with --link; newer hosts use it for source consent.
  const args = [];
  if (/Confirm non-ClawHub sources/.test(help)) args.push("--force");
  if (help.includes("--accept-capabilities")) args.push("--accept-capabilities");
  await cli("plugins", "install", "--link", ...args, process.cwd());
}
