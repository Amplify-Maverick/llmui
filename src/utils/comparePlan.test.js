import { test } from "node:test";
import assert from "node:assert/strict";
import { planCompare, measuredGpuMin, shortModelName } from "./comparePlan.js";

const GiB = 1024 ** 3;
const model = (name, gib, status = "measured") => ({
  name,
  memory: {
    status,
    min: {
      n_ctx: 8192,
      devices: [
        { kind: "device", name: "Vulkan0", total: 8 * GiB, model: gib * GiB, context: 0, compute: 0 },
        { kind: "host", name: "Host", model: 9 * GiB, context: 0, compute: 0 },
      ],
    },
  },
});
const gpu = { budget: 7 * GiB };

test("measuredGpuMin counts only the GPU device", () => {
  assert.equal(measuredGpuMin(model("a", 2)), 2 * GiB);
  assert.equal(measuredGpuMin(model("a", 2, "unmeasured")), null);
  assert.equal(measuredGpuMin({ name: "x" }), null);
});

test("parallel when the sum fits the budget (inclusive)", () => {
  const p = planCompare([model("a", 4), model("b", 3)], gpu);
  assert.equal(p.mode, "parallel");
  assert.equal(p.total, 7 * GiB);
});

test("sequential when the sum exceeds the budget", () => {
  const p = planCompare([model("a", 6), model("b", 2.5)], gpu);
  assert.equal(p.mode, "sequential");
  assert.match(p.reason, /fit/);
});

test("sequential when either model is unmeasured", () => {
  const p = planCompare([model("a", 1), model("b", 1, "measuring")], gpu);
  assert.equal(p.mode, "sequential");
  assert.match(p.reason, /not measured yet for b/);
});

test("shortModelName drops the owner", () => {
  assert.equal(shortModelName("Qwen/Qwen3-8B-GGUF:Q4_K_M"), "Qwen3-8B-GGUF:Q4_K_M");
  assert.equal(shortModelName("local"), "local");
});

test("mmproj allowance is added to the measured figure", () => {
  const vision = { ...model("v", 3.32), sidecars: ["mmproj"], mmprojFileSize: 0.855 * GiB };
  const p = planCompare([vision, model("b", 3.17)], gpu);
  assert.equal(p.addOns[0], Math.round(0.855 * GiB * 1.5));
  assert.equal(p.addOns[1], 0);
  assert.equal(p.needs[0], 3.32 * GiB + p.addOns[0]);
  // 3.32 + 1.28 + 3.17 = 7.77 GiB > 7 GiB budget; without the add-on it would be 6.49 (parallel).
  assert.equal(p.mode, "sequential");
});

test("mmproj with unknown size uses the flat allowance", () => {
  const p = planCompare([{ ...model("v", 1), sidecars: ["mmproj"] }, model("b", 1)], gpu);
  assert.equal(p.addOns[0], 1.25 * GiB);
  assert.equal(p.total, 3.25 * GiB);
});
