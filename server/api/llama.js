/**
 * llama.cpp router management, proxied with the server-side API key.
 * Mounted at /api/llama behind requireAuth; the browser never talks to the
 * model server (or Hugging Face) directly.
 */

import express from "express";
import { llamaFetch, upstreamError } from "../llama.js";

const router = express.Router();

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;
// Mirrors the router's --models-memory-margin (MiB kept free per device).
export const MEMORY_MARGIN_BYTES = (Number(process.env.LLAMA_MEMORY_MARGIN_MB) || 1024) * MiB;
// Used only until some model has reported its device memory.
const FALLBACK_VRAM_BYTES = Number(process.env.LLAMA_GPU_VRAM_BYTES) || 8 * GiB;

// "name", "owner/repo" or "owner/repo:QUANT"
// Path segments may not be "." or "..".
const SEG = "(?!\\.\\.?(?:[/:]|$))[\\w.-]+";
const MODEL_ID_RE = new RegExp(`^${SEG}(?:/${SEG})?(?::[\\w.-]+)?$`);
const REPO_RE = new RegExp(`^${SEG}/${SEG}$`);

/** Normalise one entry of the router's GET /models list. */
export function normalizeModel(m) {
  return {
    id: m.id,
    status: m.status?.value || "unknown",
    failed: !!m.status?.failed,
    canRemove: m.can_remove ?? true,
    memory: m.memory || null,
    contextLength: m.meta?.n_ctx || null,
    size: m.meta?.size || 0,
  };
}

/** The GPU entry of a memory snapshot ({ n_ctx, devices[] }): kind "device", not "host". */
export function gpuDevice(snapshot) {
  return snapshot?.devices?.find((d) => d.kind !== "host" && d.total) || null;
}

/** Bytes a model needs on the GPU according to one memory snapshot. */
export function gpuBytes(snapshot) {
  const d = gpuDevice(snapshot);
  return d ? (d.model || 0) + (d.context || 0) + (d.compute || 0) : null;
}

async function upstreamJson(res, response) {
  if (!response.ok) {
    return res.status(response.status === 401 ? 502 : response.status).json({
      error: response.status === 401
        ? "Model server rejected the API key (check LLAMA_API_KEY in ~/.llmui/llama.env)"
        : await upstreamError(response),
    });
  }
  res.json(await response.json().catch(() => ({ success: true })));
}

async function listModels() {
  const response = await llamaFetch("/models", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const err = new Error(
      response.status === 401
        ? "Model server rejected the API key (check LLAMA_API_KEY in ~/.llmui/llama.env)"
        : await upstreamError(response)
    );
    err.status = response.status === 401 ? 502 : response.status;
    throw err;
  }
  const data = await response.json();
  return (data.data || data.models || []).map(normalizeModel);
}

/** GPU size as reported by the router (any model's measured device), else a fallback. */
function gpuInfo(models) {
  for (const m of models) {
    for (const snap of [m.memory?.effective, m.memory?.min, m.memory?.max]) {
      const d = gpuDevice(snap);
      if (d) return { name: d.name, total: d.total, source: "measured" };
    }
  }
  return { name: null, total: FALLBACK_VRAM_BYTES, source: "assumed" };
}

// GET /api/llama/models — every model the router knows about, with status,
// plus the GPU size and memory margin used for fit estimates.
router.get("/models", async (req, res) => {
  try {
    const models = await listModels();
    const gpu = gpuInfo(models);
    res.json({
      models,
      gpu: { ...gpu, margin: MEMORY_MARGIN_BYTES, budget: gpu.total - MEMORY_MARGIN_BYTES },
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.status ? err.message : `Model server unreachable: ${err.message}` });
  }
});

function requireModelId(value, res) {
  if (typeof value !== "string" || !MODEL_ID_RE.test(value)) {
    res.status(400).json({ error: "Invalid model id (expected owner/repo or owner/repo:QUANT)" });
    return false;
  }
  return true;
}

const postJson = (path, body) =>
  llamaFetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

// POST /api/llama/models { model: "owner/repo:QUANT" } — start a download (non-blocking).
router.post("/models", async (req, res) => {
  const { model } = req.body || {};
  if (!requireModelId(model, res)) return;
  try {
    await upstreamJson(res, await postJson("/models", { model }));
  } catch (err) {
    res.status(502).json({ error: `Model server unreachable: ${err.message}` });
  }
});

// DELETE /api/llama/models?model=<id> — remove a cached model.
router.delete("/models", async (req, res) => {
  const { model } = req.query;
  if (!requireModelId(model, res)) return;
  try {
    await upstreamJson(res, await llamaFetch(`/models?model=${encodeURIComponent(model)}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(30000),
    }));
  } catch (err) {
    res.status(502).json({ error: `Model server unreachable: ${err.message}` });
  }
});

// POST /api/llama/models/load|unload { model }
for (const action of ["load", "unload"]) {
  router.post(`/models/${action}`, async (req, res) => {
    const { model } = req.body || {};
    if (!requireModelId(model, res)) return;
    try {
      await upstreamJson(res, await postJson(`/models/${action}`, { model }));
    } catch (err) {
      res.status(502).json({ error: `Model server unreachable: ${err.message}` });
    }
  });
}

/**
 * Parse an SSE body into { event, data } (event is null when the stream
 * doesn't use `event:` lines).
 */
async function* readSSEEvents(body, signal) {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body) {
    if (signal?.aborted) return;
    buffer += decoder.decode(chunk, { stream: true });
    let match;
    while ((match = /\r?\n\r?\n/.exec(buffer))) {
      const raw = buffer.slice(0, match.index);
      buffer = buffer.slice(match.index + match[0].length);
      let event = null;
      const data = [];
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data.push(line.slice(5).replace(/^ /, ""));
      }
      if (data.length) yield { event, data: data.join("\n") };
    }
  }
}

/**
 * Normalise a router SSE event to { type, model, data }. Handles both
 * `event: <type>` framing and a JSON payload carrying { event|type, model, data }.
 */
export function normalizeEvent(event, rawData) {
  let payload;
  try {
    payload = JSON.parse(rawData);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") return null;
  const type = event || payload.event || payload.type;
  if (!type) return null;
  const data = "data" in payload ? payload.data : payload;
  return { type, model: payload.model ?? data?.model ?? null, data };
}

// GET /api/llama/events — the router's /models/sse, re-emitted as one JSON
// object per `data:` line: { type, model, data }.
router.get("/events", async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await llamaFetch("/models/sse", {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch (err) {
    return res.status(502).json({ error: `Model server unreachable: ${err.message}` });
  }
  if (!upstream.ok) return upstreamJson(res, upstream);

  res.status(200);
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  res.write(": connected\n\n");
  const heartbeat = setInterval(() => res.write(": ping\n\n"), 20000);

  try {
    for await (const { event, data } of readSSEEvents(upstream.body, controller.signal)) {
      const ev = normalizeEvent(event, data);
      if (ev) res.write(`data: ${JSON.stringify(ev)}\n\n`);
    }
  } catch (err) {
    if (err.name !== "AbortError") console.error("Router SSE proxy error:", err.message);
  } finally {
    clearInterval(heartbeat);
    if (!res.writableEnded) res.end();
  }
});

// ------------------------------------------------------------
// Hugging Face search (GGUF repos) — proxied so the browser stays on-origin
// ------------------------------------------------------------

const HF = "https://huggingface.co/api";
const hfFetch = (url) =>
  fetch(url, { headers: { "User-Agent": "llmui" }, signal: AbortSignal.timeout(15000) });

// GET /api/llama/hf/search?q=... — GGUF repos, most downloaded first.
router.get("/hf/search", async (req, res) => {
  const q = String(req.query.q || "").trim().slice(0, 100);
  const params = new URLSearchParams({ filter: "gguf", sort: "downloads", direction: "-1", limit: "30" });
  if (q) params.set("search", q);
  try {
    const response = await hfFetch(`${HF}/models?${params}`);
    if (!response.ok) return res.status(502).json({ error: `Hugging Face error (${response.status})` });
    const data = await response.json();
    res.json({
      repos: data.map((r) => ({
        id: r.id,
        downloads: r.downloads || 0,
        likes: r.likes || 0,
        pipelineTag: r.pipeline_tag || null,
        updatedAt: r.lastModified || r.createdAt || null,
      })),
    });
  } catch (err) {
    res.status(502).json({ error: `Hugging Face unreachable: ${err.message}` });
  }
});

// Quant tag in a GGUF filename/path: Q4_K_M, IQ3_XXS, UD-Q4_K_XL, Q8_0, F16, BF16, MXFP4, TQ1_0...
const QUANT_RE = /(?:^|[-_./])((?:UD-)?(?:I?Q\d(?:_[A-Z0-9]+)*|TQ\d_\d|MXFP4(?:_MOE)?|BF16|F16|F32))(?=[-_./]|$)/i;
const SHARD_RE = /-(\d{5})-of-(\d{5})\.gguf$/i;

/** Group a repo's GGUF files by quant, summing split shards. */
export function groupQuants(files) {
  const quants = new Map();
  let hasMmproj = false;
  for (const f of files) {
    if (f.type !== "file" || !/\.gguf$/i.test(f.path)) continue;
    const name = f.path.split("/").pop();
    if (/mmproj/i.test(name)) {
      hasMmproj = true;
      continue;
    }
    // Prefer the quant in the filename; fall back to a directory name.
    const m = QUANT_RE.exec(name.replace(SHARD_RE, ".gguf")) || QUANT_RE.exec(f.path);
    if (!m) continue;
    const tag = m[1].toUpperCase();
    const size = f.lfs?.size ?? f.size ?? 0;
    const q = quants.get(tag) || { quant: tag, size: 0, files: [] };
    q.size += size;
    q.files.push(f.path);
    quants.set(tag, q);
  }
  return {
    hasMmproj,
    quants: [...quants.values()].sort((a, b) => a.size - b.size),
  };
}

// GET /api/llama/hf/files?repo=owner/name — quant files with sizes.
router.get("/hf/files", async (req, res) => {
  const repo = String(req.query.repo || "");
  if (!REPO_RE.test(repo)) return res.status(400).json({ error: "Invalid repo" });
  try {
    const [owner, name] = repo.split("/");
    const response = await hfFetch(
      `${HF}/models/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/tree/main?recursive=true`
    );
    if (!response.ok) {
      return res.status(response.status === 404 ? 404 : 502).json({ error: `Hugging Face error (${response.status})` });
    }
    res.json({ repo, ...groupQuants(await response.json()) });
  } catch (err) {
    res.status(502).json({ error: `Hugging Face unreachable: ${err.message}` });
  }
});

export default router;
