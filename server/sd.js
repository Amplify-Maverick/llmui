/**
 * stable-diffusion.cpp sd-server client, and the GPU lock shared with chat.
 *
 * The browser never talks to sd-server directly; everything goes through the
 * authenticated /api/images router (server/api/images.js).
 *
 * Config: ~/.llmui/sd_config.json, created with defaults on first start.
 *
 * The GPU (8 GB) can't hold a chat model and an SD model at once, so an image
 * job owns it: chat models are unloaded first, chat requests get 409 while the
 * job runs, and the SD model is unloaded again when the job ends.
 */

import fs from "fs/promises";
import os from "os";
import path from "path";
import { llamaFetch } from "./llama.js";

const CONFIG_FILE = path.join(os.homedir(), ".llmui", "sd_config.json");

export const DEFAULT_SD_CONFIG = {
  url: "http://100.118.190.15:8082",
  // sd-fetch download helper on the sd-server host (deploy/sd-fetch). Its
  // bearer token is read from ~/.llmui/sd-fetch.token, never from here.
  fetchUrl: "http://100.118.190.15:8083",
  // VRAM of the GPU sd-server runs on, for the "too big" marks.
  gpuMemoryGiB: 8,
  // Default model: sd-server recipe id and file id (from /sdcpp/v1/recipes
  // and /sdcpp/v1/model-files), plus any other slots the recipe needs.
  recipe: "sd1-checkpoint",
  model: "checkpoints/sd15.safetensors",
  components: {},
  steps: 20,
  width: 512,
  height: 512,
  cfg: 7,
  sampler: "euler_a",
  // Per-model setups, keyed by file id: { recipe, slot, components, defaults, source }.
  models: {},
};

let config = { ...DEFAULT_SD_CONFIG };

/** Load ~/.llmui/sd_config.json, writing the defaults if it doesn't exist. */
export async function loadSdConfig() {
  try {
    config = { ...DEFAULT_SD_CONFIG, ...JSON.parse(await fs.readFile(CONFIG_FILE, "utf-8")) };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Error reading ${CONFIG_FILE} (using defaults):`, err.message);
      return config;
    }
    await fs.mkdir(path.dirname(CONFIG_FILE), { recursive: true });
    await fs.writeFile(CONFIG_FILE, JSON.stringify(DEFAULT_SD_CONFIG, null, 2) + "\n");
    console.log(`Created ${CONFIG_FILE}`);
  }
  config.url = String(config.url).replace(/\/+$/, "");
  return config;
}

export const getSdConfig = () => config;

let writeChain = Promise.resolve();

/** Merge `patch` into sd_config.json (atomic write; writes are serialized). */
export function saveSdConfig(patch) {
  config = { ...config, ...patch };
  const snapshot = JSON.stringify(config, null, 2) + "\n";
  writeChain = writeChain.then(async () => {
    const tmp = `${CONFIG_FILE}.${process.pid}.tmp`;
    await fs.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.rename(tmp, CONFIG_FILE);
  });
  return writeChain.then(() => config);
}

/**
 * How to load a model file: { recipe, models: { slot: fileId, ... } }, or
 * null if it has no saved setup. The default model's setup lives in the
 * top-level recipe/components keys.
 */
export function resolveModelSetup(fileId) {
  const entry = config.models?.[fileId];
  if (entry?.recipe) {
    return { recipe: entry.recipe, models: { ...(entry.components || {}), [entry.slot || "model"]: fileId } };
  }
  if (fileId === config.model) {
    return { recipe: config.recipe, models: { ...(config.components || {}), [config.slot || "model"]: fileId } };
  }
  return null;
}

// ------------------------------------------------------------
// GPU lock
// ------------------------------------------------------------

let imageJob = null; // { started } while an image job owns the GPU
let chatsInFlight = 0;

export const IMAGE_BUSY_MESSAGE = "image generation in progress";
export const isImageJobActive = () => imageJob !== null;

/**
 * Express middleware for routes that use (and may autoload) a chat model.
 * Rejects with 409 during an image job; otherwise counts the request as in
 * flight until its response closes, so an image job won't start under it.
 * `shape` picks the error body the route's clients parse.
 */
export function chatGate(shape = "string") {
  return (req, res, next) => {
    if (imageJob) {
      const body = shape === "openai"
        ? { error: { message: IMAGE_BUSY_MESSAGE, code: "image_generation_in_progress", type: "conflict" } }
        : { error: IMAGE_BUSY_MESSAGE, code: "image_generation_in_progress" };
      return res.status(409).json(body);
    }
    chatsInFlight++;
    res.on("close", () => chatsInFlight--);
    next();
  };
}

/** Take the GPU for an image job. Returns null, or the reason it can't. */
export function acquireImageLock() {
  if (imageJob) return IMAGE_BUSY_MESSAGE;
  if (chatsInFlight > 0) return "a chat response is still streaming; try again when it finishes";
  imageJob = { started: Date.now() };
  return null;
}

export function releaseImageLock() {
  imageJob = null;
}

// ------------------------------------------------------------
// HTTP helpers
// ------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class SdError extends Error {
  constructor(message, { status = 502, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** Readable error text from a failed sd-server / router response. */
async function errorText(response) {
  const text = await response.text().catch(() => "");
  try {
    const body = JSON.parse(text);
    const err = body.error;
    const msg = typeof err === "string" ? err : err?.message;
    return { message: msg || text || `HTTP ${response.status}`, code: body.code || err?.code || null };
  } catch {
    return { message: text || `HTTP ${response.status}`, code: null };
  }
}

/** fetch() against sd-server, returning parsed JSON or throwing SdError with its error text. */
export async function sdFetch(p, { method = "GET", body, timeout = 30000, signal } = {}) {
  let response;
  try {
    response = await fetch(`${config.url}${p}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new SdError(`sd-server unreachable (${config.url}): ${err.message}`);
  }
  if (!response.ok) {
    const { message, code } = await errorText(response);
    throw new SdError(`sd-server ${method} ${p} → ${response.status}: ${message}`, { status: response.status, code });
  }
  return response.json().catch(() => ({}));
}

// ------------------------------------------------------------
// Chat models (llama.cpp router)
// ------------------------------------------------------------

/** Router models whose status isn't "unloaded": loaded, loading, sleeping, ... */
async function residentChatModels() {
  const response = await llamaFetch("/models", { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    const { message } = await errorText(response);
    throw new SdError(`Model router GET /models → ${response.status}: ${message}`);
  }
  const data = await response.json();
  return (data.data || data.models || [])
    .map((m) => ({ id: m.id, status: m.status?.value || "unknown" }))
    .filter((m) => m.status !== "unloaded");
}

/**
 * Unload every chat model on the router and wait until GET /models shows none
 * resident. onWait(models) is called on each poll that still sees some.
 */
export async function unloadChatModels({ timeoutMs = 90000, onWait } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const resident = await residentChatModels();
    if (resident.length === 0) return;
    if (Date.now() > deadline) {
      throw new SdError(
        `Chat models still on the GPU after ${timeoutMs / 1000}s: ` +
          resident.map((m) => `${m.id} (${m.status})`).join(", ")
      );
    }
    onWait?.(resident);
    for (const m of resident) {
      // Re-sent on every poll until it's gone: a model that was still
      // loading may ignore the first request.
      if (m.status === "unloading") continue;
      const r = await llamaFetch("/models/unload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: m.id }),
        signal: AbortSignal.timeout(30000),
      }).catch((err) => ({ ok: false, statusText: err.message }));
      if (!r.ok && r.status !== 400 && r.status !== 404) {
        console.warn(`Router unload ${m.id} failed: ${r.status || ""} ${r.statusText || ""}`);
      }
    }
    await sleep(1000);
  }
}

// ------------------------------------------------------------
// SD model load / unload
// ------------------------------------------------------------

/** Rescan sd-server's model dir (new or deleted files). Best-effort. */
export async function refreshSdCatalog() {
  try {
    await sdFetch("/sdcpp/v1/models/refresh", { method: "POST", body: {}, timeout: 30000 });
    return true;
  } catch (err) {
    console.warn("sd-server catalog refresh failed:", err.message);
    return false;
  }
}

export function sdStatus() {
  return sdFetch("/sdcpp/v1/models/status", { timeout: 10000 });
}

/**
 * Load a model setup ({ recipe, models: { slot: fileId } }, see
 * resolveModelSetup). Waits for completion, as sd-server does.
 */
export async function loadSdModel({ recipe, models, signal }) {
  const status = await sdFetch("/sdcpp/v1/models/load", {
    method: "POST",
    body: { recipe, models },
    timeout: 10 * 60 * 1000,
    signal,
  });
  if (status.state && status.state !== "ready") {
    throw new SdError(`sd-server model load ended in state "${status.state}": ${status.error || "no error text"}`);
  }
  return status;
}

/** Unload the SD model, retrying while sd-server says it's busy (jobs still finishing). */
export async function unloadSdModel({ timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await sdFetch("/sdcpp/v1/models/unload", { method: "POST", body: {}, timeout: 60000 });
    } catch (err) {
      const busy = err.status === 409 || err.code === "model_busy" || err.code === "model_loading";
      if (!busy || Date.now() > deadline) throw err;
      await sleep(1000);
    }
  }
}

// ------------------------------------------------------------
// Generation
// ------------------------------------------------------------

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

/**
 * txt2img on sd-server. Uses the native async API (/sdcpp/v1/img_gen + job
 * polling); falls back to /sdapi/v1/txt2img only if the native endpoint is
 * missing. Returns { images: [Buffer], api, generationInfo }.
 *
 * onProgress({ stage, step, totalSteps, value }) — value is overall 0..1 when known.
 * signal aborts the job (cancelling it on sd-server and waiting for it to stop).
 */
export async function txt2img(p, { onProgress, signal } = {}) {
  const body = {
    prompt: p.prompt,
    negative_prompt: p.negativePrompt || "",
    width: p.width,
    height: p.height,
    seed: p.seed,
    batch_count: p.batchCount,
    sample_params: {
      sample_method: p.sampler,
      sample_steps: p.steps,
      ...(p.scheduler ? { scheduler: p.scheduler } : {}),
      guidance: { txt_cfg: p.cfgScale },
    },
    output_format: "png",
  };

  let submitted;
  try {
    submitted = await sdFetch("/sdcpp/v1/img_gen", { method: "POST", body, timeout: 30000 });
  } catch (err) {
    if (err.status === 404 || err.status === 405 || err.status === 501) {
      console.warn(`Native img_gen unavailable (${err.message}); falling back to /sdapi/v1/txt2img`);
      return txt2imgSdapi(p, { onProgress, signal });
    }
    throw err;
  }

  const jobPath = submitted.poll_url || `/sdcpp/v1/jobs/${encodeURIComponent(submitted.id)}`;
  let cancelSent = false;
  for (;;) {
    if (signal?.aborted && !cancelSent) {
      cancelSent = true;
      await sdFetch(`/sdcpp/v1/jobs/${encodeURIComponent(submitted.id)}/cancel`, { method: "POST", body: {} })
        .catch((err) => console.warn("sd-server cancel failed:", err.message));
    }
    const job = await sdFetch(jobPath, { timeout: 15000 });
    if (TERMINAL.has(job.status)) {
      if (job.status === "completed") {
        const items = job.result?.images || [];
        if (items.length === 0) throw new SdError("sd-server job completed without images");
        return {
          api: "sdcpp",
          images: items.map((it) => Buffer.from(it.b64_json, "base64")),
          generationInfo: items.map((it) => it.generation_info ?? null),
          elapsedMs: job.started && job.completed ? job.completed - job.started : null,
        };
      }
      if (job.status === "cancelled") throw new SdError("Generation cancelled", { status: 499, code: "cancelled" });
      throw new SdError(`sd-server job failed: ${job.error?.message || "no error text"}`, { code: job.error?.code });
    }
    const pr = job.progress || {};
    const sampling = pr.stage === "sampling" && pr.total;
    const pass = Math.max(1, pr.pass || 1);
    onProgress?.({
      stage: job.status === "queued" ? "queued" : pr.stage || job.status,
      step: sampling ? pr.completed || 0 : 0,
      totalSteps: sampling ? pr.total : p.steps,
      pass,
      value: sampling ? Math.min(1, (pass - 1 + (pr.completed || 0) / pr.total) / p.batchCount) : null,
    });
    await sleep(500);
  }
}

async function txt2imgSdapi(p, { onProgress, signal } = {}) {
  const idTask = `llmui-${Date.now()}`;
  let done = false;
  const poll = (async () => {
    while (!done) {
      await sleep(700);
      if (done) break;
      try {
        const pr = await sdFetch(`/sdapi/v1/progress?id_task=${idTask}&skip_current_image=true`, { timeout: 5000 });
        const st = pr.state || {};
        onProgress?.({
          stage: st.sampling_steps ? "sampling" : "working",
          step: st.sampling_step || 0,
          totalSteps: st.sampling_steps || p.steps,
          value: typeof pr.progress === "number" ? pr.progress : null,
        });
      } catch {
        // progress is best-effort
      }
    }
  })();
  try {
    const res = await sdFetch("/sdapi/v1/txt2img", {
      method: "POST",
      body: {
        prompt: p.prompt,
        negative_prompt: p.negativePrompt || "",
        width: p.width,
        height: p.height,
        steps: p.steps,
        cfg_scale: p.cfgScale,
        seed: p.seed,
        batch_size: p.batchCount,
        sampler_name: p.sampler,
        ...(p.scheduler ? { scheduler: p.scheduler } : {}),
        id_task: idTask,
      },
      timeout: 30 * 60 * 1000,
      signal,
    });
    const images = (res.images || []).map((b64) => Buffer.from(b64, "base64"));
    if (images.length === 0) throw new SdError("sd-server txt2img returned no images");
    return { api: "sdapi", images, generationInfo: res.info?.generation_info || null, elapsedMs: null };
  } finally {
    done = true;
    await poll;
  }
}
