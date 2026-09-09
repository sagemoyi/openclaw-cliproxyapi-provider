# Plugin ID migration (0.2.0)

0.2.0 changes the plugin ID from `cliproxyapi` to `openclaw-cliproxyapi-provider`. This is currently an unreleased source change; the published ClawHub version 0.1.2 still uses the old ID.

| Purpose | Through 0.1.2 | 0.2.0 |
| --- | --- | --- |
| Plugin ID, `plugins.entries` key, `plugins.allow` member | `cliproxyapi` | `openclaw-cliproxyapi-provider` |
| Install package | `@sagemoyi/openclaw-cliproxyapi-provider` | Unchanged |
| Model provider and `--provider` argument | `cliproxyapi` | Unchanged |
| Model references and auth profiles | `cliproxyapi/MODEL_ID`, `cliproxyapi:default` | Unchanged |

## Why a one-time migration is required

OpenClaw 2026.9.3 checks that an updated community plugin has the same manifest ID as its install record. Updating directly to the renamed package is rejected:

```text
plugin id mismatch: expected cliproxyapi, got openclaw-cliproxyapi-provider
```

`legacyPluginIds` does not bypass this update check. Do not just rename the `plugins.installs` key or load both plugins: they register the same model provider and `cpa` command.

## Existing installations

1. Use the same OpenClaw configuration, profile, and state directory as the original installation. Back up the active configuration and authentication state. Preserve the complete `plugins.entries.cliproxyapi` entry, including `enabled` and `config`, plus the original `plugins.allow` and `plugins.deny` lists if present. Keep credential-bearing backups out of Git.
2. Prepare the new installation source before uninstalling. For the current source, run `npm pack` in this repository to produce `sagemoyi-openclaw-cliproxyapi-provider-0.2.0.tgz`. Verify its manifest ID is `openclaw-cliproxyapi-provider`. Until 0.2.0 is published, installing from ClawHub still gives the old ID.
3. Stop the Gateway, preview removal, then uninstall the old plugin:

   ```bash
   openclaw gateway stop
   openclaw plugins uninstall cliproxyapi --dry-run
   openclaw plugins uninstall cliproxyapi
   ```

   Uninstall removes the old install record, plugin settings, and allowlist entry, so keep the backup from step 1.
4. Install the new package, confirming any local-source permissions requested by your host:

   ```bash
   openclaw plugins install ./sagemoyi-openclaw-cliproxyapi-provider-0.2.0.tgz
   ```

   Once 0.2.0 is published on ClawHub, install from the following source instead to enable subsequent `plugins update` commands:

   ```bash
   openclaw plugins install clawhub:@sagemoyi/openclaw-cliproxyapi-provider
   ```

   For linked source, run `openclaw plugins install --link .` in the new checkout.
5. Restore the backed-up plugin entry under `plugins.entries["openclaw-cliproxyapi-provider"]`, keeping its original `enabled` value and entire `config`. If you had allow/deny lists, replace the old ID with the new one while preserving other members. Remove the old `plugins.entries.cliproxyapi` entry. Keep the newly generated install record; do not restore the old plugin's `plugins.load.paths` source. Leave `models.providers.cliproxyapi`, `cliproxyapi/*` policies, default models, and auth profiles unchanged.
6. Validate the configuration and plugin loading, then start the Gateway:

   ```bash
   openclaw config validate
   openclaw plugins list
   openclaw gateway start
   openclaw models list --all --provider cliproxyapi
   ```

   The plugin list should show the new ID; models still start with `cliproxyapi/`. Preserve a previously disabled plugin's disabled state.

If migration fails, keep the Gateway stopped, uninstall the new ID, reinstall the original 0.1.2 source, and restore the old plugin configuration and list entries from backup. Verify the old ID loads before starting the Gateway.

## Subsequent updates

After installing the new ID from ClawHub:

```bash
openclaw plugins update openclaw-cliproxyapi-provider --dry-run
openclaw plugins update openclaw-cliproxyapi-provider
openclaw gateway restart
```

Local `.tgz` installations require a new package file; linked installations require updating their source checkout. Renaming the ID does not convert either source into a ClawHub installation.
