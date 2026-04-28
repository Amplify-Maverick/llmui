import express from "express";
import cors from "cors";
import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import os from "os";

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
app.use(express.json({ limit: "50mb" }));
app.set("trust proxy", false);

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
      res.status(500).json({ error: err.message });
    }
  }
});

// PUT /storage/:key - Save data
app.put("/storage/:key", requireAuth, async (req, res) => {
  try {
    await ensureStorageDir();
    const filePath = getFilePath(req.params.key);
    await fs.writeFile(filePath, JSON.stringify(req.body.data, null, 2));
    res.json({ success: true });
  } catch (err) {
    console.error(`Error saving ${req.params.key}:`, err);
    res.status(500).json({ error: err.message });
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
      res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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
    res.status(502).json({ error: `Failed to connect to Ollama at ${ollamaUrl}: ${err.message}` });
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
    res.status(502).json({ error: `Failed to connect to Ollama at ${ollamaUrl}: ${err.message}` });
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
    res.status(502).json({ error: `Failed to connect to Ollama at ${ollamaUrl}: ${err.message}` });
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
    res.status(502).json({ error: `Failed to connect to Ollama at ${ollamaUrl}: ${err.message}` });
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
  }
});

await ensureStorageDir();
await getOrCreateToken();
await loadOllamaConfig();
app.listen(PORT, () => {
  console.log(`Storage server running on http://localhost:${PORT}`);
  console.log(`Data directory: ${STORAGE_DIR}`);
  console.log(`Ollama URL: ${ollamaUrl}`);
});
