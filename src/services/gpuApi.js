/**
 * Fetches live GPU stats from the Vite server plugin endpoint.
 * Returns { ok, gpus, timestamp } on success, or { ok: false, error } on failure.
 */
export async function fetchGpuStats() {
  try {
    const res = await fetch("/api/gpu");
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      return { ok: false, error: body.error || `HTTP ${res.status}` };
    }
    return await res.json();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
