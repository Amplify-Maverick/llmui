/**
 * llama.cpp router-mode upstream: base URLs and the API key.
 *
 * The key lives in ~/.llmui/llama.env as LLAMA_API_KEY (or the LLAMA_API_KEY
 * env var, which wins). It is only ever attached server-side, here — never
 * returned to the browser. The file is re-read whenever its mtime changes, so
 * editing it doesn't need a server restart.
 */

import fs from "fs";
import os from "os";
import path from "path";

/** OpenAI-compatible base, including /v1 (chat completions etc.). */
export const OPENAI_BASE_URL = (
  process.env.OPENAI_BASE_URL || "http://100.118.190.15:8081/v1"
).replace(/\/+$/, "");

/** Router-management base (no /v1): /models, /models/load, /models/sse, ... */
export const LLAMA_ROOT_URL = OPENAI_BASE_URL.replace(/\/v1$/, "");

const ENV_FILE = path.join(os.homedir(), ".llmui", "llama.env");

let cached = { mtimeMs: -1, key: "" };
let warned = false;

function parseEnvFile(text) {
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?LLAMA_API_KEY\s*=\s*(.*)\s*$/.exec(line);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  return "";
}

export function getLlamaApiKey() {
  if (process.env.LLAMA_API_KEY) return process.env.LLAMA_API_KEY;
  try {
    const { mtimeMs } = fs.statSync(ENV_FILE);
    if (mtimeMs !== cached.mtimeMs) {
      cached = { mtimeMs, key: parseEnvFile(fs.readFileSync(ENV_FILE, "utf-8")) };
      warned = false;
    }
  } catch {
    cached = { mtimeMs: -1, key: "" };
  }
  if (!cached.key && !warned) {
    console.warn(`LLAMA_API_KEY is not set (checked env and ${ENV_FILE}); upstream requests will be unauthenticated.`);
    warned = true;
  }
  return cached.key;
}

/** Headers for an upstream request, with the bearer key added. */
export function llamaHeaders(extra = {}) {
  const key = getLlamaApiKey();
  return key ? { ...extra, Authorization: `Bearer ${key}` } : { ...extra };
}

/** fetch() against the router root (no /v1), authenticated. */
export function llamaFetch(upstreamPath, init = {}) {
  return fetch(`${LLAMA_ROOT_URL}${upstreamPath}`, {
    ...init,
    headers: llamaHeaders(init.headers),
  });
}

/** Extract a readable message from a failed upstream response. */
export async function upstreamError(response) {
  const text = await response.text();
  try {
    const err = JSON.parse(text).error;
    return (typeof err === "string" ? err : err?.message) || text;
  } catch {
    return text || `Upstream error (${response.status})`;
  }
}
