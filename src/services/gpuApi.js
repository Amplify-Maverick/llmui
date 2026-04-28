const GPU_API = "http://localhost:3001/api/gpu";
const TOKEN_API = "/api/llmui-token";

let authToken = null;
let tokenPromise = null;

async function getToken() {
  if (authToken) return authToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = fetch(TOKEN_API)
    .then((res) => {
      if (!res.ok) {
        throw new Error(`Failed to fetch auth token (${res.status})`);
      }
      return res.json();
    })
    .then((data) => {
      authToken = data.token;
      return authToken;
    })
    .catch((error) => {
      tokenPromise = null;
      throw error;
    });

  return tokenPromise;
}

/**
 * Fetches live GPU stats from the authenticated Express server endpoint.
 * Returns { ok, gpus, timestamp } on success, or { ok: false, error } on failure.
 */
export async function fetchGpuStats() {
  try {
    const token = await getToken();
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
