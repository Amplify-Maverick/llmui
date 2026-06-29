import express from "express";
import fs from "fs/promises";
import path from "path";
import os from "os";

const router = express.Router();

const STORAGE_DIR = path.join(os.homedir(), ".llmui");
const SETUP_FILE = path.join(STORAGE_DIR, "setup_complete");
// Note: GET /api/setup/status is handled directly in server/index.js (unauthenticated)

// POST /api/setup/test-ollama — verify a candidate Ollama URL is reachable
router.post("/test-ollama", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: "url is required" });

  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return res.json({ ok: false, error: "URL must use http or https" });
    }
  } catch {
    return res.json({ ok: false, error: "Invalid URL" });
  }

  try {
    const response = await fetch(`${url}/api/tags`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return res.json({ ok: false, error: `Ollama responded with HTTP ${response.status}` });
    }
    const data = await response.json();
    const modelCount = data.models?.length ?? 0;
    res.json({ ok: true, modelCount });
  } catch (err) {
    const msg = err.name === "TimeoutError"
      ? "Connection timed out after 5s"
      : err.message;
    res.json({ ok: false, error: msg });
  }
});

// POST /api/setup/test-gpu — verify a candidate GPU stats server URL is reachable
router.post("/test-gpu", async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ ok: false, error: "url is required" });

  try {
    const response = await fetch(`${url}/health`, {
      signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) {
      return res.json({ ok: false, error: `GPU stats server responded with HTTP ${response.status}` });
    }
    const data = await response.json();
    res.json({ ok: true, gpuCount: data.gpuCount ?? null });
  } catch (err) {
    const msg = err.name === "TimeoutError"
      ? "Connection timed out after 5s"
      : err.message;
    res.json({ ok: false, error: msg });
  }
});

// POST /api/setup/complete — save config and mark setup done
// Body: { ollamaUrl, remoteGpuUrl }
// The actual saving of ollamaUrl/remoteGpuUrl is done by the caller via
// PUT /ollama/config and PUT /api/gpu-config before calling this endpoint.
// This just writes the marker file.
router.post("/complete", async (req, res) => {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
    await fs.writeFile(SETUP_FILE, new Date().toISOString(), "utf-8");
    res.json({ ok: true });
  } catch (err) {
    console.error("Error marking setup complete:", err);
    res.status(500).json({ ok: false, error: "Failed to save setup state" });
  }
});

export default router;
