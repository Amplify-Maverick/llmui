/**
 * Browser auth (docs/api.md §2.4). The page never holds a token: POST
 * /api/session sets an HttpOnly session cookie (the server issues it to
 * tailnet users arriving through tailscale serve, and to browsers on the
 * server itself), and every API request carries `X-LLMUI-Web: 1` alongside
 * the cookie. If a request comes back 401 (the session expired, or the server
 * rotated its secret), the session is renewed once and the request retried.
 */

const SESSION_API = "/api/session";
const WEB_HEADER = "X-LLMUI-Web";

let sessionPromise = null;

/** Get (or renew, with `renew`) the session cookie. Resolves with the identity; rejects if refused. */
export function ensureSession(renew = false) {
  if (sessionPromise && !renew) return sessionPromise;
  sessionPromise = nativeFetch(SESSION_API, { method: "POST", credentials: "same-origin", cache: "no-store" })
    .then(async (res) => {
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(body.error || `Sign-in failed (${res.status})`), { status: res.status });
      return body.identity;
    })
    .catch((err) => {
      sessionPromise = null;
      throw err;
    });
  return sessionPromise;
}

/** Headers for an API request: JSON, plus the header that goes with the session cookie. */
export async function authHeaders() {
  await ensureSession();
  return { "Content-Type": "application/json", [WEB_HEADER]: "1" };
}

/** Just the session header (for requests that set their own Content-Type, or none). */
export async function sessionHeader() {
  await ensureSession();
  return { [WEB_HEADER]: "1" };
}

// Retry an API request once after renewing an expired session.
const nativeFetch = typeof window !== "undefined" ? window.fetch.bind(window) : fetch;

function usesSession(init) {
  const h = init?.headers;
  if (!h) return false;
  return h instanceof Headers ? h.get(WEB_HEADER) === "1" : h[WEB_HEADER] === "1";
}

if (typeof window !== "undefined") {
  window.fetch = async (input, init) => {
    const res = await nativeFetch(input, init);
    if (res.status !== 401 || !usesSession(init) || typeof init?.body?.getReader === "function") return res;
    try {
      await ensureSession(true);
    } catch {
      return res;
    }
    return nativeFetch(input, init);
  };
}
