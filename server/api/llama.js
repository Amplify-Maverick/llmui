/**
 * llama.cpp router management, proxied with the server-side API key.
 * Mounted at /api/llama behind requireAuth and routeTo("chat"), so every
 * upstream call goes to req.machine (server/backends.js). The browser never
 * talks to the model server (or Hugging Face) directly.
 */

import express from "express";
import { llamaFetch, upstreamError, keyHint } from "../llama.js";
import { publicMachine } from "../backends.js";
import { parseHfLink, fetchRepoInfo } from "../hflink.js";

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
    failed: !!m.status?.failed || m.memory?.status === "failed",
    exitCode: m.status?.exit_code ?? null,
    canRemove: m.can_remove ?? true,
    memory: m.memory || null,
    // Runtime context (--ctx-size), not the training context (context_length).
    contextLength: m.memory?.effective?.n_ctx || m.meta?.n_ctx || m.memory?.min?.n_ctx || null,
    size: m.meta?.size || 0,
    // Extra files installed with the model, e.g. ["mmproj"] (vision projector).
    sidecars: Array.isArray(m.sidecars) ? m.sidecars : [],
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

async function upstreamJson(req, res, response) {
  if (!response.ok) {
    return res.status(response.status === 401 ? 502 : response.status).json({
      error: response.status === 401
        ? `${req.machine.name}'s model server rejected the API key (${keyHint(req.machine)})`
        : await upstreamError(response),
    });
  }
  res.json(await response.json().catch(() => ({ success: true })));
}

async function listModels(machine) {
  const response = await llamaFetch(machine, "/models", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const err = new Error(
      response.status === 401
        ? `${machine.name}'s model server rejected the API key (${keyHint(machine)})`
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

// ------------------------------------------------------------
// mmproj (vision projector) file sizes. llama.cpp's memory report doesn't
// count the projector yet, so the UI adds an allowance based on this size.
// ------------------------------------------------------------

const mmprojCache = new Map(); // model id → { gguf, mmproj, at }
const MMPROJ_RETRY_MS = 10 * 60 * 1000;

/** "owner/repo:QUANT" → manifest URL (the endpoint llama.cpp's -hf uses), or null for local names. */
export function manifestUrl(id) {
  const m = /^([^/:]+)\/([^/:]+)(?::(.+))?$/.exec(id || "");
  if (!m) return null;
  return `https://huggingface.co/v2/${encodeURIComponent(m[1])}/${encodeURIComponent(m[2])}/manifests/${encodeURIComponent(m[3] || "latest")}`;
}

/**
 * File sizes from a model's HF manifest: { gguf, mmproj } in bytes (null when
 * unknown). Cached; an unknown result is retried after MMPROJ_RETRY_MS.
 */
async function manifestSizes(id) {
  const hit = mmprojCache.get(id);
  if (hit && (hit.gguf != null || Date.now() - hit.at < MMPROJ_RETRY_MS)) return hit;
  const sizes = { gguf: null, mmproj: null, at: Date.now() };
  const url = manifestUrl(id);
  if (url) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": "llama-cpp" }, signal: AbortSignal.timeout(8000) });
      if (r.ok) {
        const body = await r.json();
        const num = (v) => (typeof v === "number" && v > 0 ? v : null);
        sizes.gguf = num(body?.ggufFile?.size);
        sizes.mmproj = num(body?.mmprojFile?.size);
      }
    } catch {
      // unknown → flat allowance / no size in the UI; retried after MMPROJ_RETRY_MS
    }
  }
  mmprojCache.set(id, sizes);
  return sizes;
}

// GET /api/llama/models — every model the router knows about, with status,
// plus the GPU size and memory margin used for fit estimates.
router.get("/models", async (req, res) => {
  try {
    const listed = await listModels(req.machine);
    const gpu = gpuInfo(listed);
    // ?sizes=1 (System page): also each model's size on disk (GGUF + installed
    // projector) from its HF manifest; the router reports none while unloaded.
    const wantSizes = req.query.sizes === "1";
    const models = await Promise.all(
      listed.map(async (m) => {
        const hasMmproj = m.sidecars.includes("mmproj");
        if (!hasMmproj && !wantSizes) return m;
        const sizes = await manifestSizes(m.id);
        const out = hasMmproj ? { ...m, mmprojFileSize: sizes.mmproj } : { ...m };
        if (wantSizes) out.diskSize = sizes.gguf != null ? sizes.gguf + (hasMmproj ? sizes.mmproj || 0 : 0) : null;
        return out;
      })
    );
    res.json({
      machine: publicMachine(req.machine),
      models,
      gpu: { ...gpu, margin: MEMORY_MARGIN_BYTES, budget: gpu.total - MEMORY_MARGIN_BYTES },
    });
  } catch (err) {
    res.status(err.status || 502).json({
      error: err.status ? err.message : `${req.machine.name}'s model server unreachable: ${err.cause?.code || err.message}`,
    });
  }
});

function requireModelId(value, res) {
  if (typeof value !== "string" || !MODEL_ID_RE.test(value)) {
    res.status(400).json({ error: "Invalid model id (expected owner/repo or owner/repo:QUANT)" });
    return false;
  }
  return true;
}

const postJson = (machine, path, body) =>
  llamaFetch(machine, path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

// GET /api/llama/props?model=<id> — runtime context size of a model.
// Only for models that are already loaded: a request naming an unloaded model
// would make the router autoload it.
router.get("/props", async (req, res) => {
  const { model } = req.query;
  if (!requireModelId(model, res)) return;
  try {
    const m = (await listModels(req.machine)).find((x) => x.id === model);
    if (!m) return res.status(404).json({ error: "Unknown model" });
    if (m.status !== "loaded") return res.json({ model, contextLength: m.contextLength, loaded: false });
    const response = await llamaFetch(req.machine, `/props?model=${encodeURIComponent(model)}`, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) return upstreamJson(req, res, response);
    const props = await response.json();
    res.json({
      model,
      loaded: true,
      contextLength: props.default_generation_settings?.n_ctx || props.n_ctx || m.contextLength,
    });
  } catch (err) {
    res.status(err.status || 502).json({ error: err.message });
  }
});

const SIDECARS = new Set(["mmproj"]);

// POST /api/llama/models { model: "owner/repo:QUANT", sidecars?: ["mmproj"] | [] }
// — start a download (non-blocking).
router.post("/models", async (req, res) => {
  const { model, sidecars } = req.body || {};
  if (!requireModelId(model, res)) return;
  if (sidecars !== undefined && (!Array.isArray(sidecars) || !sidecars.every((s) => SIDECARS.has(s)))) {
    return res.status(400).json({ error: "Invalid sidecars (allowed: mmproj)" });
  }
  try {
    await upstreamJson(req, res, await postJson(req.machine, "/models", sidecars === undefined ? { model } : { model, sidecars }));
  } catch (err) {
    res.status(502).json({ error: `${req.machine.name}'s model server unreachable: ${err.cause?.code || err.message}` });
  }
});

// DELETE /api/llama/models?model=<id>[&sidecar=mmproj] — remove a cached
// model, or only one of its sidecar files.
router.delete("/models", async (req, res) => {
  const { model, sidecar } = req.query;
  if (!requireModelId(model, res)) return;
  if (sidecar !== undefined && !SIDECARS.has(sidecar)) {
    return res.status(400).json({ error: "Invalid sidecar (allowed: mmproj)" });
  }
  const qs = `model=${encodeURIComponent(model)}${sidecar ? `&sidecar=${sidecar}` : ""}`;
  try {
    await upstreamJson(req, res, await llamaFetch(req.machine, `/models?${qs}`, {
      method: "DELETE",
      signal: AbortSignal.timeout(30000),
    }));
  } catch (err) {
    res.status(502).json({ error: `${req.machine.name}'s model server unreachable: ${err.cause?.code || err.message}` });
  }
});

// POST /api/llama/models/load|unload { model }
for (const action of ["load", "unload"]) {
  router.post(`/models/${action}`, async (req, res) => {
    const { model } = req.body || {};
    if (!requireModelId(model, res)) return;
    try {
      await upstreamJson(req, res, await postJson(req.machine, `/models/${action}`, { model }));
    } catch (err) {
      res.status(502).json({ error: `${req.machine.name}'s model server unreachable: ${err.cause?.code || err.message}` });
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
  const ev = { type, model: payload.model ?? data?.model ?? null, data };
  // Bytes { done, total } summed over the model's files, so clients don't
  // have to know the router's progress shape.
  if (type === "download_progress") ev.progress = parseProgress(data);
  return ev;
}

/**
 * { done, total } bytes from a router download_progress payload: either
 * { done|downloaded|current, total } or an object of those per file (summed).
 * null when the payload has neither.
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

// GET /api/llama/events — the router's /models/sse, re-emitted as one JSON
// object per `data:` line: { type, model, data } (+ progress on download_progress).
router.get("/events", async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => controller.abort());

  let upstream;
  try {
    upstream = await llamaFetch(req.machine, "/models/sse", {
      headers: { Accept: "text/event-stream" },
      signal: controller.signal,
    });
  } catch (err) {
    return res.status(502).json({ error: `${req.machine.name}'s model server unreachable: ${err.cause?.code || err.message}` });
  }
  if (!upstream.ok) return upstreamJson(req, res, upstream);

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

// Only chat/vision LLMs: other GGUF repos (music, TTS, embeddings, diffusion)
// download fine but llama-server can't run them.
export const CHAT_PIPELINE_TAGS = new Set(["text-generation", "image-text-to-text"]);

// GET /api/llama/hf/search?q=... — GGUF chat-model repos, most downloaded first.
// A Hugging Face link as q gives just that repo, plus { link: { repo, quant,
// file, revision } } naming what it pointed at.
router.get("/hf/search", async (req, res) => {
  const raw = String(req.query.q || "").trim();
  const link = parseHfLink(raw.slice(0, 2000));
  if (link?.error) return res.status(400).json({ error: link.error });
  if (link) {
    try {
      const info = await fetchRepoInfo(link.repo, ["pipeline_tag", "downloads", "likes", "lastModified", "gated"]);
      const quant = link.quant || (link.file && /\.gguf$/i.test(link.file) && !/mmproj/i.test(link.file) ? quantOf(link.file) : null);
      return res.json({
        repos: [{
          id: info.id,
          downloads: info.downloads || 0,
          likes: info.likes || 0,
          pipelineTag: info.pipeline_tag || null,
          updatedAt: info.lastModified || null,
          gated: info.gated || false,
        }],
        link: { repo: info.id, quant, file: link.file, revision: link.revision },
      });
    } catch (err) {
      return res.status(err.status || 502).json({ error: err.message });
    }
  }
  const q = raw.slice(0, 100);
  // Over-fetch, since non-chat repos are filtered out below.
  const params = new URLSearchParams({ filter: "gguf", sort: "downloads", direction: "-1", limit: "100" });
  if (q) params.set("search", q);
  try {
    const response = await hfFetch(`${HF}/models?${params}`);
    if (!response.ok) return res.status(502).json({ error: `Hugging Face error (${response.status})` });
    const data = await response.json();
    res.json({
      repos: data.filter((r) => CHAT_PIPELINE_TAGS.has(r.pipeline_tag)).slice(0, 30).map((r) => ({
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

/** Quant tag of a GGUF path ("Q4_K_M"): from the filename, else a directory name. null if none. */
export function quantOf(path) {
  const name = path.split("/").pop();
  const m = QUANT_RE.exec(name.replace(SHARD_RE, ".gguf")) || QUANT_RE.exec(path);
  return m ? m[1].toUpperCase() : null;
}

/** Group a repo's GGUF files by quant, summing split shards. */
export function groupQuants(files) {
  const quants = new Map();
  let hasMmproj = false;
  const mmproj = []; // { name, size }
  for (const f of files) {
    if (f.type !== "file" || !/\.gguf$/i.test(f.path)) continue;
    const name = f.path.split("/").pop();
    if (/mmproj/i.test(name)) {
      hasMmproj = true;
      mmproj.push({ name, size: f.lfs?.size ?? f.size ?? 0 });
      continue;
    }
    const tag = quantOf(f.path);
    if (!tag) continue;
    const size = f.lfs?.size ?? f.size ?? 0;
    const q = quants.get(tag) || { quant: tag, size: 0, files: [] };
    q.size += size;
    q.files.push(f.path);
    quants.set(tag, q);
  }
  return {
    hasMmproj,
    // Best guess at the projector llama.cpp picks (F16, else BF16, else the smallest).
    mmprojSize: pickMmproj(mmproj)?.size || null,
    quants: [...quants.values()].sort((a, b) => a.size - b.size),
  };
}

function pickMmproj(files) {
  if (!files.length) return null;
  return (
    files.find((f) => /[-_.]F16\.gguf$/i.test(f.name)) ||
    files.find((f) => /[-_.]BF16\.gguf$/i.test(f.name)) ||
    [...files].sort((a, b) => a.size - b.size)[0]
  );
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
