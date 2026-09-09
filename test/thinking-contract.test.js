import test from "node:test";
import assert from "node:assert/strict";
import { selectEffort } from "../src/provider.js";

const model = (efforts, defaultEffort = "high") => ({ reasoning: true,
  compat: { supportedReasoningEfforts: efforts }, params: { cpa: { defaultEffort } } });

test("OpenClaw logical ultra never implicitly becomes CPA's raw ultra effort", () => {
  const m = model(["low", "high", "max", "ultra"]);
  assert.equal(selectEffort(m, "ultra"), "max");
  assert.equal(selectEffort(model(["low", "high", "ultra"]), "ultra"), "high");
  // This remains a separate, explicitly opted-in wire override, not /think ultra.
  assert.equal(selectEffort(m, "ultra", "ultra"), "ultra");
});

test("an advertised ultra default still requires an explicit raw effort opt-in", () => {
  assert.equal(selectEffort(model(["low", "max", "ultra"], "ultra")), "max");
  assert.equal(selectEffort(model(["ultra"], "ultra")), undefined);
});
