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
