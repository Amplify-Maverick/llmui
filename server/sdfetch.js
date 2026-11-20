/**
 * Client for sd-fetch, the download/GPU-stats helper on each machine
 * (deploy/sd-fetch/sd-fetch.py). Only the Express server talks to it; each
 * machine's bearer token stays in its token file under ~/.llmui (see
 * server/backends.js) and never reaches the browser.
 */

import fs from "fs/promises";
import { getSdConfig } from "./sd.js";

export class FetchHelperError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.status = status;
  }
}

/** The token, re-read on every call so installing it needs no restart. */
async function readToken(machine) {
  try {
    return (await fs.readFile(machine.fetchTokenPath, "utf-8")).trim();
  } catch (err) {
    if (err.code === "ENOENT") return "";
    throw err;
  }
}

const tokenName = (machine) => `~/.llmui/${machine.fetchTokenFile}`;

/** { configured, reason } — whether a URL and token are present for `machine`. */
export async function helperConfigured(machine) {
  const url = getSdConfig(machine).fetchUrl;
  if (!url) return { configured: false, reason: `fetchUrl is not set in ~/.llmui/${machine.sdConfigFile}` };
  if (!(await readToken(machine))) return { configured: false, reason: `no token in ${tokenName(machine)}` };
  return { configured: true, reason: null };
}

/** JSON request to a machine's sd-fetch; throws FetchHelperError with its error text. */
export async function fetchHelper(machine, p, { method = "GET", body, timeout = 15000 } = {}) {
  const base = String(getSdConfig(machine).fetchUrl || "").replace(/\/+$/, "");
  const token = await readToken(machine);
  if (!base || !token) {
    throw new FetchHelperError(`${machine.name}'s download helper isn't configured on the LLMUI server`, 503);
  }
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
    throw new FetchHelperError(`${machine.name} download helper unreachable (${base}): ${err.cause?.code || err.message}`);
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = response.status === 401
      ? `${machine.name}'s download helper rejected the token (check ${tokenName(machine)} matches /etc/sd/fetch.env)`
      : data.error || `Download helper HTTP ${response.status}`;
    // Pass through client errors (bad request, conflict, no space); anything else is a gateway error.
    const status = [400, 404, 409, 507].includes(response.status) ? response.status : 502;
    throw new FetchHelperError(msg, status);
  }
  return data;
}

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

/**
 * One GPU from sd-fetch's GET /v1/gpu ({ index, name, vendor, state, temp_c, util_pct,
 * vram_used_mib, vram_total_mib, power_w }, any of them null) in the shape the
 * UI uses. Missing values stay null. state is "asleep" for an AMD card that has
 * runtime-suspended (only VRAM is read then), else "active".
 */
export function normalizeHelperGpu(g, i = 0) {
  return {
    index: Number.isInteger(g?.index) ? g.index : i,
    name: typeof g?.name === "string" && g.name ? g.name : null,
    vendor: g?.vendor || null,
    state: g?.state === "asleep" ? "asleep" : "active",
    temperature: num(g?.temp_c),
    utilization: num(g?.util_pct),
    memoryUsed: num(g?.vram_used_mib),
    memoryTotal: num(g?.vram_total_mib),
    powerDraw: num(g?.power_w),
  };
}
