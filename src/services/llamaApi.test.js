import { test } from "node:test";
import assert from "node:assert/strict";
import { estimateFit, fitsOnGpu, FIT_LABEL } from "./llamaApi.js";

const GiB = 1024 ** 3;
const gpu = { total: 8 * GiB, budget: 7 * GiB };

test("estimateFit: fits / tight / nofit against the VRAM budget", () => {
  assert.equal(estimateFit(5 * GiB, gpu).level, "fits");
  assert.equal(estimateFit(5.8 * GiB, gpu).level, "tight");
  assert.equal(estimateFit(17 * GiB, gpu).level, "nofit");
});

test("estimateFit: too big for VRAM but within VRAM + free RAM − 4 GiB → offload", () => {
  const withRam = { ...gpu, ramFree: 16 * GiB };
  // need = 17 + 1 = 18 GiB ≤ 7 + 16 − 4 = 19 GiB
  const fit = estimateFit(17 * GiB, withRam);
  assert.equal(fit.level, "offload");
  assert.equal(FIT_LABEL[fit.level], "Fits with RAM offload");
  assert.equal(fitsOnGpu(fit), false);
  // need = 19 + 1 = 20 GiB > 19 GiB
  assert.equal(estimateFit(19 * GiB, withRam).level, "nofit");
  // Fits on the GPU stays a GPU fit.
  assert.equal(estimateFit(5 * GiB, withRam).level, "fits");
  assert.equal(fitsOnGpu(estimateFit(5.8 * GiB, withRam)), true);
});

test("estimateFit: without RAM info the label stays Won't fit", () => {
  assert.equal(estimateFit(17 * GiB, { ...gpu, ramFree: null }).level, "nofit");
  assert.equal(FIT_LABEL.nofit, "Won't fit");
});
