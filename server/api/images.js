/**
 * Image generation via stable-diffusion.cpp's sd-server (see server/sd.js).
 * Mounted at /api/images behind requireAuth.
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

const router = Router();

router.use("/models", imageModelsRouter);

// ── status / options ───────────────────────────────────────────────────

router.get("/status", async (req, res) => {
  const { url } = getSdConfig();
  try {
    const status = await sdStatus();
    res.json({ ok: true, url, state: status.state, busy: isImageJobActive() });
  } catch (err) {
    res.json({ ok: false, url, error: err.message, busy: isImageJobActive() });
  }
});

const names = (list) => (list || []).map((x) => (typeof x === "string" ? x : x.name)).filter(Boolean);

router.get("/options", async (req, res) => {
  const cfg = getSdConfig();
  try {
    const [files, samplers, schedulers] = await Promise.all([
      sdFetch("/sdcpp/v1/model-files"),
      sdFetch("/sdapi/v1/samplers").catch(() => []),
      sdFetch("/sdapi/v1/schedulers").catch(() => []),
    ]);
    // Models with a saved setup (recipe + any components) whose files are all present.
    const present = new Set((files.files || []).map((f) => f.id));
    const checkpoints = [];
    const modelDefaults = {};
    for (const f of files.files || []) {
      if (f.category !== "checkpoints" && f.category !== "diffusion_models") continue;
      const setup = resolveModelSetup(f.id);
      if (!setup || !Object.values(setup.models).every((id) => present.has(id))) continue;
      checkpoints.push(f.id);
      modelDefaults[f.id] = f.id === cfg.model
        ? { steps: cfg.steps, width: cfg.width, height: cfg.height, cfgScale: cfg.cfg, sampler: cfg.sampler }
        : cfg.models?.[f.id]?.defaults || {};
    }
    res.json({
      checkpoints,
      modelDefaults,
      samplers: names(samplers).filter((s) => s !== "default"),
      schedulers: names(schedulers),
      defaults: {
        checkpoint: cfg.model,
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

/** Validate and fill the request with sd_config.json defaults. Returns [params, error]. */
function parseParams(body = {}) {
  const cfg = getSdConfig();
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

function saveGeneration(p, result) {
  const db = getDb();
  const generationId = nanoid();
  const now = Date.now();
  const imageIds = [];
  db.transaction(() => {
    db.prepare(`
      INSERT INTO image_generations (id, prompt, negative_prompt, model, width, height, steps, cfg_scale, sampler, scheduler, seed, batch_count, workflow_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generationId, p.prompt, p.negativePrompt, p.checkpoint, p.width, p.height, p.steps,
      p.cfgScale, p.sampler, p.scheduler, p.seed, p.batchCount,
      JSON.stringify({ backend: "sd-server", api: result.api, generation_info: result.generationInfo }),
      now,
    );
    const insert = db.prepare(`
      INSERT INTO generated_images (id, generation_id, filename, image_data, width, height, position, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    result.images.forEach((buf, i) => {
      const imageId = nanoid();
      insert.run(imageId, generationId, `sd_${generationId}_${i}.png`, buf, p.width, p.height, i, now);
      imageIds.push(imageId);
    });
  })();
  return { generationId, imageIds };
}

router.post("/txt2img", async (req, res) => {
  const [p, invalid] = parseParams(req.body);
  if (invalid) return res.status(400).json({ error: invalid });
  const setup = resolveModelSetup(p.checkpoint);
  if (!setup) {
    return res.status(400).json({ error: `${p.checkpoint} has no recipe set; configure it under Models → Image` });
  }

  const busy = acquireImageLock();
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
    send("stage", { stage: "freeing_gpu", message: "Unloading chat models…" });
    await unloadChatModels({
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
      await loadSdModel({ ...setup, signal: controller.signal });
    } finally {
      clearInterval(keepalive);
    }
    checkAborted();

    const tGen = Date.now();
    const result = await txt2img(p, {
      signal: controller.signal,
      onProgress: (pr) => send("progress", pr),
    });
    checkAborted();

    const { generationId, imageIds } = saveGeneration(p, result);
    send("complete", {
      generationId,
      imageIds,
      seed: p.seed,
      imageCount: imageIds.length,
      api: result.api,
      timings: { totalMs: Date.now() - t0, generateMs: result.elapsedMs ?? Date.now() - tGen },
    });
  } catch (err) {
    if (err.code !== "cancelled") console.error("Image generation failed:", err.message);
    send("error", { error: err.message });
  } finally {
    if (sdLoaded) {
      try {
        await unloadSdModel();
      } catch (err) {
        console.error("Failed to unload SD model:", err.message);
      }
    }
    releaseImageLock();
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
      g.sampler, g.scheduler, g.seed, g.batch_count, g.created_at,
      (SELECT COUNT(*) FROM generated_images gi WHERE gi.generation_id = g.id) AS image_count,
      (SELECT id FROM generated_images gi WHERE gi.generation_id = g.id ORDER BY position LIMIT 1) AS first_image_id
    FROM image_generations g
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

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

export default router;
