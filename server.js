import express from "express";
import cors from "cors";
import fs from "fs/promises";
import path from "path";
import os from "os";

const app = express();
const PORT = 3001;

// Storage directory: ~/.llmui
const STORAGE_DIR = path.join(os.homedir(), ".llmui");

app.use(cors());
app.use(express.json({ limit: "50mb" }));

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
app.get("/storage/:key", async (req, res) => {
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
app.put("/storage/:key", async (req, res) => {
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
app.delete("/storage/:key", async (req, res) => {
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
      "GET /health": "Health check"
    }
  });
});

// Health check
app.get("/health", (req, res) => {
  res.json({ status: "ok", storageDir: STORAGE_DIR });
});

await ensureStorageDir();
app.listen(PORT, () => {
  console.log(`Storage server running on http://localhost:${PORT}`);
  console.log(`Data directory: ${STORAGE_DIR}`);
});
