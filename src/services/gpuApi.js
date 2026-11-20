import { getAuthToken } from "./auth.js";

/**
 * Live GPU stats of one machine, read from its sd-fetch helper (GET /v1/gpu)
 * through the authenticated server. Without a machine id, the machine chat
 * currently runs on.
 * Returns { ok, machine, gpus: [{ index, name, vendor, utilization, memoryUsed,
 * memoryTotal, temperature, powerDraw }], timestamp, error } (values may be
 * null), or { ok: false, error } on failure.
 */
export async function fetchGpuStats(machineId) {
  try {
    const token = await getAuthToken();
    const qs = machineId ? `?machine=${encodeURIComponent(machineId)}` : "";
    const res = await fetch(`/api/gpu${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(8000),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) return { ok: false, error: body.error || `HTTP ${res.status}` };
    return body;
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
