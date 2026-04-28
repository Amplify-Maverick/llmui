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

let authToken = null;

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
    return res.status(401).json({ error: "Missing authorization header" });
  }
  const token = authHeader.slice(7);
  if (token !== authToken) {
    return res.status(403).json({ error: "Invalid token" });
  }
  next();
}

app.use(cors());
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

// Root route
app.get("/", (req, res) => {
  res.json({
    name: "LLMUI Storage Server",
    status: "running",
    storageDir: STORAGE_DIR,
    endpoints: {
      "GET /storage/:key": "Load data",
      "PUT /storage/:key": "Save data",
      "DELETE /storage/:key": "Remove data",
      "POST /ollama/pull": "Pull model (authenticated)",
      "DELETE /ollama/delete": "Delete model (authenticated)",
      "GET /health": "Health check",
    },
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", storageDir: STORAGE_DIR });
});

// Authenticated Ollama proxy endpoints for dangerous operations
const OLLAMA_URL = process.env.OLLAMA_URL || "http://localhost:11434";

// POST /ollama/pull - Pull a model (authenticated, streaming)
app.post("/ollama/pull", requireAuth, async (req, res) => {
  try {
    const response = await fetch(`${OLLAMA_URL}/api/pull`, {
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
    const response = await fetch(`${OLLAMA_URL}/api/delete`, {
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
app.listen(PORT, () => {
  console.log(`Storage server running on http://localhost:${PORT}`);
  console.log(`Data directory: ${STORAGE_DIR}`);
});
