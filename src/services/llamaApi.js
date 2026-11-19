/**
 * llama.cpp router management + Hugging Face search, all through the
 * authenticated Express proxy at /api/llama (the browser never talks to the
 * model server or the HF API directly).
 */

import { authHeaders } from "./auth.js";

const BASE = "/api/llama";
const GiB = 1024 ** 3;

async function call(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: await authHeaders(),
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

export const llamaApi = {
  /** { models: [...], gpu: { name, total, margin, budget, source } } */
  list: () => call("GET", "/models"),
  install: (model) => call("POST", "/models", { model }),
  remove: (model) => call("DELETE", `/models?model=${encodeURIComponent(model)}`),
  load: (model) => call("POST", "/models/load", { model }),
  unload: (model) => call("POST", "/models/unload", { model }),
  searchHF: (q) => call("GET", `/hf/search?q=${encodeURIComponent(q)}`),
  repoFiles: (repo) => call("GET", `/hf/files?repo=${encodeURIComponent(repo)}`),

  /**
   * Subscribe to router events ({ type, model, data }). Reconnects after a
   * drop until the returned function is called.
   */
  subscribe(onEvent, onConnectionChange = () => {}) {
    let stopped = false;
    let controller;

    const run = async () => {
      while (!stopped) {
        controller = new AbortController();
        try {
          const response = await fetch(`${BASE}/events`, {
            headers: { ...(await authHeaders()), Accept: "text/event-stream" },
            signal: controller.signal,
          });
          if (!response.ok) throw new Error(`events ${response.status}`);
          onConnectionChange(true);
          const reader = response.body.getReader();
          const decoder = new TextDecoder();
          let buffer = "";
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let sep;
            while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
              const raw = buffer.slice(0, sep);
              buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
              const data = raw
                .split(/\r?\n/)
                .filter((l) => l.startsWith("data:"))
                .map((l) => l.slice(5).replace(/^ /, ""))
                .join("\n");
              if (!data) continue;
              try {
                onEvent(JSON.parse(data));
              } catch {
                // malformed event
              }
            }
          }
        } catch {
          // dropped or failed; retry below
        }
        onConnectionChange(false);
        if (!stopped) await new Promise((r) => setTimeout(r, 3000));
      }
    };
    run();
    return () => {
      stopped = true;
      controller?.abort();
    };
  },
};

/**
 * Bytes done/total from a download_progress payload. Accepts { done, total },
 * { downloaded, total }, or a map of file → { done, total } (summed).
 */
export function parseProgress(data) {
  if (!data || typeof data !== "object") return null;
  const pick = (o) => {
    const done = o.done ?? o.downloaded ?? o.current;
    return typeof done === "number" && typeof o.total === "number" ? { done, total: o.total } : null;
  };
  const direct = pick(data);
  if (direct) return direct;
  let done = 0, total = 0, any = false;
  for (const v of Object.values(data)) {
    const p = v && typeof v === "object" ? pick(v) : null;
    if (p) {
      done += p.done;
      total += p.total;
      any = true;
    }
  }
  return any ? { done, total } : null;
}

/** Headroom for context + compute buffers when estimating fit from file size. */
export const RUNTIME_OVERHEAD_BYTES = 1 * GiB;

/**
 * GPU fit of a GGUF of `fileBytes`: file + ~1 GiB for context/compute,
 * against total VRAM minus the router's memory margin.
 * Returns { level: "fits" | "tight" | "nofit", need, budget }.
 */
export function estimateFit(fileBytes, gpu) {
  const need = fileBytes + RUNTIME_OVERHEAD_BYTES;
  const budget = gpu?.budget ?? 7 * GiB;
  const level = need <= budget * 0.9 ? "fits" : need <= budget ? "tight" : "nofit";
  return { level, need, budget };
}

export const FIT_LABEL = { fits: "Fits on GPU", tight: "Tight", nofit: "Won't fit" };
