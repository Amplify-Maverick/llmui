/**
 * Vision projector (mmproj) GPU allowance.
 *
 * llama.cpp's memory report (memory.min / memory.effective) doesn't count the
 * mmproj sidecar yet. Measured: unsloth/Qwen3.5-9B-GGUF:IQ2_XXS reports
 * 3.32 GiB but uses 4.47 GiB (+1.15 GiB) with its 0.86 GiB mmproj-F16.
 * Allowance = mmproj file size × 1.5, or a flat 1.25 GiB if the size is unknown.
 */

const GiB = 1024 ** 3;
export const MMPROJ_FACTOR = 1.5;
export const MMPROJ_FLAT_BYTES = 1.25 * GiB;

/** True if the router lists an mmproj sidecar for this model. */
export function hasMmproj(model) {
  return Array.isArray(model?.sidecars) && model.sidecars.includes("mmproj");
}

/** Allowance for an mmproj of `fileBytes` (null/0 → flat). */
export function mmprojAllowanceForFile(fileBytes) {
  return fileBytes > 0 ? Math.round(fileBytes * MMPROJ_FACTOR) : MMPROJ_FLAT_BYTES;
}

/** Extra GPU bytes to add to a router model's reported memory (0 without an mmproj). */
export function mmprojAllowance(model) {
  return hasMmproj(model) ? mmprojAllowanceForFile(model.mmprojFileSize) : 0;
}
