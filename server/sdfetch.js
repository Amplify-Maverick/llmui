/**
 * Client for sd-fetch, the download helper on the sd-server host
 * (deploy/sd-fetch/sd-fetch.py). Only the Express server talks to it; the
 * bearer token stays in ~/.llmui/sd-fetch.token and never reaches the browser.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { getSdConfig } from "./sd.js";

export const TOKEN_FILE = path.join(os.homedir(), ".llmui", "sd-fetch.token");

export class FetchHelperError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** The token, re-read on every call so installing it needs no restart. */
async function readToken() {
  try {
    return (await fs.readFile(TOKEN_FILE, "utf-8")).trim();
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

/** { configured, reason } — whether a URL and token are present. */
export async function helperConfigured() {
  const url = getSdConfig().fetchUrl;
  if (!url) return { configured: false, reason: "fetchUrl is not set in ~/.llmui/sd_config.json" };
  if (!(await readToken())) return { configured: false, reason: `no token in ${TOKEN_FILE}` };
  return { configured: true, reason: null };
}

/** JSON request to sd-fetch; throws FetchHelperError with its error text. */
export async function fetchHelper(p, { method = "GET", body, timeout = 15000 } = {}) {
  const base = String(getSdConfig().fetchUrl || "").replace(/\/+$/, "");
  const token = await readToken();
  if (!base || !token) throw new FetchHelperError("The download helper isn't configured on the LLMUI server", 503);
  let response;
  try {
    response = await fetch(`${base}${p}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new FetchHelperError(`Download helper unreachable (${base}): ${err.cause?.code || err.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = response.status === 401
      ? "Download helper rejected the token (check ~/.llmui/sd-fetch.token matches /etc/sd/fetch.env)"
      : data.error || `Download helper HTTP ${response.status}`;
    // Pass through client errors (bad request, conflict, no space); anything else is a gateway error.
    const status = [400, 404, 409, 507].includes(response.status) ? response.status : 502;
    throw new FetchHelperError(msg, status);
  }
  return data;
}
