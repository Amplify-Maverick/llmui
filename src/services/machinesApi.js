/**
 * Compute machines (server/backends.js): status, the persisted choice, and
 * live GPU stats from each machine's sd-fetch helper.
 */

import { authHeaders } from "./auth.js";

async function call(method, path, body, init = {}) {
  const response = await fetch(path, {
    method,
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
    ...init,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const err = new Error(data.error || `Request failed (${response.status})`);
    err.status = response.status;
    err.body = data;
    throw err;
  }
  return data;
}

export const machinesApi = {
  /** { selected, defaultId, effective: { chat, image }, fallback: { chat, image }, machines: [...] } */
  status: () => call("GET", "/api/machines", undefined, { signal: AbortSignal.timeout(10000) }),
  /** Same shape as status(), after the switch. */
  select: (id) => call("PUT", "/api/machines/selected", { id }),
};
