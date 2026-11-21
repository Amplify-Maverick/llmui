import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { existsSync } from "fs";
import { fileURLToPath } from "url";
import { getToolsSchema } from "./tools/index.js";
import { openaiRouter, toOpenAIMessage } from "./openai.js";

// Database and API imports
import { getDb, closeDb } from "./db/index.js";
import { checkAndMigrate } from "./db/migrate.js";
import conversationsRouter from "./api/conversations.js";
import messagesRouter from "./api/messages.js";
import settingsRouter from "./api/settings.js";
import searchRouter from "./api/search.js";
import backupRouter from "./api/backup.js";
import exportRouter from "./api/export.js";
import setupRouter from "./api/setup.js";
import imagesRouter from "./api/images.js";
import llamaRouter from "./api/llama.js";
import { loadSdConfig, chatGate, sdStatus } from "./sd.js";
import { llamaFetch, keyHint } from "./llama.js";
import { fetchHelper, helperConfigured, normalizeHelperGpu } from "./sdfetch.js";
import { createAuth, readOrCreateSecret, pruneUnusedDevices } from "./auth.js";
import { runsRouter, recoverInterruptedRuns, flushRuns } from "./runs.js";
import { recoverInterruptedJobs, cleanUpInterruptedJob, flushJobs } from "./imageJobs.js";
import { runToolLoop } from "./chatLoop.js";
import {
  getMachine,
  listMachines,
  resolveMachine,
  routeTo,
  machineFromQuery,
  selectMachine,
  probeMachine,
  machinesSnapshot,
  startMachineMonitor,
  networkErrorText,
} from "./backends.js";

const execFileAsync = promisify(execFile);

const app = express();
const PORT = Number(process.env.LLMUI_PORT) || 3001;
// Loopback only by default. Remote clients reach LLMUI through `tailscale serve`
// (HTTPS on the tailnet -> this server on 127.0.0.1:3001, which also serves the
// built frontend from dist/). Set HOST to override, e.g. HOST=0.0.0.0 to listen
// on every interface.
const HOST = process.env.HOST || "127.0.0.1";

// Production frontend build (`npm run build` -> dist/). Served as static files
// with an SPA fallback when present; in development Vite serves the frontend
// on :3000 and proxies backend routes here instead.
const DIST_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "dist");
const DIST_INDEX = path.join(DIST_DIR, "index.html");
// Path prefixes owned by the backend. Never answered with index.html.
const BACKEND_PREFIXES = ["/api", "/openai", "/storage", "/health"];

// Storage directory: ~/.llmui
const STORAGE_DIR = path.join(os.homedir(), ".llmui");
const TOKEN_FILE = path.join(STORAGE_DIR, "token");
const SESSION_SECRET_FILE = path.join(STORAGE_DIR, "session_secret");
const GPU_CONFIG_FILE = path.join(STORAGE_DIR, "gpu_config.json");
// Pre-OpenAI-migration installs kept remoteGpuUrl in this file; read it once as a fallback.
const LEGACY_OLLAMA_CONFIG_FILE = path.join(STORAGE_DIR, "ollama_config.json");

let authToken = null;

// Optional remote GPU stats server URL (e.g. http://workstation-tailscale-ip:3002)
// When set, /api/gpu and /api/hardware proxy to this server instead of running nvidia-smi locally.
let remoteGpuUrl = process.env.REMOTE_GPU_URL || null;

async function loadGpuConfig() {
  for (const file of [GPU_CONFIG_FILE, LEGACY_OLLAMA_CONFIG_FILE]) {
    try {
      const config = JSON.parse(await fs.readFile(file, "utf-8"));
      if (config.remoteGpuUrl) remoteGpuUrl = config.remoteGpuUrl;
      return;
    } catch (err) {
      if (err.code !== "ENOENT") console.error(`Error loading ${path.basename(file)}:`, err);
    }
  }
}

async function saveGpuConfig() {
  await ensureStorageDir();
  await fs.writeFile(GPU_CONFIG_FILE, JSON.stringify({ remoteGpuUrl }, null, 2));
}

async function getOrCreateToken() {
  try {
    authToken = await fs.readFile(TOKEN_FILE, "utf-8");
    authToken = authToken.trim();
  } catch (err) {
    if (err.code === "ENOENT") {
      await ensureStorageDir();
      authToken = crypto.randomBytes(32).toString("hex");
      await fs.writeFile(TOKEN_FILE, authToken, { mode: 0o600 });
      console.log("Generated new auth token");
    } else {
      throw err;
    }
  }
  return authToken;
}

// Auth (server/auth.js): device tokens, the ~/.llmui/token server token, and
// browser session cookies. Built at startup once the token and the session
// secret are read; no request arrives before then.
let auth = null;
const requireAuth = (req, res, next) => auth.requireAuth(req, res, next);

// CORS configuration with allowlist
// Default allows localhost:3000, additional origins can be added via LLMUI_ALLOWED_ORIGINS env var
const defaultOrigins = ["http://localhost:3000", "http://127.0.0.1:3000"];
const envOrigins = process.env.LLMUI_ALLOWED_ORIGINS
  ? process.env.LLMUI_ALLOWED_ORIGINS.split(",").map((s) => s.trim())
  : [];
const allowedOrigins = [...defaultOrigins, ...envOrigins];

app.use(
  cors({
    origin: (origin, callback) => {
      // Allow requests with no origin (e.g., curl, mobile apps, same-origin)
      // Disallowed origins get no CORS headers rather than an error: throwing
      // here turns every request into an opaque HTML 500, which is impossible
      // to debug from the client. Omitting the headers lets the browser
      // enforce the policy, and auth still gates every endpoint.
      callback(null, !origin || allowedOrigins.includes(origin));
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization", "X-LLMUI-Machine", "X-LLMUI-Web"],
    exposedHeaders: ["X-LLMUI-Machine", "X-LLMUI-Run-Id", "X-LLMUI-Job-Id"],
    methods: ["GET", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"],
  })
);
app.use(express.json({ limit: "5mb" }));
// Requests arrive via tailscale serve (production) or the Vite dev proxy, both on
// loopback. Trust X-Forwarded-For only from loopback hops so req.ip is the real
// client (for rate limiting and the localhost-only /auth/token check).
app.set("trust proxy", "loopback");

// ============================================================
// Rate limiting
// Global: 100 requests per minute per IP (generous for normal use)
// Storage writes: 30 requests per minute per IP (tighter to prevent disk-fill DoS)
// ============================================================
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 200, // bumped from 100: split storage means more small reads/writes
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later" },
});

const storageWriteLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60, // bumped from 30: split storage writes index + conversation per save
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many storage writes, please try again later" },
});

// Built frontend assets. Mounted ahead of the rate limiter so a page load's
// asset requests don't eat into the API budget. index: false keeps "/" for the
// SPA handler below. Vite fingerprints everything under /assets, so those are
// cached hard; everything else (index.html, favicon, ...) revalidates.
const hasDist = existsSync(DIST_INDEX);
if (hasDist) {
  app.use(
    express.static(DIST_DIR, {
      index: false,
      setHeaders: (res, filePath) => {
        if (filePath.startsWith(path.join(DIST_DIR, "assets") + path.sep)) {
          res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
        } else {
          res.setHeader("Cache-Control", "no-cache");
        }
      },
    })
  );
}

app.use(globalLimiter);

// Browser sessions and paired devices (POST /api/session, /api/devices).
// Registered before the authenticated /api routers so they don't shadow it.
app.use("/api", (req, res, next) => auth.router(req, res, next));

// Ensure storage directory exists
async function ensureStorageDir() {
  try {
    await fs.mkdir(STORAGE_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
}

function getFilePath(key) {
  // Sanitize key to prevent directory traversal
  const safeKey = key.replace(/[^a-zA-Z0-9_-]/g, "_");
  return path.join(STORAGE_DIR, `${safeKey}.json`);
}

// GET /storage/:key - Load data
app.get("/storage/:key", requireAuth, async (req, res) => {
  try {
    const filePath = getFilePath(req.params.key);
    const data = await fs.readFile(filePath, "utf-8");
    res.json({ data: JSON.parse(data) });
  } catch (err) {
    if (err.code === "ENOENT") {
      res.json({ data: null });
    } else {
      console.error(`Error loading ${req.params.key}:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// PUT /storage/:key - Save data (rate-limited to prevent disk-fill DoS)
app.put("/storage/:key", storageWriteLimiter, requireAuth, async (req, res) => {
  try {
    await ensureStorageDir();
    const filePath = getFilePath(req.params.key);
    await fs.writeFile(filePath, JSON.stringify(req.body.data, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error(`Error saving ${req.params.key}:`, err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE /storage/:key - Remove data
app.delete("/storage/:key", requireAuth, async (req, res) => {
  try {
    const filePath = getFilePath(req.params.key);
    await fs.unlink(filePath);
    res.json({ success: true });
  } catch (err) {
    if (err.code === "ENOENT") {
      res.json({ success: true });
    } else {
      console.error(`Error removing ${req.params.key}:`, err);
      res.status(500).json({ error: "Internal server error" });
    }
  }
});

// Root route: the app when a build is present, else a status blurb.
app.get("/", (req, res) => {
  if (hasDist) {
    res.set("Cache-Control", "no-cache");
    return res.sendFile(DIST_INDEX);
  }
  res.json({
    name: "LLMUI Storage Server",
    status: "running",
  });
});

// Health check - unauthenticated, used by start script
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// GET /api/gpu-config - Get current remote GPU stats URL
app.get("/api/gpu-config", requireAuth, (req, res) => {
  res.json({ remoteGpuUrl });
});

// PUT /api/gpu-config - Set remote GPU stats server URL (or null to use local)
app.put("/api/gpu-config", requireAuth, async (req, res) => {
  const { remoteGpuUrl: newUrl } = req.body;

  if (newUrl !== null && newUrl !== undefined && newUrl !== "") {
    try {
      const parsed = new URL(newUrl);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        return res.status(400).json({ error: "URL must use http or https" });
      }
    } catch {
      return res.status(400).json({ error: "Invalid URL format" });
    }
    remoteGpuUrl = newUrl;
  } else {
    remoteGpuUrl = null;
  }

  try {
    await saveGpuConfig();
    res.json({ ok: true, remoteGpuUrl });
  } catch (err) {
    console.error("Error saving GPU config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// POST /api/chat-with-tools - the tool loop (server/chatLoop.js) over a history
// the client sends, streamed as NDJSON. Nothing is stored; see
// POST /api/conversations/:id/send (server/runs.js) for the server-side
// version. Closing the connection stops generation.
// Body: { model, messages, options: { modelOptions }, enabledTools, enableThinking? }
// Emits: {type:"thinking"|"content"|"tool_call"|"tool_result"|"done"|"error", ...}
// (documented in docs/api.md)
app.post("/api/chat-with-tools", requireAuth, chatGate(), async (req, res) => {
  const { model, messages, options = {}, enabledTools = null, enableThinking = false } = req.body;
  if (!model) return res.status(400).json({ error: "Model is required" });
  if (!Array.isArray(messages)) return res.status(400).json({ error: "messages must be an array" });

  // Listen on `res`, not `req`: since Node 16, req "close" fires once the
  // request body has been read, not when the client goes away.
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });
  res.setHeader("Content-Type", "application/x-ndjson");
  res.setHeader("X-Accel-Buffering", "no");
  const emit = (e) => {
    if (!res.writableEnded) res.write(JSON.stringify(e) + "\n");
  };

  try {
    const result = await runToolLoop({
      machine: req.machine,
      res,
      model,
      messages: messages.map(toOpenAIMessage),
      tools: getToolsSchema(enabledTools),
      modelOptions: options.modelOptions || {},
      enableThinking,
      signal: controller.signal,
      emit,
    });
    emit({ type: "done", iterations: result.iterations, machine: result.machine.id, timings: result.timings });
  } catch (err) {
    if (err.name === "AbortError") {
      console.log("chat-with-tools aborted: client disconnected");
    } else {
      if (err.code !== "max_iterations") console.error("Error in chat-with-tools:", err);
      emit({ type: "error", error: err.message || "Tool execution failed" });
    }
  }
  if (!res.writableEnded) res.end();
});

// ============================================================
// GPU stats endpoint (authenticated)
// Uses a persistent nvidia-smi --loop=1 subprocess to avoid cold-start
// overhead from spawning a new process on each poll. The subprocess
// outputs GPU stats every second; we parse stdout continuously and
// cache the latest data for the API endpoint to return.
// ============================================================

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit,clocks.current.graphics,clocks.current.memory",
  "--format=csv,noheader,nounits",
  "--loop=1", // Output stats every 1 second continuously
];

let gpuCache = { data: null, timestamp: 0 };
let nvidiaSmiProcess = null;
let nvidiaSmiBuffer = "";
// Set once nvidia-smi is confirmed missing (ENOENT), so we stop respawning it
// on every /api/hardware request on GPU-less machines.
let nvidiaSmiUnavailable = false;

/**
 * Parse a single CSV line from nvidia-smi output into a GPU object.
 */
function parseGpuLine(line) {
  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 11) return null;
  return {
    index: parseInt(parts[0], 10),
    name: parts[1],
    utilization: parseFloat(parts[2]),       // %
    memoryUsed: parseFloat(parts[3]),         // MiB
    memoryTotal: parseFloat(parts[4]),        // MiB
    temperature: parseFloat(parts[5]),        // °C
    fanSpeed: parseFloat(parts[6]),           // %
    powerDraw: parseFloat(parts[7]),          // W
    powerLimit: parseFloat(parts[8]),         // W
    clockGraphics: parseFloat(parts[9]),      // MHz
    clockMemory: parseFloat(parts[10]),       // MHz
  };
}

/**
 * Start the persistent nvidia-smi subprocess.
 * Parses stdout continuously and updates gpuCache with latest stats.
 */
function startNvidiaSmiLoop() {
  if (nvidiaSmiProcess) return; // Already running
  if (nvidiaSmiUnavailable) return; // Confirmed missing, don't keep retrying

  try {
    nvidiaSmiProcess = spawn("nvidia-smi", NVIDIA_SMI_ARGS, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    nvidiaSmiProcess.stdout.on("data", (chunk) => {
      nvidiaSmiBuffer += chunk.toString();

      // Process complete lines
      const lines = nvidiaSmiBuffer.split("\n");
      nvidiaSmiBuffer = lines.pop(); // Keep incomplete line in buffer

      // nvidia-smi --loop outputs all GPUs, then a blank line, then repeats.
      // We collect GPU lines until we hit a blank or the next cycle.
      const gpus = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue; // Skip blank lines between cycles
        const gpu = parseGpuLine(trimmed);
        if (gpu) gpus.push(gpu);
      }

      if (gpus.length > 0) {
        const now = Date.now();
        gpuCache = {
          data: { ok: true, gpus, timestamp: now },
          timestamp: now,
        };
      }
    });

    nvidiaSmiProcess.stderr.on("data", (chunk) => {
      console.error("nvidia-smi stderr:", chunk.toString());
    });

    nvidiaSmiProcess.on("error", (err) => {
      if (err.code === "ENOENT") {
        nvidiaSmiUnavailable = true;
        console.log("nvidia-smi not found; disabling GPU monitoring for this session");
      } else {
        console.error("nvidia-smi process error:", err);
      }
      nvidiaSmiProcess = null;
    });

    nvidiaSmiProcess.on("exit", (code, signal) => {
      if (signal !== "SIGTERM" && signal !== "SIGINT") {
        console.error(`nvidia-smi exited unexpectedly (code=${code}, signal=${signal})`);
      }
      nvidiaSmiProcess = null;
    });

    console.log("Started persistent nvidia-smi subprocess (--loop=1)");
  } catch (err) {
    console.error("Failed to start nvidia-smi:", err);
    nvidiaSmiProcess = null;
  }
}

/**
 * Stop the persistent nvidia-smi subprocess.
 */
function stopNvidiaSmiLoop() {
  if (nvidiaSmiProcess) {
    nvidiaSmiProcess.kill("SIGTERM");
    nvidiaSmiProcess = null;
    console.log("Stopped nvidia-smi subprocess");
  }
}

// GET /api/gpu?machine=<id> - live GPU stats from a machine's sd-fetch helper
// (GET /v1/gpu: nvidia-smi or amdgpu sysfs on that machine). Without ?machine,
// the machine chat is currently routed to. Reading stats never routes any
// work to a machine.
app.get("/api/gpu", requireAuth, async (req, res) => {
  const machine = req.query.machine ? getMachine(String(req.query.machine)) : resolveMachine("chat").machine;
  if (!machine) return res.status(404).json({ ok: false, error: "Unknown machine" });
  res.set("Cache-Control", "no-store");
  try {
    const data = await fetchHelper(machine, "/v1/gpu", { timeout: 4000 });
    res.json({
      ok: true,
      machine: machine.id,
      source: data.source || null,
      error: data.error || null,
      gpus: (data.gpus || []).map(normalizeHelperGpu),
      timestamp: Date.now(),
    });
  } catch (err) {
    res.status(err.status === 503 ? 503 : 502).json({ ok: false, machine: machine.id, error: err.message });
  }
});

/**
 * Real "available" RAM — how much a new process can allocate without
 * swapping. os.freemem() (used for ram.freeGb below) reports raw MemFree,
 * which excludes the disk cache Linux is using but can reclaim on demand,
 * so on a box that's been up a while it badly understates headroom. Read
 * /proc/meminfo's MemAvailable instead, which accounts for reclaimable
 * cache the same way `free -h`'s "available" column does.
 */
async function getAvailableRamGb() {
  if (os.platform() === "linux") {
    try {
      const meminfo = await fs.readFile("/proc/meminfo", "utf-8");
      const match = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m);
      if (match) return +(Number(match[1]) / (1024 ** 2)).toFixed(1);
    } catch {
      // fall through to the freemem-based estimate below
    }
  }
  return +(os.freemem() / (1024 ** 3)).toFixed(1);
}

/**
 * Detect this machine's CPU/RAM/GPU for /api/hardware (local case).
 */
async function getLocalHardwareInfo() {
  const totalRamGb = +(os.totalmem() / (1024 ** 3)).toFixed(1);
  const freeRamGb = +(os.freemem() / (1024 ** 3)).toFixed(1);
  const availableRamGb = await getAvailableRamGb();
  const cpuModel = os.cpus()[0]?.model || "Unknown";
  const cpuCores = os.cpus().length;

  // GPU info from nvidia-smi cache (if available)
  let gpus = [];
  if (!nvidiaSmiProcess && !nvidiaSmiUnavailable) {
    startNvidiaSmiLoop();
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }
  if (gpuCache.data?.gpus) {
    gpus = gpuCache.data.gpus.map((g) => ({
      index: g.index,
      name: g.name,
      vramTotalMb: g.memoryTotal,
      vramFreeMb: g.memoryTotal - g.memoryUsed,
      vramUsedMb: g.memoryUsed,
      vramTotalGb: +(g.memoryTotal / 1024).toFixed(1),
      vramFreeGb: +((g.memoryTotal - g.memoryUsed) / 1024).toFixed(1),
    }));
  }

  // Derive total available VRAM across all GPUs (for model compatibility)
  const totalVramGb = gpus.length > 0
    ? +gpus.reduce((sum, g) => sum + g.vramTotalGb, 0).toFixed(1)
    : null;

  // On CPU-only machines, a model can fit in RAM yet still be too slow to
  // use interactively — CPU token throughput drops off with parameter count
  // and scales up with core count. Cap the size of models recommended as
  // "good" to one that stays reasonably responsive on this many cores,
  // anchored on an 8-core/6GB baseline (roughly an 8B Q4 model, which is
  // about the largest that feels usable in CPU chat on a modern 8-core box).
  const CPU_BASELINE_CORES = 8;
  const CPU_BASELINE_MODEL_GB = 6;
  const cpuSpeedCapGb = gpus.length === 0
    ? +Math.min(32, Math.max(2, CPU_BASELINE_MODEL_GB * (cpuCores / CPU_BASELINE_CORES))).toFixed(1)
    : null;

  // Single number model recommendations are rated against: GPU VRAM if
  // present, otherwise real currently-available RAM (so other services
  // already running on this machine reduce it) capped by cpuSpeedCapGb
  // (so recommendations skew toward models that actually run well on CPU,
  // not just models that fit without OOMing).
  const effectiveCapacityGb = totalVramGb ?? (
    availableRamGb != null ? +Math.min(availableRamGb, cpuSpeedCapGb).toFixed(1) : null
  );

  return {
    ok: true,
    platform: os.platform(),
    arch: os.arch(),
    cpu: { model: cpuModel, cores: cpuCores },
    ram: { totalGb: totalRamGb, freeGb: freeRamGb, availableGb: availableRamGb },
    gpus,
    totalVramGb,
    cpuSpeedCapGb,
    effectiveCapacityGb,
  };
}

// ============================================================
// Hardware info endpoint (authenticated)
// Returns system RAM + GPU VRAM. When remoteGpuUrl is set, fetches from the
// remote GPU stats server (the machine actually doing compute) instead of this one.
// ============================================================
app.get("/api/hardware", requireAuth, async (req, res) => {
  if (remoteGpuUrl) {
    try {
      const response = await fetch(`${remoteGpuUrl}/api/hardware`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      return res.json(data);
    } catch (err) {
      return res.status(502).json({
        ok: false,
        error: `Cannot reach remote GPU stats server: ${err.message}`,
      });
    }
  }

  res.json(await getLocalHardwareInfo());
});

// ============================================================
// Machines (server/backends.js): status and the persisted choice
// ============================================================
app.get("/api/machines", requireAuth, (req, res) => {
  res.set("Cache-Control", "no-store");
  res.json(machinesSnapshot());
});

// PUT /api/machines/selected { id } — where chat and images run from now on.
// Only routes new requests; never loads or unloads a model anywhere.
app.put("/api/machines/selected", requireAuth, async (req, res) => {
  try {
    const machine = selectMachine(String(req.body?.id || ""));
    console.log(`Machine selected: ${machine.name}`);
    await probeMachine(machine);
    res.json(machinesSnapshot());
  } catch (err) {
    res.status(err.status || 500).json({ error: err.message });
  }
});

/** One probe per service, for startMachineMonitor. Each resolves { ok, error, ... }. */
const machineProbes = {
  async llama(m, timeout) {
    let r;
    try {
      r = await llamaFetch(m, "/models", { signal: AbortSignal.timeout(timeout) });
    } catch (err) {
      return { ok: false, error: networkErrorText(err) };
    }
    await r.body?.cancel().catch(() => {});
    if (r.ok) return { ok: true, error: null };
    return { ok: false, error: r.status === 401 ? `API key rejected (${keyHint(m)})` : `HTTP ${r.status}` };
  },
  async sd(m, timeout) {
    const st = await sdStatus(m, { timeout });
    return { ok: true, error: null, state: st.state || null };
  },
  async fetch(m, timeout) {
    const cfg = await helperConfigured(m);
    if (!cfg.configured) return { ok: null, error: cfg.reason };
    const h = await fetchHelper(m, "/v1/health", { timeout });
    return { ok: true, error: null, busy: !!h.busy, version: h.version || null };
  },
};

// ============================================================
// Setup wizard endpoints
// /api/setup/status is unauthenticated (wizard checks before auth is known)
// all other /api/setup/* routes require auth
// ============================================================
const SETUP_FILE = path.join(STORAGE_DIR, "setup_complete");
app.get("/api/setup/status", async (req, res) => {
  try {
    await fs.access(SETUP_FILE);
    res.json({ complete: true });
  } catch {
    res.json({ complete: false });
  }
});
app.use("/api/setup", requireAuth, setupRouter);

// ============================================================
// SQLite-backed API endpoints (new)
// ============================================================
app.use("/api/conversations", requireAuth, conversationsRouter);
app.use("/api", requireAuth, messagesRouter);
// Server-side send, reattach and cancel (server/runs.js).
app.use("/api", requireAuth, runsRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/search", requireAuth, searchRouter);
app.use("/api/backup", requireAuth, backupRouter);
app.use("/api/export", requireAuth, exportRouter);
app.use("/api/images", requireAuth, imagesRouter);
// Routes that use (or would autoload) a chat model get 409 while an image job
// owns the GPU; see chatGate in server/sd.js.
app.post("/openai/v1/chat/completions", requireAuth, chatGate("openai"));
app.post("/api/llama/models/load", requireAuth, chatGate());
// OpenAI-compatible model server (llama.cpp router on the routed machine).
// Authenticated streaming passthrough; the browser never talks to it directly.
app.use("/openai/v1", requireAuth, openaiRouter);
// Per-machine reads, installs and deletes (Models page columns, System page).
const llamaTargets = machineFromQuery([
  ["GET", "/models"],
  ["GET", "/events"],
  ["POST", "/models"],
  ["DELETE", "/models"],
]);
app.use("/api/llama", requireAuth, llamaTargets, routeTo("chat"), llamaRouter);

// SPA fallback: client-side routes get index.html. Backend prefixes are
// excluded so an unknown API path still 404s rather than returning the app, and
// only browser navigations (Accept: text/html) are rewritten.
if (hasDist) {
  app.get("*", (req, res, next) => {
    const isBackend = BACKEND_PREFIXES.some(
      (p) => req.path === p || req.path.startsWith(p + "/")
    );
    if (isBackend || !req.accepts("html")) return next();
    res.set("Cache-Control", "no-cache");
    res.sendFile(DIST_INDEX);
  });
}

// Errors nothing else handled (malformed JSON body, a database constraint,
// ...) answer JSON like every other API error, never Express's HTML page.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  const status = err.status || err.statusCode || 500;
  if (status >= 500) console.error(`${req.method} ${req.path} failed:`, err);
  if (res.headersSent) return res.end();
  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.expose !== false && err.message ? err.message : "Bad request",
  });
});

// ============================================================
// Startup
// ============================================================
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

await ensureStorageDir();
await getOrCreateToken();
auth = createAuth({ serverToken: authToken, sessionSecret: readOrCreateSecret(SESSION_SECRET_FILE) });
await loadGpuConfig();

await loadSdConfig();
startMachineMonitor(machineProbes);

// Initialize database and run migration if needed
console.log("Initializing database...");
getDb();

const migrationResult = await checkAndMigrate({ dryRun });
pruneUnusedDevices();

// Runs and image jobs the last process left running were cut off: store the
// partial replies as "interrupted" and mark the jobs interrupted, before any
// request can see them as running.
if (!dryRun) {
  recoverInterruptedRuns();
  for (const row of recoverInterruptedJobs()) {
    const machine = getMachine(row.machine_id);
    if (machine) cleanUpInterruptedJob(machine, row); // background: frees that GPU
  }
}
if (migrationResult.log.length > 0 && migrationResult.migrated) {
  console.log("Migration completed successfully");
}

if (dryRun && migrationResult.dryRun) {
  console.log("Dry run complete. Exiting.");
  closeDb();
  process.exit(0);
}

// Graceful shutdown
// Write running runs' partial replies and jobs' state first, so the next
// start recovers as much as possible.
function flushWork() {
  try {
    flushRuns();
    flushJobs();
  } catch (err) {
    console.error("Couldn't save running work:", err.message);
  }
}

process.on("SIGTERM", () => {
  console.log("Shutting down...");
  flushWork();
  stopNvidiaSmiLoop();
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  flushWork();
  stopNvidiaSmiLoop();
  closeDb();
  process.exit(0);
});

app.listen(PORT, HOST, () => {
  console.log(`Storage server running on http://${HOST}:${PORT}`);
  console.log(
    hasDist
      ? `Serving frontend build from ${DIST_DIR}`
      : `No frontend build at ${DIST_DIR} (run \`npm run build\`); API only`
  );
  console.log(`Data directory: ${STORAGE_DIR}`);
  for (const m of listMachines()) {
    console.log(`Machine ${m.name}${m.isDefault ? " (default)" : ""}: router ${m.openaiUrl}`);
  }
  console.log(`Selected machine: ${resolveMachine("chat").machine.name}`);
});
