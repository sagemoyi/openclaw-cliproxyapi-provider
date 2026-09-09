# OpenClaw CLIProxyAPI Provider

English | [简体中文](README.zh-CN.md)

An [OpenClaw](https://github.com/openclaw/openclaw) provider that discovers models from [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) (CPA). Configure an endpoint and API key to load available models, map their capabilities, and keep the OpenClaw catalog up to date.

Plugin ID: `openclaw-cliproxyapi-provider`. Model provider ID: `cliproxyapi`. Built on the public OpenClaw plugin SDK; no OpenClaw or CPA core changes required.

## What it does

- Interactive setup for the CPA endpoint and API key.
- Dynamic model discovery with context limits, output limits, input modalities, and reasoning levels.
- Periodic catalog synchronization and manual refresh commands.
- Model-specific OpenClaw thinking profiles and request payload adaptation.
- Integration with OpenClaw authentication, inference transport, and catalog persistence.
- Standard provider/model overrides and coexistence with existing static providers.

## Requirements

- Node.js 22.16.0 or later, also satisfying your OpenClaw version's runtime requirements.
- OpenClaw 2026.7.1-2 or later. See [Architecture and compatibility](docs/ARCHITECTURE.md) for validation boundaries. See the [issue #1 verification record (Chinese)](docs/COMPATIBILITY.zh-CN.md) for the cross-version investigation.
- A reachable CPA HTTP(S) endpoint and a model-access API key. No management key is required.

Some older OpenClaw versions cache the Gateway model picker separately. Generated catalogs and request-time capabilities can update while the picker still requires a Gateway restart. See [Troubleshooting](#troubleshooting).

## Install

The current source targets **0.2.0 (unreleased)** with the new plugin ID. The published **0.1.2** still uses `cliproxyapi`; see [ID migration](docs/PLUGIN_ID_MIGRATION.md) before moving an existing installation to this source.

Install the published plugin from ClawHub:

```bash
openclaw plugins install clawhub:@sagemoyi/openclaw-cliproxyapi-provider
```

Use an OpenClaw version that supports the `clawhub:` plugin source. Then follow the interactive setup below and restart the Gateway to load the plugin.

From source:

```bash
git clone https://github.com/sagemoyi/openclaw-cliproxyapi-provider.git
cd openclaw-cliproxyapi-provider
openclaw plugins install --link .
```

Keep the checkout in place: `--link` uses it as the plugin source. This installation method does not depend on an npm release.

Alternatively, create an installable package:

```bash
npm pack
openclaw plugins install ./sagemoyi-openclaw-cliproxyapi-provider-0.2.0.tgz
```

If you use `plugins.allow`, add `openclaw-cliproxyapi-provider` to the existing list without replacing other allowed plugins.

## Update

These commands apply after installing the new ID. Versions up to 0.1.2 use `openclaw plugins update cliproxyapi`; they require a [one-time migration](docs/PLUGIN_ID_MIGRATION.md) to 0.2.0.

For a ClawHub installation, preview the update using the plugin ID `openclaw-cliproxyapi-provider`:

```bash
openclaw plugins update openclaw-cliproxyapi-provider --dry-run
```

After reviewing the preview, apply the update and restart the Gateway to load it:

```bash
openclaw plugins update openclaw-cliproxyapi-provider
openclaw gateway restart
```

`plugins update` takes the installed plugin ID. Installation uses the package name `@sagemoyi/openclaw-cliproxyapi-provider`, and the display name is **OpenClaw CLIProxyAPI Provider**; updates use `openclaw-cliproxyapi-provider`. If the plugin cannot be found, run `openclaw plugins list` and check that the command uses the configuration and state directory where it was installed.

Updates use the recorded installation source. For a source installation with `--link`, update that checkout and restart the Gateway. For a local `.tgz` installation, install the new package file.

## Interactive setup (recommended)

```bash
openclaw models auth login --provider cliproxyapi --method api-key
```

If multiple agents are configured, OpenClaw may report `Multiple agents are configured, but the model command has no explicit owner. Pass --agent <id>.` First list the agent IDs:

```bash
openclaw agents list
```

Then select the agent that owns this authentication, replacing `AGENT_ID` with an actual ID from the list:

```bash
openclaw models auth login --agent AGENT_ID --provider cliproxyapi --method api-key
```

To inspect that agent's models afterward, use `openclaw models list --agent AGENT_ID --all --provider cliproxyapi`.

Enter:

1. Your CPA endpoint, such as `https://cpa.example.com/v1`.
2. Your CPA API key.

Setup validates the connection by querying the model catalog. A valid empty catalog is accepted; network failures, authentication errors, and invalid responses fail setup.

On success, credentials are stored in a standard OpenClaw auth profile, the endpoint is added to provider configuration, and `cliproxyapi/*` is added to the selectable model scope. The discovered model list is not written into the main configuration, and your default model is not changed automatically.

Refresh and list models:

```bash
openclaw cpa sync
openclaw models list --all --provider cliproxyapi
```

Replace `MODEL_ID` with an actual ID from the catalog:

```bash
openclaw models set cliproxyapi/MODEL_ID
openclaw gateway restart
```

Run the login command again to update connection details. If you also use explicit API keys or environment variables, review those settings as well: credential selection follows OpenClaw's authentication rules.

## Non-interactive configuration

Merge this into your OpenClaw configuration, preserving existing providers, plugins, and agent settings:

```json
{
  "models": {
    "providers": {
      "cliproxyapi": {
        "baseUrl": "https://cpa.example.com/v1",
        "apiKey": "${CPA_API_KEY}",
        "models": []
      }
    }
  },
  "agents": {
    "defaults": {
      "models": {
        "cliproxyapi/*": {}
      }
    }
  },
  "plugins": {
    "entries": {
      "openclaw-cliproxyapi-provider": {
        "enabled": true
      }
    }
  }
}
```

`CPA_API_KEY` must be available to the process running OpenClaw. Variables in an interactive shell may not reach systemd, a container, or another service manager. OpenClaw SecretRefs and auth profiles are also supported through the host's authentication mechanism.

Keep `models: []` for automatic discovery. Add explicit model configuration only when you need capability or protocol overrides.

### Endpoint normalization

Endpoints must include `http://` or `https://`. Use HTTPS for remote connections.

| Input | Normalized API base URL |
| --- | --- |
| `https://cpa.example.com` | `https://cpa.example.com/v1` |
| `https://cpa.example.com/v1/` | `https://cpa.example.com/v1` |
| `https://proxy.example.com/cpa` | `https://proxy.example.com/cpa/v1` |

Reverse-proxy path prefixes are supported. Embedded usernames, passwords, query parameters, and fragments are rejected. Use the OpenAI-compatible API base, not the `/backend-api` address used by the pi plugin.

## Commands

| Command | Purpose |
| --- | --- |
| `openclaw cpa catalog` | Query model capabilities, metadata sources, and diagnostics without printing credentials or the endpoint URL |
| `openclaw cpa sync` | Request a refresh and publish the catalog; return synchronization status without editing the main configuration |
| `openclaw models list --all --provider cliproxyapi` | List CPA models in the OpenClaw catalog |

Inspect command output and Gateway logs if discovery or synchronization fails. Transient failures can return a historical snapshot marked `stale`; synchronization does not publish it as a fresh catalog.

## Refresh and cache

The Gateway service discovers models at startup and, by default, waits 60 seconds after each synchronization before checking again. Request-time discovery also reads or refreshes the catalog cache.

| Setting | Default | Range | Description |
| --- | --- | --- | --- |
| `refreshSeconds` | `60` | 10–86400 | Cache TTL and background refresh interval, in seconds |
| `staleSeconds` | `300` | 0–86400 | Additional time after TTL during which a successful snapshot may be used temporarily |
| `timeoutMs` | `10000` | 100–60000 | Timeout for each catalog request, in milliseconds |
| `useBundledMetadata` | `true` | Boolean | Supplement or correct known capabilities using bundled CPA metadata |

Configure these under the plugin entry:

```json
{
  "plugins": {
    "entries": {
      "openclaw-cliproxyapi-provider": {
        "enabled": true,
        "config": {
          "refreshSeconds": 60,
          "staleSeconds": 300,
          "timeoutMs": 10000,
          "useBundledMetadata": true
        }
      }
    }
  }
}
```

The in-memory discovery cache is isolated by endpoint and credential. OpenClaw owns generated catalog persistence. Synchronization is serialized, and changes to the catalog, endpoint, or configuration trigger publication.

### Failure behavior

- **No endpoint or credentials:** no discovery requests or model registration.
- **Network, server, or response-format errors:** an earlier successful snapshot may be used within the bounded stale window; errors are returned after that window expires.
- **401/403:** the corresponding cache is invalidated immediately, with no stale fallback.
- **Successful empty catalog:** models are removed from the discovered catalog rather than restored from an old snapshot.
- **Removed model:** request-time checks reject it after discovery observes the change. A still-valid cache can temporarily retain the earlier inventory.
- **Incomplete publication or unexpected deleted models remaining:** synchronization reports failure and retries later. Explicit user model entries are not treated as unexpected leftovers.

Account health or quota changes may temporarily hide models in CPA; these are treated as availability changes. The plugin does not manage CPA accounts, restart the Gateway, or retry failed inference requests.

## Model capabilities and reasoning

The ordinary CPA catalog defines availability. The rich catalog supplies capabilities; bundled metadata only supplements those models and never makes an unavailable model selectable.

| Capability | Mapping |
| --- | --- |
| Context window | `context_window`, then exact-ID metadata, then 32768 |
| Output limit | `max_tokens`, then bundled metadata, then 4096; capped at the context window |
| Input modalities | Text/image input capabilities |
| Reasoning | String or object effort entries mapped to OpenClaw thinking profiles |
| Hidden models | Skip `visibility: hide` and known image/video generation models |
| Cost | Zero is an unknown placeholder, not free usage; use standard cost overrides if needed |

`max_context_window` is retained for diagnostics, not automatically enabled. Unknown aliases are not resolved by guessing model names. Incomplete metadata produces conservative defaults and warnings.

Supported reasoning levels are model-specific. `none` maps to OpenClaw `off`; `auto` maps to `adaptive`. Models that cannot disable thinking do not advertise `off`. If an existing session's level becomes unsupported, request adaptation selects a supported lower level or the model default.

`ultra` is not offered as a normal thinking option: some OpenClaw versions give it separate orchestration semantics, and some CPA versions advertise levels their request validator rejects. For exact passthrough after verifying endpoint support:

```json
{
  "agents": {
    "defaults": {
      "models": {
        "cliproxyapi/MODEL_ID": {
          "params": {
            "cpaReasoningEffort": "max"
          }
        }
      }
    }
  }
}
```

The explicit effort must appear in the model's capability declaration, but that declaration does not guarantee upstream acceptance. The plugin does not probe support by sending trial inference requests.

The default protocol is selected from model ownership and known model type: OpenAI Responses or Chat Completions. Special deployments can override the standard provider/model `api` field. Avoid forcing one protocol across the entire provider unless the endpoint requires it.

## Migration from static providers

1. Keep the old configuration while installing and configuring this plugin.
2. Check models and capabilities with `cpa catalog` and `models list`.
3. Change the desired default or agent model references to `cliproxyapi/MODEL_ID`.
4. Remove obsolete configuration only after verifying requests.

The plugin does not delete existing providers or rewrite sessions. Context and compaction budgets in an active session are not guaranteed to be recalculated within the current turn.

## Troubleshooting

### Models discovered but missing from the picker

OpenClaw versions with `agents.defaults.modelPolicy.allow` use that explicit policy ahead of the legacy `agents.defaults.models` entries. Since 0.1.1, login also adds `cliproxyapi/*` to an existing default policy while preserving its entries. After upgrading from 0.1.0, rerun login for the intended agent, or merge `cliproxyapi/*` into the existing policy. If the agent has its own `modelPolicy.allow`, that policy takes precedence and must allow CPA models as well. Repeated Gateway restarts do not change model visibility policy.

### Sync reports success but does not exit

OpenClaw `2026.8.1` / `2026.8.2` can retain a host worker after prepared catalog publication completes. For one-shot sync commands that exit normally, use the verified `2026.9.3` host. See the [compatibility investigation (Chinese)](docs/COMPATIBILITY.zh-CN.md). If either August host must be retained, see the separate [host patches and rollback instructions](https://github.com/sagemoyi/openclaw-cliproxyapi-provider/tree/main/patches/openclaw); plugin updates do not apply these patches automatically.

### Provider or login method is missing

Check `openclaw plugins list` and ensure `plugins.allow` includes `openclaw-cliproxyapi-provider`. After installation or updates, the running Gateway must load the new plugin code.

If login fails before prompting because the CLI and installed Gateway use different state directories or config paths, the host has refused a write to a divergent store. Check that the command targets the intended Gateway configuration; use a dedicated configuration for isolated tests. This error does not establish that the CPA key is invalid.

### Discovery succeeds, but the picker shows old models

Run `openclaw cpa sync` and inspect the result. OpenClaw versions with the legacy picker cache may require:

```bash
openclaw gateway restart
```

The presence of a refresh API does not guarantee restart-free updates for every host version, agent, and existing session.

### Authentication or connection fails

Verify the URL scheme, reverse-proxy routing, credential source, and Gateway service environment. Never put keys in URLs, issue reports, or public logs.

### Reasoning or context limits look wrong

Inspect sources and warnings in `cpa catalog`. CPA may synthesize default metadata, while bundled data may lag behind the server. Update the plugin, use standard model overrides, or compare behavior with `useBundledMetadata` disabled.

## Development

See [Testing and development](docs/DEVELOPMENT.md) and [Architecture and compatibility](docs/ARCHITECTURE.md).

## Related projects and license

Discovery and refresh design draws on the official [pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider). This is an independent OpenClaw integration, not a fork of that plugin, and does not provide its TUI, Fast, pause, or compaction features.

Licensed under the [MIT License](LICENSE). See [Third-party notices](THIRD_PARTY_NOTICES.md) for bundled CPA metadata attribution and licensing.
