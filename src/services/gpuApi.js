import { getAuthToken } from "./auth.js";

const GPU_API = "/api/gpu";

/**
 * Fetches live GPU stats from the authenticated Express server endpoint.
 * Returns { ok, gpus, timestamp } on success, or { ok: false, error } on failure.
 */
export async function fetchGpuStats() {
  try {
    const token = await getAuthToken();
    const res = await fetch(GPU_API, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
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
