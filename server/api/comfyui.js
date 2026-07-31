/**
 * ComfyUI proxy router.
 *
 * Proxies requests to a local ComfyUI instance and provides:
 *  - Model/sampler listing
 *  - txt2img / img2img generation with SSE progress streaming
 *  - Image generation history (DB-backed)
 *  - Config management (ComfyUI URL)
 */

import { Router } from "express";
import { nanoid } from "nanoid";
import WebSocket from "ws";
import fs from "fs";
import path from "path";
import { pipeline } from "stream/promises";
import { getDb } from "../db/index.js";
import { buildTxt2ImgWorkflow, buildImg2ImgWorkflow } from "../comfyui/workflows.js";

const router = Router();

// ── helpers ────────────────────────────────────────────────────────────

/** Get ComfyUI URL from the shared config (set in server/index.js) */
function getComfyUrl(req) {
  return req.app.get("comfyuiUrl") || "http://localhost:8188";
}

/** Proxy a simple GET to ComfyUI and return the JSON. */
async function comfyGet(comfyUrl, path) {
  const res = await fetch(`${comfyUrl}${path}`);
  if (!res.ok) throw new Error(`ComfyUI ${path}: ${res.status}`);
  return res.json();
}

// ── config ─────────────────────────────────────────────────────────────

router.get("/config", (req, res) => {
  res.json({ comfyuiUrl: getComfyUrl(req) });
});

router.put("/config", async (req, res) => {
  const { comfyuiUrl } = req.body;
  if (!comfyuiUrl) return res.status(400).json({ error: "comfyuiUrl is required" });

  try {
    const parsed = new URL(comfyuiUrl);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.status(400).json({ error: "URL must use http or https protocol" });
    }
  } catch {
    return res.status(400).json({ error: "Invalid URL format" });
  }

  req.app.set("comfyuiUrl", comfyuiUrl);
  // Persist via the callback registered in index.js
  if (typeof req.app.get("saveComfyuiConfig") === "function") {
    await req.app.get("saveComfyuiConfig")(comfyuiUrl);
  }
  res.json({ success: true, comfyuiUrl });
});

// ── status ─────────────────────────────────────────────────────────────

router.get("/status", async (req, res) => {
  try {
    const data = await comfyGet(getComfyUrl(req), "/system_stats");
    res.json({ ok: true, ...data });
  } catch {
    res.json({ ok: false });
  }
});

// ── models ─────────────────────────────────────────────────────────────

router.get("/models/checkpoints", async (req, res) => {
  try {
    const info = await comfyGet(getComfyUrl(req), "/object_info/CheckpointLoaderSimple");
    const choices =
      info?.CheckpointLoaderSimple?.input?.required?.ckpt_name?.[0] || [];
    res.json({ models: choices });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch checkpoints: " + err.message });
  }
});

router.get("/models/loras", async (req, res) => {
  try {
    const info = await comfyGet(getComfyUrl(req), "/object_info/LoraLoader");
    const choices =
      info?.LoraLoader?.input?.required?.lora_name?.[0] || [];
    res.json({ models: choices });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch LoRAs: " + err.message });
  }
});

router.get("/models/vaes", async (req, res) => {
  try {
    const info = await comfyGet(getComfyUrl(req), "/object_info/VAELoader");
    const choices =
      info?.VAELoader?.input?.required?.vae_name?.[0] || [];
    res.json({ models: choices });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch VAEs: " + err.message });
  }
});

router.get("/samplers", async (req, res) => {
  try {
    const info = await comfyGet(getComfyUrl(req), "/object_info/KSampler");
    const samplers =
      info?.KSampler?.input?.required?.sampler_name?.[0] || [];
    const schedulers =
      info?.KSampler?.input?.required?.scheduler?.[0] || [];
    res.json({ samplers, schedulers });
  } catch (err) {
    res.status(502).json({ error: "Failed to fetch samplers: " + err.message });
  }
});

// ── txt2img generation ─────────────────────────────────────────────────

router.post("/txt2img", async (req, res) => {
  const comfyUrl = getComfyUrl(req);
  const params = req.body;

  if (!params.prompt) {
    return res.status(400).json({ error: "prompt is required" });
  }
  if (!params.checkpoint) {
    return res.status(400).json({ error: "checkpoint is required" });
  }

  // Build workflow
  const workflow = buildTxt2ImgWorkflow(params);
  const actualSeed = workflow._meta.seed;

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const sendSSE = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  let ws;
  let promptId;

  try {
    // Generate a client_id for the WebSocket session
    const clientId = nanoid();

    // Connect WebSocket for progress
    const wsUrl = comfyUrl.replace(/^http/, "ws") + `/ws?clientId=${clientId}`;
    ws = new WebSocket(wsUrl);

    await new Promise((resolve, reject) => {
      ws.on("open", resolve);
      ws.on("error", reject);
      const timeout = setTimeout(() => reject(new Error("WebSocket timeout")), 5000);
      ws.on("open", () => clearTimeout(timeout));
    });

    // Queue the prompt
    const queueRes = await fetch(`${comfyUrl}/prompt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: workflow.prompt, client_id: clientId }),
    });

    if (!queueRes.ok) {
      const errText = await queueRes.text();
      throw new Error(`Failed to queue prompt: ${errText}`);
    }

    const queueData = await queueRes.json();
    promptId = queueData.prompt_id;
    sendSSE("queued", { promptId });

    // Listen for progress & completion
    await new Promise((resolve, reject) => {
      // Handle client disconnect
      req.on("close", () => {
        ws.close();
        resolve();
      });

      ws.on("message", (raw) => {
        try {
          const msg = JSON.parse(raw.toString());

          if (msg.type === "progress" && msg.data?.prompt_id === promptId) {
            const pct = msg.data.value / msg.data.max;
            sendSSE("progress", { value: pct, step: msg.data.value, totalSteps: msg.data.max });
          }

          if (msg.type === "executing" && msg.data?.prompt_id === promptId) {
            if (msg.data.node === null) {
              // Execution finished
              resolve();
            }
          }

          if (msg.type === "execution_error" && msg.data?.prompt_id === promptId) {
            reject(new Error(msg.data.exception_message || "ComfyUI execution error"));
          }
        } catch {
          // skip non-JSON or binary preview frames
        }
      });

      ws.on("error", reject);
      ws.on("close", resolve);
    });

    // Fetch results from history
    const historyRes = await fetch(`${comfyUrl}/history/${promptId}`);
    if (!historyRes.ok) throw new Error("Failed to fetch generation history from ComfyUI");
    const history = await historyRes.json();

    const outputs = history[promptId]?.outputs;
    if (!outputs) throw new Error("No outputs in ComfyUI history");

    // Find the SaveImage node outputs
    const imageOutputs = [];
    for (const nodeId of Object.keys(outputs)) {
      const nodeOut = outputs[nodeId];
      if (nodeOut.images) {
        for (const img of nodeOut.images) {
          imageOutputs.push(img);
        }
      }
    }

    if (imageOutputs.length === 0) throw new Error("No images in output");

    // Fetch each image and persist to DB
    const db = getDb();
    const generationId = nanoid();
    const now = Date.now();

    // Insert generation record
    db.prepare(`
      INSERT INTO image_generations (id, prompt, negative_prompt, model, width, height, steps, cfg_scale, sampler, scheduler, seed, batch_count, workflow_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      generationId,
      params.prompt,
      params.negativePrompt || "",
      params.checkpoint,
      params.width || 512,
      params.height || 512,
      params.steps || 20,
      params.cfgScale || 7,
      params.sampler || "euler",
      params.scheduler || "normal",
      actualSeed,
      params.batchCount || 1,
      JSON.stringify(workflow.prompt),
      now,
    );

    const imageIds = [];
    for (let i = 0; i < imageOutputs.length; i++) {
      const img = imageOutputs[i];
      const imgUrl = `${comfyUrl}/view?filename=${encodeURIComponent(img.filename)}&subfolder=${encodeURIComponent(img.subfolder || "")}&type=${encodeURIComponent(img.type || "output")}`;

      const imgRes = await fetch(imgUrl);
      if (!imgRes.ok) continue;

      const buffer = Buffer.from(await imgRes.arrayBuffer());
      const imageId = nanoid();

      db.prepare(`
        INSERT INTO generated_images (id, generation_id, filename, image_data, width, height, position, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(imageId, generationId, img.filename, buffer, params.width || 512, params.height || 512, i, now);

      imageIds.push(imageId);
    }

    sendSSE("complete", {
      generationId,
      imageIds,
      seed: actualSeed,
      imageCount: imageIds.length,
    });
  } catch (err) {
    sendSSE("error", { error: err.message });
  } finally {
    if (ws && ws.readyState === WebSocket.OPEN) ws.close();
    res.end();
  }
});

// ── image history (DB) ─────────────────────────────────────────────────

router.get("/generations", (req, res) => {
  const db = getDb();
  const page = parseInt(req.query.page) || 1;
  const limit = Math.min(parseInt(req.query.limit) || 20, 100);
  const offset = (page - 1) * limit;

  const generations = db.prepare(`
    SELECT g.*,
      (SELECT COUNT(*) FROM generated_images gi WHERE gi.generation_id = g.id) AS image_count
    FROM image_generations g
    ORDER BY g.created_at DESC
    LIMIT ? OFFSET ?
  `).all(limit, offset);

  const total = db.prepare("SELECT COUNT(*) AS count FROM image_generations").get().count;

  // Attach first image id for thumbnail
  for (const gen of generations) {
    const firstImg = db.prepare(
      "SELECT id FROM generated_images WHERE generation_id = ? ORDER BY position LIMIT 1"
    ).get(gen.id);
    gen.thumbnailImageId = firstImg?.id || null;
  }

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

// Serve image binary
router.get("/generations/:genId/images/:imageId", (req, res) => {
  const db = getDb();
  const img = db.prepare(
    "SELECT image_data, filename FROM generated_images WHERE id = ? AND generation_id = ?"
  ).get(req.params.imageId, req.params.genId);

  if (!img || !img.image_data) {
    return res.status(404).json({ error: "Image not found" });
  }

  // Determine content type from filename
  const ext = img.filename.split(".").pop()?.toLowerCase();
  const contentType = ext === "jpg" || ext === "jpeg" ? "image/jpeg" : "image/png";

  res.setHeader("Content-Type", contentType);
  res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
  res.send(img.image_data);
});

// ── ComfyUI models path config ─────────────────────────────────────────

router.get("/models-path", (req, res) => {
  const modelsPath = req.app.get("comfyModelsPath") || "";
  res.json({ modelsPath });
});

router.put("/models-path", async (req, res) => {
  const { modelsPath } = req.body;
  if (!modelsPath) return res.status(400).json({ error: "modelsPath is required" });

  // Validate path exists
  try {
    const stat = fs.statSync(modelsPath);
    if (!stat.isDirectory()) {
      return res.status(400).json({ error: "Path is not a directory" });
    }
  } catch {
    return res.status(400).json({ error: "Path does not exist or is not accessible" });
  }

  req.app.set("comfyModelsPath", modelsPath);
  if (typeof req.app.get("saveComfyuiConfig") === "function") {
    await req.app.get("saveComfyuiConfig")(getComfyUrl(req), modelsPath);
  }
  res.json({ success: true, modelsPath });
});

// ── Civitai search proxy ───────────────────────────────────────────────

const CIVITAI_API = "https://civitai.com/api/v1";

router.get("/civitai/search", async (req, res) => {
  const { query, types, sort, limit, page, nsfw } = req.query;

  const params = new URLSearchParams();
  if (query) params.set("query", query);
  if (types) params.set("types", types);
  if (sort) params.set("sort", sort);
  params.set("limit", limit || "20");
  params.set("page", page || "1");
  params.set("nsfw", nsfw || "false");

  try {
    const response = await fetch(`${CIVITAI_API}/models?${params.toString()}`, {
      headers: { "Content-Type": "application/json" },
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) {
      throw new Error(`Civitai API responded with ${response.status}`);
    }

    const data = await response.json();
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: "Failed to search Civitai: " + err.message });
  }
});

// ── Model download (SSE progress) ──────────────────────────────────────

// Map model type to ComfyUI subdirectory
const MODEL_TYPE_DIRS = {
  Checkpoint: "checkpoints",
  LORA: "loras",
  LoCon: "loras",
  TextualInversion: "embeddings",
  VAE: "vae",
  Controlnet: "controlnet",
  Upscaler: "upscale_models",
};

// Track active downloads for cancel support
const activeDownloads = new Map();

router.post("/models/download", async (req, res) => {
  const { downloadUrl, filename, modelType } = req.body;
  const modelsPath = req.app.get("comfyModelsPath");

  if (!modelsPath) {
    return res.status(400).json({ error: "ComfyUI models path not configured. Set it in Settings." });
  }
  if (!downloadUrl) {
    return res.status(400).json({ error: "downloadUrl is required" });
  }
  if (!filename) {
    return res.status(400).json({ error: "filename is required" });
  }

  const subDir = MODEL_TYPE_DIRS[modelType] || "checkpoints";
  const targetDir = path.join(modelsPath, subDir);
  const targetFile = path.join(targetDir, filename);

  // Prevent path traversal
  if (!targetFile.startsWith(path.resolve(modelsPath))) {
    return res.status(400).json({ error: "Invalid filename" });
  }

  // Ensure target directory exists
  try {
    fs.mkdirSync(targetDir, { recursive: true });
  } catch (err) {
    return res.status(500).json({ error: "Failed to create target directory: " + err.message });
  }

  // Check if file already exists
  if (fs.existsSync(targetFile)) {
    return res.status(409).json({ error: "File already exists: " + filename });
  }

  // Set up SSE
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  const downloadId = nanoid();
  const sendSSE = (type, data) => {
    res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
  };

  const controller = new AbortController();
  activeDownloads.set(downloadId, controller);

  sendSSE("started", { downloadId, filename, targetDir: subDir });

  req.on("close", () => {
    controller.abort();
    activeDownloads.delete(downloadId);
  });

  let writeStream;

  try {
    // Follow redirects and download
    const response = await fetch(downloadUrl, {
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Download failed: HTTP ${response.status}`);
    }

    const totalBytes = parseInt(response.headers.get("content-length") || "0", 10);
    let downloadedBytes = 0;
    let lastProgressUpdate = 0;

    writeStream = fs.createWriteStream(targetFile);

    // Stream the response body to the file while tracking progress
    const reader = response.body.getReader();

    while (true) {
      if (controller.signal.aborted) {
        throw new Error("Download cancelled");
      }

      const { done, value } = await reader.read();
      if (done) break;

      writeStream.write(Buffer.from(value));
      downloadedBytes += value.length;

      // Send progress update every 500ms to avoid flooding
      const now = Date.now();
      if (now - lastProgressUpdate > 500) {
        lastProgressUpdate = now;
        const pct = totalBytes > 0 ? downloadedBytes / totalBytes : 0;
        sendSSE("progress", {
          downloadId,
          downloaded: downloadedBytes,
          total: totalBytes,
          percent: Math.round(pct * 100),
        });
      }
    }

    // Close the write stream
    await new Promise((resolve, reject) => {
      writeStream.end((err) => (err ? reject(err) : resolve()));
    });

    sendSSE("complete", {
      downloadId,
      filename,
      targetDir: subDir,
      size: downloadedBytes,
    });
  } catch (err) {
    // Clean up partial file
    try {
      if (writeStream) writeStream.destroy();
      if (fs.existsSync(targetFile)) fs.unlinkSync(targetFile);
    } catch {
      // Ignore cleanup errors
    }

    if (err.name !== "AbortError") {
      sendSSE("error", { downloadId, error: err.message });
    }
  } finally {
    activeDownloads.delete(downloadId);
    res.end();
  }
});

router.post("/models/download/cancel", (req, res) => {
  const { downloadId } = req.body;
  const controller = activeDownloads.get(downloadId);
  if (controller) {
    controller.abort();
    activeDownloads.delete(downloadId);
    res.json({ success: true });
  } else {
    res.status(404).json({ error: "Download not found" });
  }
});

export default router;
