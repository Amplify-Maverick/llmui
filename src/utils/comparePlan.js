/**
 * Decide how to run a two-model comparison on one GPU.
 *
 * Parallel only when both models' *measured* minimum GPU memory
 * (memory.min: model + context + compute on the GPU device) fits together in
 * total VRAM minus the router's margin. Otherwise sequential: run A, unload
 * it, load B, run B. If either model hasn't been measured yet, fit can't be
 * confirmed, so sequential is the safe choice.
 *
 * Models with an mmproj sidecar get an allowance on top of the measured
 * figure, since llama.cpp doesn't count the projector (see mmproj.js).
 */

import { mmprojAllowance } from "./mmproj.js";

/** Minimum GPU bytes a model needs, or null if not measured. */
export function measuredGpuMin(model) {
  const mem = model?.memory;
  if (!mem || mem.status !== "measured") return null;
  const d = mem.min?.devices?.find((x) => x.kind !== "host" && x.total);
  if (!d) return null;
  return (d.model || 0) + (d.context || 0) + (d.compute || 0);
}

/**
 * @param {Array<{name, memory}>} pair  the two router models (A, B)
 * @param {{budget:number}|null} gpu    budget = total VRAM - margin
 * @returns {{ mode: "parallel"|"sequential", reason: string,
 *             needs: (number|null)[], addOns: number[], total: number|null, budget: number|null }}
 *   needs include addOns (the per-model mmproj allowance).
 */
export function planCompare(pair, gpu) {
  const addOns = pair.map(mmprojAllowance);
  const needs = pair.map((m, i) => {
    const n = measuredGpuMin(m);
    return n == null ? null : n + addOns[i];
  });
  const budget = gpu?.budget ?? null;
  const unmeasured = pair.filter((_, i) => needs[i] == null).map((m) => m?.name ?? "?");
  if (unmeasured.length > 0) {
    return {
      mode: "sequential",
      reason: `GPU memory not measured yet for ${unmeasured.join(" and ")}`,
      needs,
      addOns,
      total: null,
      budget,
    };
  }
  const total = needs[0] + needs[1];
  if (budget == null) {
    return { mode: "sequential", reason: "GPU size unknown", needs, addOns, total, budget };
  }
  return total <= budget
    ? { mode: "parallel", reason: "Both fit on the GPU together", needs, addOns, total, budget }
    : { mode: "sequential", reason: "Too big to fit on the GPU together", needs, addOns, total, budget };
}

/** "Qwen/Qwen3-8B-GGUF:Q4_K_M" → "Qwen3-8B-GGUF:Q4_K_M" */
export function shortModelName(id) {
  return id.includes("/") ? id.slice(id.indexOf("/") + 1) : id;
}
