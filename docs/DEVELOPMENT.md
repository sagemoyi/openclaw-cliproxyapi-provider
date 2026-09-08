# Testing and development

English | [简体中文](TESTING.md)

Validation is split into pure logic, host integration, and live endpoint tests. Default tests need no CPA credentials and do not call paid models.

## Environment

Use a Node.js version supported by both the project and the host. From the repository root:

```bash
npm test
npm run check
```

Pure tests use Node.js's built-in runner and need no additional dependencies. Host integration also requires:

- An `openclaw` executable on PATH.
- A resolvable `openclaw` peer SDK.
- Permission to create temporary directories, launch child processes, and listen on loopback addresses.

Keep the CLI and peer SDK on the same version. For example, install the integration baseline as a development dependency without changing package metadata:

```bash
npm install --no-save --package-lock=false openclaw@2026.7.1-2
```

Do not embed global installation paths, personal credentials, or deployment configuration in source or fixtures.

## Commands

| Command | Scope | CPA credentials |
| --- | --- | --- |
| `npm test` | Pure logic and SDK call contracts | Not required |
| `npm run check` | Entry point and runtime syntax | Not required |
| `npm run test:host` | Real OpenClaw SDK, HTTP/SSE, CLI | Not required |
| `npm run test:gateway` | Isolated Gateway catalog synchronization | Not required |
| `npm run test:live` | Real requests to a configured CPA endpoint | Required; consumes quota |

The current automated baseline contains 37 pure/contract tests, two host integration tests, and one Gateway test. Test counts do not measure model coverage; inspect their assertions.

## Pure logic and contracts

Coverage includes:

- URL normalization, reverse-proxy prefixes, and credential-bearing URL rejection.
- Ordinary/rich catalogs, top-level arrays, slug/id, and mixed reasoning formats.
- Context/output limits, modalities, hidden models, and exact-ID fallback.
- Sparse reasoning, none/auto, max/ultra, non-reasoning, and budget-based thinking.
- Additions, deletions, empty catalogs, and capability changes.
- TTL, coalesced reads, backoff, bounded stale use, and credential isolation.
- Authentication priority when 5xx and 401/403 occur together.
- Payload callback composition and explicit model overrides.
- Publication completeness, retained deletions, retries, and configuration fingerprints.
- Publication ordering, service start/stop, and outdated timer callbacks.

`test/official-review.test.js` retains format and lifecycle regressions informed by reviewing the official pi plugin.

## Host integration

```bash
npm run test:host
npm run test:gateway
```

Tests start controlled mock CPA servers with test credentials and OS-allocated temporary state directories. Dedicated environment variables isolate OpenClaw configuration and state. Servers and Gateway processes created by the tests are stopped afterward.

Artifact directories are retained for inspection, and their paths appear in test output. Remove only directories confirmed to belong to the relevant test run.

### SDK and CLI

`test/host.integration.js` verifies:

- Real HTTP/SSE traffic through the official discovery and streaming SDK.
- high, max, explicit ultra, off, and adaptive mapping to final request parameters.
- No effort injection after the catalog changes to non-reasoning.
- Tool schemas and streamed results remain valid.
- Actual plugin installation, loading, CLI discovery, and publication.
- Inventory changes from a/b to b/c without retaining the removed model.
- Synchronization leaves the main configuration unchanged.

### Gateway lifecycle

`test/gateway.integration.js` checks automatic publication of additions, deletions, context changes, and an empty catalog, plus restart behavior for the legacy picker cache.

It targets the validated legacy integration. Prepared-catalog contract tests do not replace end-to-end tests on the newer Gateway; add those when advancing the compatibility baseline.

## Live endpoint tests

Live tests are opt-in and can incur costs. Use a test account and models confirmed to be available.

Inject `CPA_API_KEY` securely, then configure the endpoint and cases:

```bash
export CPA_BASE_URL='https://cpa.example.com/v1'
export CPA_LIVE_CASES='[{"id":"MODEL_ID","level":"high"}]'
npm run test:live
```

Replace `MODEL_ID` with an actual catalog entry. Do not put real keys in documentation, scripts, shell history, or issue reports. Set `CPA_LIVE_CASES` explicitly instead of relying on the script's example models.

| Field | Required | Description |
| --- | --- | --- |
| `id` | Yes | Exact CPA model ID |
| `level` | Recommended | OpenClaw thinking level, such as off, low, high, max, or adaptive |
| `exact` | No | Explicit CPA effort after verifying endpoint support |

The script asserts discovery and request success, and reports protocol, wire effort, stop reason, and usage. It does not print credentials or raw upstream error bodies.

Select differing capabilities: non-reasoning, none-capable, sparse levels, max, and budget-based thinking. Run negative cases separately. An advertised effort rejected by the validator is a compatibility issue, not a successful test.

Tests do not modify CPA accounts, quotas, or model routing. Inventory changes are reproduced with controlled mock services.

## Updating bundled metadata

`data/cpa-models.json` is a reduced snapshot from a pinned CPA revision. Use a full commit SHA:

```bash
node scripts/update-metadata.mjs CPA_COMMIT_SHA
git diff -- data/cpa-models.json
npm test
```

The script performs mechanical extraction only. Review:

- Source revision, licensing, and field changes.
- Conflicts for the same ID across definitions.
- Media classifications, reasoning budgets, and discrete levels.
- Potential conflicts with live catalog data.

Do not treat every bundled model as available or add unverified alias mappings.

## Before submitting changes

```bash
git diff --check
npm test
npm run check
npm run test:host
npm run test:gateway
npm pack --dry-run
```

Run integration suites for host or transport changes. Use live tests explicitly when server behavior needs confirmation. Before release, inspect the package for runtime modules, manifest, metadata, and licenses, and ensure it excludes credentials, test state, and node_modules.

## Validation limits and issue reports

Tests do not establish support for every CPA model, maximum context size, multi-agent session, or OpenClaw version. Distinguish:

- Correct metadata mapping from upstream parameter acceptance.
- Updated generated catalogs from refreshed Gateway picker caches.
- API contract coverage from end-to-end host lifecycle validation.
- Short successful requests from maximum-context stress testing.

Include plugin, OpenClaw, Node.js, and CPA versions, minimal configuration, reproduction commands, and sanitized model metadata/logs in reports. Check endpoint domains, private model names, keys, and request contents before sharing diagnostics.
