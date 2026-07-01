import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import crypto from "crypto";
import { execFile, spawn } from "child_process";
import { promisify } from "util";
import fs from "fs/promises";
import path from "path";
import os from "os";
import { nanoid } from "nanoid";
import { getToolsSchema, executeTool } from "./tools/index.js";

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

const execFileAsync = promisify(execFile);

const app = express();
const PORT = 3001;

// Storage directory: ~/.llmui
const STORAGE_DIR = path.join(os.homedir(), ".llmui");
const TOKEN_FILE = path.join(STORAGE_DIR, "token");
const OLLAMA_CONFIG_FILE = path.join(STORAGE_DIR, "ollama_config.json");

let authToken = null;

// Default Ollama URL, overridable by env var or persisted config
const DEFAULT_OLLAMA_URL = "http://localhost:11434";
let ollamaUrl = process.env.OLLAMA_URL || DEFAULT_OLLAMA_URL;

// Optional remote GPU stats server URL (e.g. http://workstation-tailscale-ip:3002)
// When set, /api/gpu and /api/hardware proxy to this server instead of running nvidia-smi locally.
let remoteGpuUrl = process.env.REMOTE_GPU_URL || null;

// Remote Ollama server (GPU box). When set, the UI can toggle between local and remote.
let remoteOllamaUrl = process.env.REMOTE_OLLAMA_URL || null;
// 'local' | 'remote' — tracks which preset is active; null means manually set URL
let activeTarget = null;

async function loadOllamaConfig() {
  try {
    const data = await fs.readFile(OLLAMA_CONFIG_FILE, "utf-8");
    const config = JSON.parse(data);
    if (config.ollamaUrl) ollamaUrl = config.ollamaUrl;
    if (config.remoteGpuUrl) remoteGpuUrl = config.remoteGpuUrl;
    if (config.remoteOllamaUrl) remoteOllamaUrl = config.remoteOllamaUrl;
    if (config.activeTarget) activeTarget = config.activeTarget;
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Error loading Ollama config:", err);
    }
  }
}

async function saveOllamaConfig() {
  await ensureStorageDir();
  const config = { ollamaUrl };
  if (remoteGpuUrl) config.remoteGpuUrl = remoteGpuUrl;
  if (remoteOllamaUrl) config.remoteOllamaUrl = remoteOllamaUrl;
  if (activeTarget) config.activeTarget = activeTarget;
  await fs.writeFile(OLLAMA_CONFIG_FILE, JSON.stringify(config, null, 2));
}

/**
 * Rate how well a model (by its on-disk size) fits this machine's detected
 * capacity (hardware.effectiveCapacityGb — GPU VRAM if present, else real
 * available RAM capped for CPU inference speed; see getLocalHardwareInfo).
 * A model's disk size is a close proxy for the RAM/VRAM it needs to load,
 * plus headroom for context and runtime overhead — so this scales with real
 * hardware instead of fixed absolute thresholds that are wrong on both very
 * small and very large boxes.
 */
function getModelFeasibility(sizeBytes, hardware) {
  const GB = 1024 ** 3;
  const requiredGb = (sizeBytes / GB) * 1.2;

  const capacityGb = hardware?.effectiveCapacityGb;

  if (!capacityGb) {
    // Hardware unknown — fall back to the old conservative absolute bands.
    if (sizeBytes < 4 * GB) return "good";
    if (sizeBytes < 8 * GB) return "slow";
    return "poor";
  }

  const ratio = capacityGb / requiredGb;
  if (ratio >= 1.3) return "good";
  if (ratio >= 0.9) return "slow";
  return "poor";
}

function validateOllamaUrl(url) {
  try {
    const parsed = new URL(url);
    if (!["http:", "https:"].includes(parsed.protocol)) {
      return { valid: false, error: "URL must use http or https protocol" };
    }
    return { valid: true };
  } catch {
    return { valid: false, error: "Invalid URL format" };
  }
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

function isLocalhost(req) {
  const ip = req.ip || req.connection.remoteAddress;
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  const token = authHeader.slice(7);

  // Use timing-safe comparison to prevent timing attacks
  // timingSafeEqual throws on length mismatch, so check length first
  const tokenBuffer = Buffer.from(token);
  const authTokenBuffer = Buffer.from(authToken);
  if (
    tokenBuffer.length !== authTokenBuffer.length ||
    !crypto.timingSafeEqual(tokenBuffer, authTokenBuffer)
  ) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

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
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
    allowedHeaders: ["Content-Type", "Authorization"],
    methods: ["GET", "PUT", "POST", "DELETE", "OPTIONS"],
  })
);
app.use(express.json({ limit: "5mb" }));
app.set("trust proxy", false);

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

app.use(globalLimiter);

// Token endpoint - only serves to localhost
app.get("/auth/token", (req, res) => {
  if (!isLocalhost(req)) {
    return res.status(403).json({ error: "Token only available from localhost" });
  }
  res.json({ token: authToken });
});

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

// Root route - no sensitive info exposed
app.get("/", (req, res) => {
  res.json({
    name: "LLMUI Storage Server",
    status: "running",
  });
});

// Health check - unauthenticated, used by start script
app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

// ============================================================
// Authenticated Ollama proxy endpoints
// All Ollama access goes through these endpoints to prevent
// unauthenticated LAN users from accessing Ollama resources.
// ============================================================

// GET /ollama/config - Get current Ollama URL and server target config
app.get("/ollama/config", requireAuth, (req, res) => {
  res.json({ ollamaUrl, remoteOllamaUrl, activeTarget });
});

// PUT /ollama/config - Update Ollama URL and/or remote URL
app.put("/ollama/config", requireAuth, async (req, res) => {
  const { ollamaUrl: newUrl, remoteOllamaUrl: newRemoteUrl } = req.body;

  if (newUrl) {
    const { valid, error } = validateOllamaUrl(newUrl);
    if (!valid) return res.status(400).json({ error });
    ollamaUrl = newUrl;
    // If the URL is changed manually, clear the active target preset
    activeTarget = null;
  }

  if (newRemoteUrl !== undefined) {
    if (newRemoteUrl) {
      const { valid, error } = validateOllamaUrl(newRemoteUrl);
      if (!valid) return res.status(400).json({ error });
      remoteOllamaUrl = newRemoteUrl;
    } else {
      remoteOllamaUrl = null;
    }
  }

  if (!newUrl && newRemoteUrl === undefined) {
    return res.status(400).json({ error: "ollamaUrl or remoteOllamaUrl is required" });
  }

  try {
    await saveOllamaConfig();
    res.json({ success: true, ollamaUrl, remoteOllamaUrl, activeTarget });
  } catch (err) {
    console.error("Error saving Ollama config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// PUT /ollama/switch - Toggle between local and remote GPU server
app.put("/ollama/switch", requireAuth, async (req, res) => {
  const { target } = req.body;
  if (!["local", "remote"].includes(target)) {
    return res.status(400).json({ error: "target must be 'local' or 'remote'" });
  }
  if (target === "remote" && !remoteOllamaUrl) {
    return res.status(400).json({ error: "No remote Ollama URL configured. Set remoteOllamaUrl in Settings first." });
  }

  activeTarget = target;
  ollamaUrl = target === "local" ? DEFAULT_OLLAMA_URL : remoteOllamaUrl;

  try {
    await saveOllamaConfig();
    res.json({ success: true, ollamaUrl, activeTarget });
  } catch (err) {
    console.error("Error saving switch config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ollama/local-capability - Check which models on local Ollama can run,
// rated against this machine's actually detected RAM/VRAM (not just model size).
app.get("/ollama/local-capability", requireAuth, async (req, res) => {
  try {
    const [response, hardware] = await Promise.all([
      fetch(`${DEFAULT_OLLAMA_URL}/api/tags`, { signal: AbortSignal.timeout(5000) }),
      getLocalHardwareInfo(),
    ]);
    if (!response.ok) {
      return res.status(502).json({ error: "Local Ollama not reachable" });
    }
    const data = await response.json();
    const models = (data.models || []).map((model) => ({
      ...model,
      cpuFeasibility: getModelFeasibility(model.size || 0, hardware),
    }));
    res.json({ models, hardware });
  } catch {
    res.status(502).json({ error: "Failed to connect to local Ollama" });
  }
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
    await saveOllamaConfig();
    res.json({ ok: true, remoteGpuUrl });
  } catch (err) {
    console.error("Error saving GPU config:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET /ollama/tags - List models
app.get("/ollama/tags", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error proxying tags request:", err);
    res.status(502).json({ error: "Failed to connect to Ollama" });
  }
});

// GET /ollama/ps - List running models
app.get("/ollama/ps", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/ps`);
    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error proxying ps request:", err);
    res.status(502).json({ error: "Failed to connect to Ollama" });
  }
});

// POST /ollama/show - Show model info
app.post("/ollama/show", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/show`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });
    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error("Error proxying show request:", err);
    res.status(502).json({ error: "Failed to connect to Ollama" });
  }
});

// POST /ollama/chat - Chat with streaming (authenticated)
app.post("/ollama/chat", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    // Stream the response back
    res.setHeader("Content-Type", "application/x-ndjson");
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(Buffer.from(value));
      }
    };
    await pump();
  } catch (err) {
    console.error("Error proxying chat request:", err);
    res.status(502).json({ error: "Failed to connect to Ollama" });
  }
});

// POST /ollama/chat-with-tools - Chat with tool calling support (authenticated, streaming)
//
// Manual test for abort handling:
// 1. Start a chat that triggers a slow tool (e.g., web_search or fetch_url with a slow endpoint)
// 2. Close the browser tab while the tool is executing
// 3. Check server logs - you should see "chat-with-tools aborted: client disconnected"
//    instead of the tool result being logged/processed
const MAX_TOOL_ITERATIONS = 5;

app.post("/ollama/chat-with-tools", requireAuth, async (req, res) => {
  const { model, messages, options = {}, enabledTools = null } = req.body;

  if (!model) {
    return res.status(400).json({ error: "Model is required" });
  }

  // Create abort controller for cancellation on client disconnect
  const controller = new AbortController();
  const { signal } = controller;

  // Abort all pending operations when client disconnects
  req.on("close", () => {
    if (!res.writableEnded) {
      controller.abort();
    }
  });

  // Get tools schema for enabled tools
  const tools = getToolsSchema(enabledTools);

  res.setHeader("Content-Type", "application/x-ndjson");

  let currentMessages = [...messages];
  let iterations = 0;

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
      // Check if aborted before starting new iteration
      if (signal.aborted) {
        throw new DOMException("Request aborted", "AbortError");
      }

      iterations++;

      // Call Ollama with tools
      const response = await fetch(`${ollamaUrl}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: currentMessages,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          options: options.modelOptions || {},
        }),
        signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        res.write(JSON.stringify({ type: "error", error: errorText }) + "\n");
        res.end();
        return;
      }

      // Stream and collect the response
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let assistantContent = "";
      let toolCalls = [];
      let buffer = "";

      try {
        while (true) {
          // Check abort before each read
          if (signal.aborted) {
            reader.cancel();
            throw new DOMException("Request aborted", "AbortError");
          }

          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || ""; // Keep incomplete line in buffer

          for (const line of lines) {
            if (!line.trim()) continue;

            try {
              const parsed = JSON.parse(line);

              // Stream content to client
              if (parsed.message?.content) {
                assistantContent += parsed.message.content;
                res.write(JSON.stringify({ type: "content", content: parsed.message.content }) + "\n");
              }

              // Collect tool calls from the final message
              if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
                toolCalls = parsed.message.tool_calls;
              }

              if (parsed.done) {
                break;
              }
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      } finally {
        // Ensure reader is released even on abort
        try {
          reader.releaseLock();
        } catch {
          // Reader may already be released
        }
      }

      // Process remaining buffer
      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer);
          if (parsed.message?.content) {
            assistantContent += parsed.message.content;
            res.write(JSON.stringify({ type: "content", content: parsed.message.content }) + "\n");
          }
          if (parsed.message?.tool_calls && parsed.message.tool_calls.length > 0) {
            toolCalls = parsed.message.tool_calls;
          }
        } catch {
          // Skip malformed JSON
        }
      }

      // If no tool calls, we're done
      if (toolCalls.length === 0) {
        res.write(JSON.stringify({ type: "done", iterations }) + "\n");
        res.end();
        return;
      }

      // Add assistant message with tool calls to history
      currentMessages.push({
        role: "assistant",
        content: assistantContent,
        tool_calls: toolCalls,
      });

      // Execute each tool and emit results
      for (const toolCall of toolCalls) {
        // Check if aborted before executing each tool
        if (signal.aborted) {
          throw new DOMException("Request aborted", "AbortError");
        }

        const { function: fn } = toolCall;
        const toolId = toolCall.id || nanoid();
        const toolName = fn.name;
        let toolArgs = fn.arguments;

        // Parse arguments if they're a string
        if (typeof toolArgs === "string") {
          try {
            toolArgs = JSON.parse(toolArgs);
          } catch {
            toolArgs = {};
          }
        }

        // Emit tool call event
        res.write(JSON.stringify({
          type: "tool_call",
          id: toolId,
          name: toolName,
          arguments: toolArgs,
        }) + "\n");

        // Execute tool
        const result = await executeTool(toolName, toolArgs);

        // Check if aborted after tool execution (before emitting result)
        if (signal.aborted) {
          throw new DOMException("Request aborted", "AbortError");
        }

        // Emit tool result
        res.write(JSON.stringify({
          type: "tool_result",
          id: toolId,
          name: toolName,
          result: result.success ? result.result : null,
          error: result.success ? null : result.error,
        }) + "\n");

        // Add tool result to messages (Ollama expects role: "tool")
        currentMessages.push({
          role: "tool",
          content: JSON.stringify(result.success ? result.result : { error: result.error }),
        });
      }

      // Continue loop - model will generate new response with tool results
    }

    // Max iterations reached
    res.write(JSON.stringify({ type: "error", error: "Max tool iterations reached" }) + "\n");
    res.end();
  } catch (err) {
    // Handle abort gracefully - don't treat as crash
    if (err.name === "AbortError") {
      console.log("chat-with-tools aborted: client disconnected");
      // Response already closed by client, just clean up and return
      if (!res.writableEnded) {
        res.end();
      }
      return;
    }

    console.error("Error in chat-with-tools:", err);
    if (!res.writableEnded) {
      res.write(JSON.stringify({ type: "error", error: err.message || "Tool execution failed" }) + "\n");
      res.end();
    }
  }
});

// POST /ollama/pull - Pull a model (authenticated, streaming)
app.post("/ollama/pull", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/pull`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    // Stream the response back
    res.setHeader("Content-Type", "application/x-ndjson");
    const reader = response.body.getReader();
    const pump = async () => {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          res.end();
          break;
        }
        res.write(Buffer.from(value));
      }
    };
    await pump();
  } catch (err) {
    console.error("Error proxying pull request:", err);
    res.status(502).json({ error: "Failed to connect to Ollama" });
  }
});

// POST /ollama/unload - Unload a model from VRAM (authenticated)
app.post("/ollama/unload", requireAuth, async (req, res) => {
  const { name } = req.body;
  if (!name) {
    return res.status(400).json({ error: "Model name is required" });
  }

  try {
    // Ollama unloads a model when you send a generate request with keep_alive=0
    const response = await fetch(`${ollamaUrl}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: name, keep_alive: 0 }),
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error unloading model:", err);
    res.status(502).json({ error: "Failed to unload model" });
  }
});

// DELETE /ollama/delete - Delete a model (authenticated)
app.delete("/ollama/delete", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${ollamaUrl}/api/delete`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req.body),
    });

    if (!response.ok) {
      const error = await response.text();
      return res.status(response.status).send(error);
    }

    res.json({ success: true });
  } catch (err) {
    console.error("Error proxying delete request:", err);
    res.status(502).json({ error: "Failed to connect to Ollama" });
  }
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
// on every poll (GpuMini/GpuStats poll /api/gpu every 2s) on GPU-less machines.
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

app.get("/api/gpu", requireAuth, async (req, res) => {
  // Proxy to remote GPU stats server if configured — but not when the
  // Local/Remote switcher has explicitly selected "local", so switching to
  // Local actually reports on this machine instead of a stale remote box.
  if (remoteGpuUrl && activeTarget !== "local") {
    try {
      const response = await fetch(`${remoteGpuUrl}/api/gpu`, {
        signal: AbortSignal.timeout(5000),
      });
      const data = await response.json();
      res.set("Cache-Control", "max-age=1");
      return res.json(data);
    } catch (err) {
      return res.status(502).json({
        ok: false,
        error: `Cannot reach remote GPU stats server: ${err.message}`,
      });
    }
  }

  // Start the persistent process on first request (lazy initialization)
  if (!nvidiaSmiProcess && !nvidiaSmiUnavailable) {
    startNvidiaSmiLoop();
    // Give it a moment to produce first output
    await new Promise((resolve) => setTimeout(resolve, 1100));
  }

  if (gpuCache.data) {
    res.set("Cache-Control", "max-age=1");
    return res.json(gpuCache.data);
  }

  // No data yet (nvidia-smi might not be available)
  res.status(500).json({
    ok: false,
    error: nvidiaSmiUnavailable ? "No NVIDIA GPU detected on this machine" : "nvidia-smi not available or no data yet",
  });
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
 * Detect this machine's CPU/RAM/GPU. Shared by /api/hardware (local case)
 * and /ollama/local-capability, so both use the same real numbers instead
 * of local-capability's previous size-only heuristic.
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
// Returns system RAM + GPU VRAM. When remoteGpuUrl is set AND the switcher
// isn't pinned to "local", fetches from the remote GPU stats server (the
// machine actually doing compute) instead of this one.
// ============================================================
app.get("/api/hardware", requireAuth, async (req, res) => {
  if (remoteGpuUrl && activeTarget !== "local") {
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
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/search", requireAuth, searchRouter);
app.use("/api/backup", requireAuth, backupRouter);
app.use("/api/export", requireAuth, exportRouter);

// ============================================================
// Startup
// ============================================================
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");

await ensureStorageDir();
await getOrCreateToken();
await loadOllamaConfig();

// Initialize database and run migration if needed
console.log("Initializing database...");
getDb();

const migrationResult = await checkAndMigrate({ dryRun });
if (migrationResult.log.length > 0 && migrationResult.migrated) {
  console.log("Migration completed successfully");
}

if (dryRun && migrationResult.dryRun) {
  console.log("Dry run complete. Exiting.");
  closeDb();
  process.exit(0);
}

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Shutting down...");
  stopNvidiaSmiLoop();
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  stopNvidiaSmiLoop();
  closeDb();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Storage server running on http://localhost:${PORT}`);
  console.log(`Data directory: ${STORAGE_DIR}`);
  console.log(`Ollama URL: ${ollamaUrl}`);
});
