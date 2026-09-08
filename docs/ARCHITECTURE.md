# Architecture and compatibility

English | [简体中文](RESEARCH.md)

This document describes data sources, host integration boundaries, and maintenance constraints. See the [README](../README.md) for setup and [Testing and development](DEVELOPMENT.md) for validation.

## Scope

The plugin connects CPA model availability and capabilities to OpenClaw. The host owns credential storage, inference transport, tool events, session execution, and generated catalog persistence.

Only public OpenClaw SDK interfaces are used. The plugin does not import private build-hashed modules, patch host source, or request CPA management credentials.

## Data sources

| Source | Purpose | Boundary |
| --- | --- | --- |
| `/v1/models` | Availability and ownership | Defines the discoverable model set |
| `/v1/models?client_version=` | Context, output limits, modalities, reasoning | May contain synthesized defaults rather than complete native capability facts |
| `data/cpa-models.json` | Known capability supplements, template corrections, media exclusions | Exact IDs only; no arbitrary alias inference or availability expansion |
| Explicit provider/model configuration | Deployment-specific capability and protocol overrides | Applied through standard OpenClaw configuration |

CPA returns a client capability catalog when the `client_version` query parameter is present. The reviewed implementation preserves extended reasoning levels for empty or unparseable versions. The official pi plugin uses `client_version=pi`; this plugin uses an empty value.

Parsing accepts `models[]`, `data[]`, or a top-level array. Rich rows support `slug` or `id`; reasoning entries can be strings or objects with an `effort` field. Invalid rows and duplicate rich IDs fail snapshot construction instead of turning bad responses into model deletions.

If the ordinary endpoint succeeds and the rich endpoint returns 404/405, bundled fallback is allowed. Older endpoints that ignore the query parameter and return ordinary rows are also supported. Authentication errors, server errors, and invalid responses are not interpreted as an unsupported rich catalog.

## Modules

| Module | Responsibility |
| --- | --- |
| `index.js` | Provider, authentication, control-plane catalog, service, and CLI registration |
| `src/catalog.js` | URL validation, discovery, capability projection, cache, diagnostics |
| `src/provider.js` | Dynamic resolution, overrides, thinking profiles, payload adaptation |
| `src/sync.js` | Host catalog publication and result validation |
| `src/lifecycle.js` | Serialized synchronization, fingerprints, background service lifecycle |
| `scripts/update-metadata.mjs` | Bundled metadata updates from a pinned CPA revision |

## OpenClaw integration

`registerProvider` supplies authentication and text runtime capabilities. `catalog.run` supplies model configuration. `prepareDynamicModel`, `resolveDynamicModel`, and `normalizeResolvedModel` support dynamic resolution and current metadata.

`registerModelCatalogProvider` supplies the unified control-plane live catalog. `resolveThinkingProfile` exposes supported thinking levels. `wrapStreamFn` and `wrapSimpleCompletionStreamFn` recheck discovery before requests and adapt the final payload.

Discovery uses `fetchLiveProviderModelRows`. Inference uses the host's standard transport; history handling reuses OpenAI-compatible replay hooks. The plugin does not implement its own SSE parser or agent loop.

## Capability projection

Live fields take precedence, followed by bundled metadata and conservative defaults. Context and output limits must be positive safe integers; output is capped at context size.

Bundled metadata also addresses two known gaps:

- Some non-reasoning models inherit generic reasoning declarations from client templates.
- Some budget-based thinking models lack discrete client catalog levels and need conversion from known native budget bounds.

Corrections depend on exact IDs and reviewed CPA definitions. Unknown aliases, server-side custom mappings, and future template changes may not be identifiable. Diagnostics expose sources and limitations; users can disable bundled metadata or apply explicit overrides.

Zero cost is an unknown placeholder, not a pricing claim. The plugin does not access models.dev or download and execute catalog instructions, tools, or scripts.

## Cache and synchronization

Cache keys hash the normalized endpoint and credential with SHA-256. At most 16 entries are kept in memory. Concurrent reads of the same catalog are coalesced; both endpoint requests must settle and pass validation before the successful snapshot is replaced.

Transient failures permit bounded stale use without extending the original snapshot lifetime. Synchronous reads retain expiration status. A 401/403 from either endpoint invalidates the cache even if the other endpoint returns a 5xx error.

Publication runs through a serial queue so an earlier operation cannot finish writing after a later one. The successful-publication fingerprint includes endpoint, catalog revision, configuration, and agent scope. Failed publication does not advance the fingerprint, allowing retries. Stale snapshots are not published as new catalogs.

Stopping the service waits for in-flight startup or refresh work. Generation checks prevent stopped or superseded timer callbacks from restarting the loop. There is no separate plugin-owned disk cache or credential file.

## Host catalog publication

### Legacy catalog API

With `loadModelCatalog`, the plugin constructs a temporary configuration view containing current models and sets `useCache:false`. The host owns merging, credentials, catalog locks, and persistence. The view is not written back to the main configuration.

This path primarily materializes the default agent's catalog. Other agents use host discovery and request-time checks; universal hot replacement of existing sessions is not promised.

Some versions have a separate Gateway `models.list` cache whose invalidation is not public SDK functionality. The plugin does not bypass it through private APIs, RPC replacement, or repeated configuration writes. A normal restart or configuration reload may be necessary.

### Prepared catalog API

With `loadPreparedModelCatalog`, the plugin passes the real configuration with `readOnly:false` and `refreshFullCatalog:true`. The host refreshes published catalog state without a synthetic legacy view.

This branch has source and parameter-contract coverage, but not end-to-end validation on the newer Gateway. API detection selects the integration path; it does not imply every later host version has been tested.

Both paths verify complete publication and unexpected retained deletions. Explicitly configured user models are permitted.

## Compatibility baseline

| Component | Baseline | Validation |
| --- | --- | --- |
| OpenClaw | `2026.7.1-2` | Real SDK, CLI installation, isolated Gateway integration |
| OpenClaw prepared catalog | Pinned source revision below | API contract and source review; newer Gateway E2E pending |
| CPA | `v7.2.149` and pinned source below | Catalog/thinking review and representative request validation |
| Official pi plugin | `1.4.15` | Reference for parsing, mapping, caching, and refresh coordination |

These baselines are not promises of coverage for all models, proxies, or maximum context sizes. CPA catalog declarations may disagree with request validation, particularly for extended reasoning levels. Client metadata alone cannot eliminate that inconsistency.

## Official pi plugin and reuse boundaries

[pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) is an important reference for catalog format compatibility and refresh coordination.

Its `pi.extensions` entry, ExtensionAPI, login commands, and session events belong to pi. OpenClaw has distinct provider registration, authentication, and publication lifecycles; adding a manifest is not enough to load the entire pi extension.

This implementation retains applicable patterns while integrating natively with OpenClaw:

- Accept multiple catalog and reasoning representations.
- Coordinate refreshes so outdated work cannot overwrite newer state.
- Use public OpenClaw transport, not runtime patches to pi's Codex source.
- Keep credential-isolated caches, bounded stale use, and authentication invalidation.
- Leave TUI, Fast, pause, retry, and compaction behavior to their respective hosts.

## Source references

Links are pinned to reviewed revisions for reproducible maintenance:

- [CPA OpenAI models handler](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/sdk/api/handlers/openai/openai_handlers.go)
- [CPA client catalog generation](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/client/codex/models/models.go)
- [CPA model registry](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/registry/model_registry.go)
- [CPA thinking conversion](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/thinking/convert.go) and [validation](https://github.com/router-for-me/CLIProxyAPI/blob/d198db54d4c4886c99b21488d54fc576933019a3/internal/thinking/validate.go)
- [OpenClaw prepared catalog](https://github.com/openclaw/openclaw/blob/225845acbfe8bed7f155d3113affeeee2fd48fbc/src/agents/prepared-model-catalog.ts)
- [OpenClaw Gateway catalog](https://github.com/openclaw/openclaw/blob/225845acbfe8bed7f155d3113affeeee2fd48fbc/src/gateway/server-model-catalog.ts)
- [Official pi plugin](https://github.com/router-for-me/pi-cliproxyapi-provider/tree/ffc7cc3fe05b64483651b427e5117ae22dd6aad0)
