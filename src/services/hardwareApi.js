import { getAuthToken } from "./auth.js";

const API_BASE = "/api";

/**
 * Fetches system hardware info (CPU, RAM, GPUs, total VRAM) from the server.
 */
export async function fetchHardwareInfo() {
  try {
    const token = await getAuthToken();
    const res = await fetch(`${API_BASE}/hardware`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * How much capacity model recommendations should be rated against: GPU VRAM
 * if a dedicated GPU was detected, otherwise this machine's real currently
 * available RAM (accounting for other processes already running on it),
 * capped for realistic CPU inference speed. Computed server-side, where the
 * real hardware and load actually live — see effectiveCapacityGb in
 * server/index.js's getLocalHardwareInfo.
 */
export function getAvailableCapacity(hardware) {
  return hardware?.effectiveCapacityGb ?? null;
}
