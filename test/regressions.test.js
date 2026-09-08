import test from "node:test";
import assert from "node:assert/strict";
import { projectModel } from "../src/catalog.js";
import { selectEffort } from "../src/provider.js";
test("built-in image/video models never appear as chat even on old CPA endpoints", () => {
  for (const id of ["gpt-image-2", "grok-imagine-image", "grok-imagine-video-1.5-preview"]) assert.equal(projectModel({ id }), null);
});
test("exact IDs that collide with JS prototype properties remain ordinary unknown models", () => {
  assert.equal(projectModel({ id: "constructor" }).id, "constructor");
  assert.equal(projectModel({ id: "__proto__" }).reasoning, false);
});
test("reasoning downgrade compares strengths independently of upstream array order", () => {
  assert.equal(selectEffort({ reasoning: true, compat: { supportedReasoningEfforts: ["high", "low"] } }, "max"), "high");
});
test("CPA's Sol ultra contradiction is visible in diagnostics rather than hidden", () => {
  const m = projectModel({ id: "gpt-5.6-sol", owned_by: "openai" }, { slug: "gpt-5.6-sol", context_window: 272000,
    supported_reasoning_levels: ["low", "max", "ultra"].map((effort) => ({ effort })) });
  assert.ok(m.compat.supportedReasoningEfforts.includes("ultra"));
  assert.ok(!m.params.cpa.nativeReasoningEfforts.includes("ultra"));
  assert.ok(m.params.cpa.warnings.some((w) => w.includes("request-validation")));
});
