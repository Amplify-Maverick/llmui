/**
 * llama.cpp router-mode upstreams: one per machine (server/backends.js).
 *
 * API keys are only ever attached server-side, here — never returned to the
 * browser. The default machine's key is LLAMA_API_KEY (env var, which wins, or
 * LLAMA_API_KEY=... in ~/.llmui/llama.env); other machines read their own key
 * file (a bare key, or LLAMA_API_KEY=...). Files are re-read whenever their
 * mtime changes, so editing them doesn't need a server restart.
 */

import fs from "fs";
import { defaultMachine } from "./backends.js";

/** The default machine's OpenAI-compatible base, including /v1 (for logs). */
export const OPENAI_BASE_URL = defaultMachine().openaiUrl;

const keyCache = new Map(); // path → { mtimeMs, key }
const warned = new Set();

/** LLAMA_API_KEY=... if present, else the first non-comment line (a bare key). */
export function parseKeyFile(text) {
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
  for (const line of lines) {
    const m = /^(?:export\s+)?LLAMA_API_KEY\s*=\s*(.*)$/.exec(line);
    if (m) return m[1].replace(/^(['"])(.*)\1$/, "$2").trim();
  }
  const bare = lines.find((l) => !l.includes("="));
  return bare || "";
}

function readKeyFile(file) {
  try {
    const { mtimeMs } = fs.statSync(file);
    const hit = keyCache.get(file);
    if (hit && hit.mtimeMs === mtimeMs) return hit.key;
    const key = parseKeyFile(fs.readFileSync(file, "utf-8"));
    keyCache.set(file, { mtimeMs, key });
    warned.delete(file);
    return key;
  } catch {
    keyCache.delete(file);
    return "";
  }
}

export function getLlamaApiKey(machine) {
  if (machine.llamaKeyEnv && process.env[machine.llamaKeyEnv]) return process.env[machine.llamaKeyEnv];
  const key = readKeyFile(machine.llamaKeyPath);
  if (!key && !warned.has(machine.llamaKeyPath)) {
    console.warn(`${machine.name}: no llama API key (checked ${machine.llamaKeyEnv ? `$${machine.llamaKeyEnv} and ` : ""}${machine.llamaKeyPath}); upstream requests will be unauthenticated.`);
    warned.add(machine.llamaKeyPath);
  }
  return key;
}

/** Headers for an upstream request to `machine`, with its bearer key added. */
export function llamaHeaders(machine, extra = {}) {
  const key = getLlamaApiKey(machine);
  return key ? { ...extra, Authorization: `Bearer ${key}` } : { ...extra };
}

/** fetch() against a machine's router root (no /v1), authenticated. */
export function llamaFetch(machine, upstreamPath, init = {}) {
  return fetch(`${machine.rootUrl}${upstreamPath}`, {
    ...init,
    headers: llamaHeaders(machine, init.headers),
  });
}

/** "Model server rejected the API key" hint naming the right key file. */
export function keyHint(machine) {
  return machine.llamaKeyEnv
    ? `check ${machine.llamaKeyEnv} in ~/.llmui/${machine.llamaKeyFile}`
    : `check ~/.llmui/${machine.llamaKeyFile}`;
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
