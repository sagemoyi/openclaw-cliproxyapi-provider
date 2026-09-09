# OpenClaw 2026.8.1 / 2026.8.2 worker reference backport

These are optional patches to the **OpenClaw host**, not code loaded or applied by the CLIProxyAPI plugin. They target only the exact npm releases named in each patch. The published plugin 0.1.2 does not install them or change its host.

## Problem and change

The August prepared-catalog worker registers a `message` listener after calling `unref()`. Node references the underlying MessagePort again, and the standalone runtime keeps the worker current after a one-shot `cpa sync`. The catalog is published but the command does not exit.

The patch keeps the worker referenced while requests are pending and unrefs it when the pending queue becomes empty. It also removes the pending entry and timer if `postMessage()` throws synchronously. An in-flight request therefore retains the process, while an idle worker does not. No forced process exit or plugin-side private SDK import is added.

The corresponding upstream source is `src/agents/prepared-model-catalog-worker.ts`. These small patches target the distributed JavaScript bundles for local backporting; they are not a complete backport of the September process-lifetime framework.

## Applying and reverting

Prefer upgrading to a tested September host when possible. If an August host must be retained, first identify its exact installed package directory and check its `package.json` version. The expected original bundle filenames and SHA-256 values are in [original-files.json](original-files.json).

Run from that OpenClaw package directory, substituting the absolute path to the matching patch:

```bash
# Example for exactly OpenClaw 2026.8.1:
patch --dry-run -p1 < /absolute/path/openclaw-2026.8.1-worker-ref.patch
patch -p1 < /absolute/path/openclaw-2026.8.1-worker-ref.patch
```

For exactly `2026.8.2`, use `openclaw-2026.8.2-worker-ref.patch`. Restart the affected host after applying a patch so it loads the changed module. Reinstalling or upgrading OpenClaw can replace the patched file.

To revert, run from the same package directory:

```bash
patch -R -p1 < /absolute/path/openclaw-2026.8.1-worker-ref.patch
```

Use the matching 8.2 patch when reverting that version. These instructions do not change the installed 2026.9.3 host used for the plugin's live smoke tests.

## Verification

Validation uses Node.js `v24.16.0`, exact 8.1/8.2 CLI and SDK installations, separate patched host copies, isolated state, and a local mock CPA.

- Both unpatched hosts published successfully but remained alive beyond the 30-second cutoff.
- Both patched hosts published and exited normally with code 0.
- Both patched Gateways passed the existing regression: additions, removals, capability changes and empty catalogs were visible through public `models.list` without a restart (one test per host; approximately 54 and 53 seconds including runner startup).
- On patched 8.2, main-process discovery succeeded but worker-only discovery returned HTTP 500: the error propagated and the CLI exited with code 1 in about 10 seconds.
- On patched 8.2, an injected synchronous `Worker.postMessage()` error propagated and exited with code 1 in about 10 seconds, without retaining the process for the 180-second timeout.
- Both patches passed `patch --dry-run` against the untouched original bundles.

No real provider credentials are included in these artifacts. Test installations, databases and raw logs are disposable; the plugin's release/CI evidence and this patch record preserve the relevant conclusions.
