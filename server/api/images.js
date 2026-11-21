/**
 * Image generation via stable-diffusion.cpp's sd-server (see server/sd.js).
 * Mounted at /api/images behind requireAuth. Everything except history goes
 * to the machine images are routed to (req.machine, see server/backends.js).
 *
 *  - GET  /status        sd-server reachability, model state, whether a job runs
 *  - GET  /options       configured models (+ per-model defaults), samplers, schedulers, defaults
 *  - /models/...         search, install, delete and set up models (see imageModels.js)
 *  - POST /txt2img       one job, streamed as SSE: stage / progress / complete / error
 *  - /generations...     history, stored in SQLite (image_generations, generated_images)
 */

import { Router } from "express";
import { nanoid } from "nanoid";
import crypto from "crypto";
import { getDb } from "../db/index.js";
import {
  getSdConfig,
  sdFetch,
  sdStatus,
  acquireImageLock,
  releaseImageLock,
  isImageJobActive,
  unloadChatModels,
  loadSdModel,
  unloadSdModel,
  txt2img,
  resolveModelSetup,
} from "../sd.js";
import imageModelsRouter from "./imageModels.js";
import { routeTo, machineFromQuery, publicMachine, getMachine } from "../backends.js";

const router = Router();
const toImageMachine = routeTo("image");

// Generation, status and history can't be aimed at a machine: refuse ?machine=
// there instead of ignoring it.
router.use((req, res, next) =>
  req.query.machine && !/^\/(models|options)(\/|$)/.test(req.path) ? machineFromQuery([])(req, res, next) : next()
);

// Per-machine reads, installs and deletes (Models page columns, System page).
// Setup / default stay on the machine images go to.
const modelTargets = machineFromQuery([
  ["GET", "/"],
  ["GET", "/install/current"],
  ["POST", "/install"],
  ["POST", /^\/install\/[0-9a-f]{1,32}\/cancel$/],
  ["DELETE", /^\/files\/[^/]+\/[^/]+$/],
]);
router.use("/models", modelTargets, toImageMachine, imageModelsRouter);

// ── status / options ───────────────────────────────────────────────────

router.get("/status", toImageMachine, async (req, res) => {
  const { url } = getSdConfig(req.machine);
  const common = { url, machine: publicMachine(req.machine), busy: isImageJobActive(req.machine) };
  try {
    const status = await sdStatus(req.machine);
    res.json({ ok: true, ...common, state: status.state });
  } catch (err) {
    res.json({ ok: false, ...common, error: err.message });
  }
});

const names = (list) => (list || []).map((x) => (typeof x === "string" ? x : x.name)).filter(Boolean);

// ?machine=<id>: another machine's options, read-only (greyed picker entries).
router.get("/options", machineFromQuery([["GET", "/options"]]), toImageMachine, async (req, res) => {
  const cfg = getSdConfig(req.machine);
  try {
    const [files, samplers, schedulers] = await Promise.all([
      sdFetch(req.machine, "/sdcpp/v1/model-files"),
      sdFetch(req.machine, "/sdapi/v1/samplers").catch(() => []),
      sdFetch(req.machine, "/sdapi/v1/schedulers").catch(() => []),
    ]);
    // Models with a saved setup (recipe + any components) whose files are all present.
    const present = new Set((files.files || []).map((f) => f.id));
    const checkpoints = [];
    const modelDefaults = {};
    for (const f of files.files || []) {
      if (f.category !== "checkpoints" && f.category !== "diffusion_models") continue;
      const setup = resolveModelSetup(req.machine, f.id);
      if (!setup || !Object.values(setup.models).every((id) => present.has(id))) continue;
      checkpoints.push(f.id);
      modelDefaults[f.id] = f.id === cfg.model
        ? { steps: cfg.steps, width: cfg.width, height: cfg.height, cfgScale: cfg.cfg, sampler: cfg.sampler }
        : cfg.models?.[f.id]?.defaults || {};
    }
    res.json({
      machine: publicMachine(req.machine),
      checkpoints,
      modelDefaults,
      samplers: names(samplers).filter((s) => s !== "default"),
      schedulers: names(schedulers),
      defaults: {
        // Only a model this machine can load; never another machine's default.
        checkpoint: checkpoints.includes(cfg.model) ? cfg.model : checkpoints[0] || null,
        steps: cfg.steps,
        width: cfg.width,
        height: cfg.height,
        cfgScale: cfg.cfg,
        sampler: cfg.sampler,
      },
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

// ── txt2img ────────────────────────────────────────────────────────────

const int = (v, d) => (v === undefined || v === null || v === "" ? d : Number(v));

/** Validate and fill the request with the machine's sd config defaults. Returns [params, error]. */
function parseParams(body = {}, cfg) {
  const p = {
    prompt: typeof body.prompt === "string" ? body.prompt.trim() : "",
    negativePrompt: typeof body.negativePrompt === "string" ? body.negativePrompt : "",
    checkpoint: body.checkpoint || cfg.model,
    width: int(body.width, cfg.width),
    height: int(body.height, cfg.height),
    steps: int(body.steps, cfg.steps),
    cfgScale: int(body.cfgScale, cfg.cfg),
    sampler: body.sampler || cfg.sampler,
    scheduler: body.scheduler || null,
    seed: int(body.seed, -1),
    batchCount: int(body.batchCount, 1),
  };
  if (!p.prompt) return [null, "prompt is required"];
  if (typeof p.checkpoint !== "string" || !/^[\w@./+-]+$/.test(p.checkpoint) || p.checkpoint.includes("..")) {
    return [null, "invalid checkpoint"];
  }
  for (const [k, lo, hi] of [["width", 64, 2048], ["height", 64, 2048]]) {
    if (!Number.isInteger(p[k]) || p[k] < lo || p[k] > hi || p[k] % 8) {
      return [null, `${k} must be a multiple of 8 between ${lo} and ${hi}`];
    }
  }
  if (!Number.isInteger(p.steps) || p.steps < 1 || p.steps > 150) return [null, "steps must be 1-150"];
  if (!Number.isFinite(p.cfgScale) || p.cfgScale < 1 || p.cfgScale > 30) return [null, "cfgScale must be 1-30"];
  if (!Number.isInteger(p.batchCount) || p.batchCount < 1 || p.batchCount > 4) return [null, "batchCount must be 1-4"];
  if (!Number.isInteger(p.seed) || p.seed < -1 || p.seed > 2 ** 32 - 1) return [null, "seed must be -1 or a 32-bit integer"];
  if (typeof p.sampler !== "string" || !/^[\w+.-]+$/.test(p.sampler)) return [null, "invalid sampler"];
  if (p.scheduler !== null && (typeof p.scheduler !== "string" || !/^[\w+.-]+$/.test(p.scheduler))) {
    return [null, "invalid scheduler"];
  }
  // Pick the seed here so history records the one actually used.
  if (p.seed === -1) p.seed = crypto.randomInt(0, 2 ** 31);
  return [p, null];
}

export function saveGeneration(machine, p, setup, result, timings) {
  const db = getDb();
  const generationId = nanoid();
  const now = Date.now();
  const imageIds = [];
  db.transaction(() => {
    db.prepare(`
      INSERT INTO image_generations (id, prompt, negative_prompt, model, width, height, steps, cfg_scale, sampler, scheduler, seed, batch_count, workflow_json,
        machine_id, machine_name, recipe, components_json, total_ms, generate_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generationId, p.prompt, p.negativePrompt, p.checkpoint, p.width, p.height, p.steps,
      p.cfgScale, p.sampler, p.scheduler, p.seed, p.batchCount,
      JSON.stringify({ backend: "sd-server", machine: machine.id, api: result.api, generation_info: result.generationInfo }),
      machine.id, machine.name, setup.recipe || null, JSON.stringify(setup.models || {}),
      timings.totalMs ?? null, timings.generateMs ?? null,
      now,
    );
    const insert = db.prepare(`
      INSERT INTO generated_images (id, generation_id, filename, image_data, width, height, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    result.images.forEach((buf, i) => {
      const imageId = nanoid();
      const dims = pngSize(buf);
      insert.run(imageId, generationId, `sd_${generationId}_${i}.png`, buf, dims?.width ?? p.width, dims?.height ?? p.height, i, now);
      imageIds.push(imageId);
    });
  })();
  return { generationId, imageIds };
}

router.post("/txt2img", toImageMachine, async (req, res) => {
  // Fixed for the whole job: switching machines mid-job doesn't move it.
  const machine = req.machine;
  const cfg = getSdConfig(machine);
  if (!req.body?.checkpoint && !cfg.model) {
    return res.status(400).json({ error: `No image model on ${machine.name}; install one under Models → Image`, code: "no_model" });
  }
  const [p, invalid] = parseParams(req.body, cfg);
  if (invalid) return res.status(400).json({ error: invalid });
  const setup = resolveModelSetup(machine, p.checkpoint);
  if (!setup) {
    return res.status(400).json({ error: `${p.checkpoint} has no recipe set on ${machine.name}; configure it under Models → Image` });
  }
  // Every file of the setup must be on this machine before anything is
  // unloaded or loaded: never ask sd-server to load a file it doesn't have.
  let present;
  try {
    present = new Set(((await sdFetch(machine, "/sdcpp/v1/model-files")).files || []).map((f) => f.id));
  } catch (err) {
    return res.status(502).json({ error: err.message });
  }
  const missing = Object.values(setup.models).filter((id) => !present.has(id));
  if (missing.length) {
    return res.status(400).json({
      error: `${missing.join(", ")} ${missing.length === 1 ? "isn't" : "aren't"} on ${machine.name}; install ${missing.length === 1 ? "it" : "them"} under Models → Image`,
      code: "no_model",
    });
  }

  const busy = acquireImageLock(machine);
  if (busy) return res.status(409).json({ error: busy, code: "gpu_busy" });

  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
  const send = (type, data = {}) => {
    if (!res.writableEnded) res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };
  const t0 = Date.now();
  const checkAborted = () => {
    if (controller.signal.aborted) throw Object.assign(new Error("Generation cancelled"), { code: "cancelled" });
  };

  let sdLoaded = false;
  try {
    // Only this machine's chat models; other machines are never touched.
    send("stage", { stage: "freeing_gpu", message: `Unloading chat models on ${machine.name}…` });
    await unloadChatModels(machine, {
      onWait: (models) => send("stage", {
        stage: "freeing_gpu",
        message: `Waiting for ${models.map((m) => `${m.id} (${m.status})`).join(", ")} to unload…`,
      }),
    });
    checkAborted();

    send("stage", { stage: "loading_model", message: `Loading ${p.checkpoint}…` });
    sdLoaded = true; // from here on, always try to unload
    const keepalive = setInterval(() => send("stage", { stage: "loading_model", message: `Loading ${p.checkpoint}…` }), 5000);
    try {
      await loadSdModel(machine, { ...setup, signal: controller.signal });
    } finally {
      clearInterval(keepalive);
    }
    checkAborted();

    const tGen = Date.now();
    const result = await txt2img(machine, p, {
      signal: controller.signal,
      onProgress: (pr) => send("progress", pr),
    });
    checkAborted();

    const timings = { totalMs: Date.now() - t0, generateMs: result.elapsedMs ?? Date.now() - tGen };
    const { generationId, imageIds } = saveGeneration(machine, p, setup, result, timings);
    send("complete", {
      machine: machine.id,
      generationId,
      imageIds,
      seed: p.seed,
      imageCount: imageIds.length,
      api: result.api,
      timings,
    });
  } catch (err) {
    if (err.code !== "cancelled") console.error("Image generation failed:", err.message);
    send("error", { error: err.message });
  } finally {
    if (sdLoaded) {
      try {
        await unloadSdModel(machine);
      } catch (err) {
        console.error("Failed to unload SD model:", err.message);
      }
    }
    releaseImageLock(machine);
    if (!res.writableEnded) res.end();
  }
});

// ── image history (DB) ─────────────────────────────────────────────────

router.get("/generations", (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;

  const generations = db.prepare(`
    SELECT g.id, g.prompt, g.negative_prompt, g.model, g.width, g.height, g.steps, g.cfg_scale,
      g.sampler, g.scheduler, g.seed, g.batch_count, g.created_at, g.machine_id, g.machine_name, g.recipe,
      (SELECT COUNT(*) FROM generated_images gi WHERE gi.generation_id = g.id) AS image_count,
      (SELECT id FROM generated_images gi WHERE gi.generation_id = g.id ORDER BY position LIMIT 1) AS first_image_id,
      (SELECT json_group_array(id) FROM (SELECT id FROM generated_images gi WHERE gi.generation_id = g.id ORDER BY position)) AS image_ids
    FROM image_generations g
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  for (const g of generations) {
    g.image_ids = JSON.parse(g.image_ids || "[]");
    g.machine_name ||= (g.machine_id && getMachine(g.machine_id)?.name) || null;
  }
  const total = db.prepare("SELECT COUNT(*) AS count FROM image_generations").get().count;
  res.json({ generations, total, page, limit });
});

router.get("/generations/:id", (req, res) => {
  const db = getDb();
  const gen = db.prepare("SELECT * FROM image_generations WHERE id = ?").get(req.params.id);
  if (!gen) return res.status(404).json({ error: "Generation not found" });

  const images = db.prepare(
    "SELECT id, filename, width, height, position, created_at FROM generated_images WHERE generation_id = ? ORDER BY position"
  ).all(req.params.id);

  res.json({ ...gen, images });
});

router.delete("/generations/:id", (req, res) => {
  const db = getDb();
  db.prepare("DELETE FROM generated_images WHERE generation_id = ?").run(req.params.id);
  db.prepare("DELETE FROM image_generations WHERE id = ?").run(req.params.id);
  res.json({ success: true });
});

// Everything known about one stored image, for the preview (and other clients,
// e.g. iOS). Fields that were never recorded are null, never inferred.
router.get("/generations/:genId/images/:imageId/meta", (req, res) => {
  const row = getDb().prepare(`
    SELECT g.*, gi.id AS image_id, gi.generation_id, gi.filename, gi.width AS stored_width, gi.height AS stored_height, gi.position,
      gi.created_at AS image_created_at, length(gi.image_data) AS file_size, substr(gi.image_data, 1, 32) AS head,
      (SELECT COUNT(*) FROM generated_images x WHERE x.generation_id = g.id) AS image_count
    FROM generated_images gi JOIN image_generations g ON g.id = gi.generation_id
    WHERE gi.id = ? AND gi.generation_id = ?
  `).get(req.params.imageId, req.params.genId);
  if (!row || row.file_size == null) return res.status(404).json({ error: "Image not found" });
  res.json(imageMeta(row));
});

router.get("/generations/:genId/images/:imageId", (req, res) => {
  const db = getDb();
  const img = db.prepare(
    "SELECT image_data, filename FROM generated_images WHERE id = ? AND generation_id = ?"
  ).get(req.params.imageId, req.params.genId);

  if (!img || !img.image_data) {
    return res.status(404).json({ error: "Image not found" });
  }

  const ext = img.filename.split(".").pop()?.toLowerCase();
  res.setHeader("Content-Type", ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png");
  res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
  res.send(img.image_data);
});

// ── metadata helpers ───────────────────────────────────────────────────

/** Pixel size from a PNG header, or null if the bytes aren't a PNG. */
export function pngSize(buf) {
  if (!buf || buf.length < 24) return null;
  if (buf.readUInt32BE(0) !== 0x89504e47 || buf.toString("ascii", 12, 16) !== "IHDR") return null;
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

const jsonOr = (text, fallback) => {
  try {
    return text ? JSON.parse(text) : fallback;
  } catch {
    return fallback;
  }
};

/**
 * The stored-image record, "llmui.image/v1". Only recorded values: a field
 * the generation didn't record is null.
 */
export function imageMeta(row) {
  const ext = row.filename?.split(".").pop()?.toLowerCase();
  const px = pngSize(row.head);
  const machineName = row.machine_name || (row.machine_id && getMachine(row.machine_id)?.name) || null;
  return {
    schema: "llmui.image/v1",
    id: row.image_id,
    generationId: row.generation_id,
    position: row.position,
    imageCount: row.image_count,
    createdAt: row.image_created_at ?? row.created_at,
    mimeType: ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png",
    fileSize: row.file_size,
    width: px?.width ?? row.stored_width ?? null,
    height: px?.height ?? row.stored_height ?? null,
    prompt: row.prompt ?? null,
    negativePrompt: row.negative_prompt || null,
    model: row.model || null,
    recipe: row.recipe || null,
    components: row.components_json ? jsonOr(row.components_json, null) : null,
    machine: row.machine_id ? { id: row.machine_id, name: machineName } : null,
    settings: {
      seed: row.seed ?? null,
      steps: row.steps ?? null,
      cfgScale: row.cfg_scale ?? null,
      sampler: row.sampler || null,
      scheduler: row.scheduler || null,
      width: row.width ?? null,
      height: row.height ?? null,
      batchCount: row.batch_count ?? null,
    },
    timings: row.total_ms == null && row.generate_ms == null ? null : { totalMs: row.total_ms ?? null, generateMs: row.generate_ms ?? null },
  };
}

export default router;
