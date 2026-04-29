import express from "express";
import rateLimit from "express-rate-limit";
import cors from "cors";
import crypto from "crypto";
import { execFile } from "child_process";
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

async function loadOllamaConfig() {
  try {
    const data = await fs.readFile(OLLAMA_CONFIG_FILE, "utf-8");
    const config = JSON.parse(data);
    if (config.ollamaUrl) {
      ollamaUrl = config.ollamaUrl;
    }
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error("Error loading Ollama config:", err);
    }
    // Use default or env var
  }
}

async function saveOllamaConfig() {
  await ensureStorageDir();
  await fs.writeFile(
    OLLAMA_CONFIG_FILE,
    JSON.stringify({ ollamaUrl }, null, 2)
  );
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

// GET /ollama/config - Get current Ollama URL
app.get("/ollama/config", requireAuth, (req, res) => {
  res.json({ ollamaUrl });
});

// PUT /ollama/config - Update Ollama URL
app.put("/ollama/config", requireAuth, async (req, res) => {
  const { ollamaUrl: newUrl } = req.body;
  if (!newUrl) {
    return res.status(400).json({ error: "ollamaUrl is required" });
  }

  const { valid, error } = validateOllamaUrl(newUrl);
  if (!valid) {
    return res.status(400).json({ error });
  }

  ollamaUrl = newUrl;
  try {
    await saveOllamaConfig();
    res.json({ success: true, ollamaUrl });
  } catch (err) {
    console.error("Error saving Ollama config:", err);
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
const MAX_TOOL_ITERATIONS = 5;

app.post("/ollama/chat-with-tools", requireAuth, async (req, res) => {
  const { model, messages, options = {}, enabledTools = null } = req.body;

  if (!model) {
    return res.status(400).json({ error: "Model is required" });
  }

  // Get tools schema for enabled tools
  const tools = getToolsSchema(enabledTools);

  res.setHeader("Content-Type", "application/x-ndjson");

  let currentMessages = [...messages];
  let iterations = 0;

  try {
    while (iterations < MAX_TOOL_ITERATIONS) {
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

      while (true) {
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
    console.error("Error in chat-with-tools:", err);
    res.write(JSON.stringify({ type: "error", error: err.message || "Tool execution failed" }) + "\n");
    res.end();
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
// Uses execFile (no shell) + async to avoid blocking the event loop.
// Caches nvidia-smi output for 1 second — counters don't update faster.
// ============================================================

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit,clocks.current.graphics,clocks.current.memory",
  "--format=csv,noheader,nounits",
];

const GPU_CACHE_TTL_MS = 1000;
let gpuCache = { data: null, timestamp: 0 };

app.get("/api/gpu", requireAuth, async (req, res) => {
  const now = Date.now();

  // Return cached data if still fresh
  if (gpuCache.data && now - gpuCache.timestamp < GPU_CACHE_TTL_MS) {
    res.set("Cache-Control", "max-age=1");
    return res.json(gpuCache.data);
  }

  try {
    const { stdout } = await execFileAsync("nvidia-smi", NVIDIA_SMI_ARGS, {
      timeout: 3000,
    });

    const raw = stdout.trim();
    const gpus = raw.split("\n").map((line) => {
      const parts = line.split(",").map((s) => s.trim());
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
    });

    const response = { ok: true, gpus, timestamp: now };
    gpuCache = { data: response, timestamp: now };

    res.set("Cache-Control", "max-age=1");
    res.json(response);
  } catch (err) {
    console.error("GPU stats error:", err);
    res.status(500).json({
      ok: false,
      error: "nvidia-smi not available or failed",
    });
  }
});

// ============================================================
// SQLite-backed API endpoints (new)
// ============================================================
app.use("/api/conversations", requireAuth, conversationsRouter);
app.use("/api", requireAuth, messagesRouter);
app.use("/api/settings", requireAuth, settingsRouter);
app.use("/api/search", requireAuth, searchRouter);
app.use("/api/backup", requireAuth, backupRouter);

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
  closeDb();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log("Shutting down...");
  closeDb();
  process.exit(0);
});

app.listen(PORT, () => {
  console.log(`Storage server running on http://localhost:${PORT}`);
  console.log(`Data directory: ${STORAGE_DIR}`);
  console.log(`Ollama URL: ${ollamaUrl}`);
});
