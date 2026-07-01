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
 * Derives how much memory is available for loading a model on this machine:
 * GPU VRAM if a dedicated GPU was detected, otherwise an estimate of usable
 * system RAM (models can run on CPU, but the OS and other processes need
 * headroom too).
 */
export function getAvailableCapacity(hardware) {
  if (!hardware) return null;
  if (hardware.totalVramGb) return hardware.totalVramGb;
  if (hardware.ram?.totalGb) return +(hardware.ram.totalGb * 0.75).toFixed(1);
  return null;
}
