/**
 * Centralized auth token management — singleton pattern ensures a cold start
 * fetches the token exactly once, regardless of how many modules import this.
 */

const TOKEN_API = "/api/llmui-token";

let authToken = null;
let tokenPromise = null;

/**
 * Fetches and caches the auth token. Subsequent calls return the cached value.
 * @returns {Promise<string>}
 */
export async function getAuthToken() {
  if (authToken) return authToken;
  if (tokenPromise) return tokenPromise;

  tokenPromise = fetch(TOKEN_API)
    .then((res) => {
      if (!res.ok) {
        throw new Error(
          `Failed to fetch auth token (${res.status}). ` +
            "Ensure the storage server is running (node server/index.js) " +
            "and the Vite dev server is active."
        );
      }
      return res.json();
    })
    .then((data) => {
      authToken = data.token;
      return authToken;
    })
    .catch((error) => {
      console.error("[LLMUI] Auth token fetch failed:", error.message);
      tokenPromise = null;
      throw error;
    });

  return tokenPromise;
}

/**
 * Clears the cached token, forcing a re-fetch on the next getAuthToken() call.
 * Use after token rotation or pairing failure.
 */
export function clearAuthToken() {
  authToken = null;
  tokenPromise = null;
}

/**
 * Returns standard auth headers with Content-Type and Authorization.
 * @returns {Promise<Record<string, string>>}
 */
export async function authHeaders() {
  const token = await getAuthToken();
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${token}`,
  };
}
