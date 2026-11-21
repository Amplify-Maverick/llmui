/**
 * stable-diffusion.cpp sd-server clients (one per machine, server/backends.js),
 * and the per-machine GPU lock shared with chat.
 *
 * The browser never talks to sd-server directly; everything goes through the
 * authenticated /api/images router (server/api/images.js).
 *
 * Config: one file per machine (the default machine keeps
 * ~/.llmui/sd_config.json; others use sd_config.<id>.json), created with
 * defaults on first start. Model setups name files on that machine, so each
 * machine has its own.
 *
 * A machine's GPU (8 GB) can't hold a chat model and an SD model at once, so an
 * image job owns that machine's GPU: its chat models are unloaded first, chat
 * requests to that machine get 409 while the job runs, and the SD model is
 * unloaded again when the job ends. Other machines are not touched.
 */

import fs from "fs/promises";
import path from "path";
import { llamaFetch } from "./llama.js";
import { listMachines, resolveMachine, defaultMachine } from "./backends.js";

export const DEFAULT_SD_CONFIG = {
  url: "http://100.118.190.15:8082",
  // sd-fetch download helper on the sd-server host (deploy/sd-fetch). Its
  // bearer token is read from the machine's token file, never from here.
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

/**
 * Defaults for one machine: its URLs and VRAM. Only the default machine starts
 * with a default model (the file it shipped with); any other machine has none
 * until one is installed and made its default there.
 */
export const machineDefaults = (machine) => ({
  ...DEFAULT_SD_CONFIG,
  ...(machine.isDefault ? {} : { recipe: null, model: null, components: {} }),
  url: machine.sdUrl,
  fetchUrl: machine.fetchUrl,
  gpuMemoryGiB: machine.gpuMemoryGiB,
});

/**
 * Earlier versions wrote the default machine's model into every machine's
 * config. On a non-default machine, a default identical to that one with no
 * setup of its own is that copy: drop it. Returns true if it changed `config`.
 */
export function dropInheritedDefault(machine, config) {
  if (machine.isDefault || !config.model) return false;
  const inherited =
    config.model === DEFAULT_SD_CONFIG.model &&
    config.recipe === DEFAULT_SD_CONFIG.recipe &&
    !Object.keys(config.components || {}).length &&
    !config.models?.[config.model];
  if (!inherited) return false;
  config.model = null;
  config.recipe = null;
  config.components = {};
  return true;
}

const configs = new Map(); // machine id → config

async function loadOne(machine) {
  const file = machine.sdConfigPath;
  const defaults = machineDefaults(machine);
  let config = { ...defaults };
  try {
    config = { ...defaults, ...JSON.parse(await fs.readFile(file, "utf-8")) };
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`Error reading ${file} (using defaults):`, err.message);
    } else {
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, JSON.stringify(defaults, null, 2) + "\n");
      console.log(`Created ${file}`);
    }
  }
  config.url = String(config.url).replace(/\/+$/, "");
  configs.set(machine.id, config);
  if (dropInheritedDefault(machine, config)) {
    console.log(`${file}: removed the default image model copied from ${defaultMachine().name}`);
    await saveSdConfig(machine, {});
  }
  return config;
}

/** Load every machine's sd config, writing defaults for any that don't exist. */
export async function loadSdConfig() {
  for (const m of listMachines()) await loadOne(m);
  return configs.get(defaultMachine().id);
}

export const getSdConfig = (machine) => configs.get(machine.id) || machineDefaults(machine);

const writeChains = new Map(); // machine id → Promise

/** Merge `patch` into a machine's sd config file (atomic write; writes are serialized per file). */
export function saveSdConfig(machine, patch) {
  const config = { ...getSdConfig(machine), ...patch };
  configs.set(machine.id, config);
  const snapshot = JSON.stringify(config, null, 2) + "\n";
  const file = machine.sdConfigPath;
  const chain = (writeChains.get(machine.id) || Promise.resolve()).then(async () => {
    const tmp = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tmp, snapshot, { mode: 0o600 });
    await fs.rename(tmp, file);
  });
  writeChains.set(machine.id, chain.catch(() => {}));
  return chain.then(() => config);
}

/**
 * How to load a model file on a machine: { recipe, models: { slot: fileId, ... } },
 * or null if it has no saved setup. The default model's setup lives in the
 * top-level recipe/components keys.
 */
export function resolveModelSetup(machine, fileId) {
  const config = getSdConfig(machine);
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
// GPU lock (per machine)
// ------------------------------------------------------------

const imageJobs = new Map(); // machine id → { started } while an image job owns that GPU
const chatsInFlight = new Map(); // machine id → count

export const IMAGE_BUSY_MESSAGE = "image generation in progress";
export const isImageJobActive = (machine) => imageJobs.has(machine.id);

export function imageBusyBody(shape) {
  return shape === "openai"
    ? { error: { message: IMAGE_BUSY_MESSAGE, code: "image_generation_in_progress", type: "conflict" } }
    : { error: IMAGE_BUSY_MESSAGE, code: "image_generation_in_progress" };
}

/** Count a chat as in flight on `machine`. Returns a release function (safe to call twice). */
export function beginChat(machine) {
  chatsInFlight.set(machine.id, (chatsInFlight.get(machine.id) || 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    chatsInFlight.set(machine.id, chatsInFlight.get(machine.id) - 1);
  };
}

/** Count a chat request as in flight on `machine` until `res` closes. */
export function trackChat(machine, res) {
  res.on("close", beginChat(machine));
}

/**
 * Express middleware for routes that use (and may autoload) a chat model.
 * Sets req.machine to the machine chat goes to. Rejects with 409 while an
 * image job runs on that machine; otherwise counts the request as in flight
 * until its response closes, so an image job won't start under it.
 * `shape` picks the error body the route's clients parse.
 */
export function chatGate(shape = "string") {
  return (req, res, next) => {
    if (!req.machine) {
      const { machine, fallback } = resolveMachine("chat");
      req.machine = machine;
      req.machineFallback = fallback;
    }
    if (isImageJobActive(req.machine)) return res.status(409).json(imageBusyBody(shape));
    trackChat(req.machine, res);
    next();
  };
}

/** Take a machine's GPU for an image job. Returns null, or the reason it can't. */
export function acquireImageLock(machine) {
  if (imageJobs.has(machine.id)) return IMAGE_BUSY_MESSAGE;
  if ((chatsInFlight.get(machine.id) || 0) > 0) return "a chat response is still streaming; try again when it finishes";
  imageJobs.set(machine.id, { started: Date.now() });
  return null;
}

export function releaseImageLock(machine) {
  imageJobs.delete(machine.id);
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
export async function sdFetch(machine, p, { method = "GET", body, timeout = 30000, signal } = {}) {
  const { url } = getSdConfig(machine);
  let response;
  try {
    response = await fetch(`${url}${p}`, {
      method,
      headers: body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout),
    });
  } catch (err) {
    throw new SdError(`${machine.name} sd-server unreachable (${url}): ${err.cause?.code || err.message}`, { code: "unreachable" });
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
async function residentChatModels(machine) {
  const response = await llamaFetch(machine, "/models", { signal: AbortSignal.timeout(10000) });
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
 * `signal` stops waiting (throws an SdError with code "cancelled").
 */
export async function unloadChatModels(machine, { timeoutMs = 90000, onWait, signal } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (signal?.aborted) throw new SdError("Generation cancelled", { status: 499, code: "cancelled" });
    const resident = await residentChatModels(machine);
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
      const r = await llamaFetch(machine, "/models/unload", {
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
export async function refreshSdCatalog(machine) {
  try {
    await sdFetch(machine, "/sdcpp/v1/models/refresh", { method: "POST", body: {}, timeout: 30000 });
    return true;
  } catch (err) {
    console.warn(`${machine.name} sd-server catalog refresh failed:`, err.message);
    return false;
  }
}

export function sdStatus(machine, { timeout = 10000 } = {}) {
  return sdFetch(machine, "/sdcpp/v1/models/status", { timeout });
}

/**
 * Load a model setup ({ recipe, models: { slot: fileId } }, see
 * resolveModelSetup). Waits for completion, as sd-server does.
 */
export async function loadSdModel(machine, { recipe, models, signal }) {
  const status = await sdFetch(machine, "/sdcpp/v1/models/load", {
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
export async function unloadSdModel(machine, { timeoutMs = 120000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await sdFetch(machine, "/sdcpp/v1/models/unload", { method: "POST", body: {}, timeout: 60000 });
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
export async function txt2img(machine, p, { onProgress, signal, onSubmitted } = {}) {
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
    submitted = await sdFetch(machine, "/sdcpp/v1/img_gen", { method: "POST", body, timeout: 30000 });
  } catch (err) {
    if (err.status === 404 || err.status === 405 || err.status === 501) {
      console.warn(`Native img_gen unavailable (${err.message}); falling back to /sdapi/v1/txt2img`);
      return txt2imgSdapi(machine, p, { onProgress, signal });
    }
    throw err;
  }

  onSubmitted?.(submitted.id);
  const jobPath = submitted.poll_url || `/sdcpp/v1/jobs/${encodeURIComponent(submitted.id)}`;
  let cancelSent = false;
  for (;;) {
    if (signal?.aborted && !cancelSent) {
      cancelSent = true;
      await sdFetch(machine, `/sdcpp/v1/jobs/${encodeURIComponent(submitted.id)}/cancel`, { method: "POST", body: {} })
        .catch((err) => console.warn("sd-server cancel failed:", err.message));
    }
    const job = await sdFetch(machine, jobPath, { timeout: 15000 });
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

async function txt2imgSdapi(machine, p, { onProgress, signal } = {}) {
  const idTask = `llmui-${Date.now()}`;
  let done = false;
  const poll = (async () => {
    while (!done) {
      await sleep(700);
      if (done) break;
      try {
        const pr = await sdFetch(machine, `/sdapi/v1/progress?id_task=${idTask}&skip_current_image=true`, { timeout: 5000 });
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
    const res = await sdFetch(machine, "/sdapi/v1/txt2img", {
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
