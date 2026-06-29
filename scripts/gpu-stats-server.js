#!/usr/bin/env node
/**
 * LLMUI GPU Stats Server
 *
 * Lightweight standalone HTTP server that exposes nvidia-smi data over HTTP.
 * Run this on your GPU workstation so a remote LLMUI instance can read stats.
 *
 * Usage:
 *   node scripts/gpu-stats-server.js
 *   GPU_STATS_PORT=3002 node scripts/gpu-stats-server.js
 *
 * Then in LLMUI settings (or via REMOTE_GPU_URL env var on the services box):
 *   http://<workstation-tailscale-ip>:3002
 *
 * No authentication — rely on Tailscale network trust.
 */

import http from "http";
import { spawn } from "child_process";
import os from "os";

const PORT = parseInt(process.env.GPU_STATS_PORT ?? "3002", 10);

// ─── nvidia-smi loop ─────────────────────────────────────────────────────────

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit,clocks.current.graphics,clocks.current.memory",
  "--format=csv,noheader,nounits",
  "--loop=1",
];

let gpuCache = { data: null, timestamp: 0 };
let nvidiaSmiProcess = null;
let nvidiaSmiBuffer = "";

function parseGpuLine(line) {
  const parts = line.split(",").map((s) => s.trim());
  if (parts.length < 11) return null;
  return {
    index: parseInt(parts[0], 10),
    name: parts[1],
    utilization: parseFloat(parts[2]),
    memoryUsed: parseFloat(parts[3]),
    memoryTotal: parseFloat(parts[4]),
    temperature: parseFloat(parts[5]),
    fanSpeed: parseFloat(parts[6]),
    powerDraw: parseFloat(parts[7]),
    powerLimit: parseFloat(parts[8]),
    clockGraphics: parseFloat(parts[9]),
    clockMemory: parseFloat(parts[10]),
  };
}

function startNvidiaSmiLoop() {
  if (nvidiaSmiProcess) return;

  try {
    nvidiaSmiProcess = spawn("nvidia-smi", NVIDIA_SMI_ARGS, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    nvidiaSmiProcess.stdout.on("data", (chunk) => {
      nvidiaSmiBuffer += chunk.toString();
      const lines = nvidiaSmiBuffer.split("\n");
      nvidiaSmiBuffer = lines.pop();

      const gpus = [];
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        const gpu = parseGpuLine(trimmed);
        if (gpu) gpus.push(gpu);
      }

      if (gpus.length > 0) {
        const now = Date.now();
        gpuCache = { data: { ok: true, gpus, timestamp: now }, timestamp: now };
      }
    });

    nvidiaSmiProcess.stderr.on("data", (chunk) => {
      console.error("nvidia-smi stderr:", chunk.toString().trim());
    });

    nvidiaSmiProcess.on("error", (err) => {
      console.error("nvidia-smi process error:", err.message);
      nvidiaSmiProcess = null;
    });

    nvidiaSmiProcess.on("exit", (code, signal) => {
      if (signal !== "SIGTERM" && signal !== "SIGINT") {
        console.error(`nvidia-smi exited (code=${code}, signal=${signal})`);
      }
      nvidiaSmiProcess = null;
    });

    console.log("Started nvidia-smi subprocess");
  } catch (err) {
    console.error("Failed to start nvidia-smi:", err.message);
  }
}

function stopNvidiaSmiLoop() {
  if (nvidiaSmiProcess) {
    nvidiaSmiProcess.kill("SIGTERM");
    nvidiaSmiProcess = null;
  }
}

// ─── HTTP server ──────────────────────────────────────────────────────────────

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

async function waitForFirstSample(ms = 1200) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const server = http.createServer(async (req, res) => {
  // CORS headers — allow any Tailscale origin
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  if (req.method !== "GET") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  if (req.url === "/health") {
    const gpuCount = gpuCache.data?.gpus?.length ?? 0;
    sendJson(res, 200, { ok: true, gpuCount, uptime: process.uptime() });
    return;
  }

  if (req.url === "/api/gpu") {
    if (!nvidiaSmiProcess) {
      startNvidiaSmiLoop();
      await waitForFirstSample();
    }

    if (gpuCache.data) {
      res.setHeader("Cache-Control", "max-age=1");
      sendJson(res, 200, gpuCache.data);
    } else {
      sendJson(res, 500, { ok: false, error: "nvidia-smi not available or no data yet" });
    }
    return;
  }

  if (req.url === "/api/hardware") {
    if (!nvidiaSmiProcess) {
      startNvidiaSmiLoop();
      await waitForFirstSample();
    }

    const totalRamBytes = os.totalmem();
    const freeRamBytes = os.freemem();
    const cpuModel = os.cpus()[0]?.model || "Unknown";
    const cpuCores = os.cpus().length;

    let gpus = [];
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

    const totalVramGb = gpus.length > 0
      ? +gpus.reduce((sum, g) => sum + g.vramTotalGb, 0).toFixed(1)
      : null;

    sendJson(res, 200, {
      ok: true,
      cpu: { model: cpuModel, cores: cpuCores },
      ram: {
        totalGb: +(totalRamBytes / 1024 ** 3).toFixed(1),
        freeGb: +(freeRamBytes / 1024 ** 3).toFixed(1),
      },
      gpus,
      totalVramGb,
    });
    return;
  }

  sendJson(res, 404, { error: "Not found" });
});

// ─── Start ────────────────────────────────────────────────────────────────────

startNvidiaSmiLoop();

server.listen(PORT, "0.0.0.0", () => {
  console.log(`GPU stats server listening on http://0.0.0.0:${PORT}`);
  console.log("Endpoints: /health  /api/gpu  /api/hardware");
});

process.on("SIGTERM", () => { stopNvidiaSmiLoop(); process.exit(0); });
process.on("SIGINT",  () => { stopNvidiaSmiLoop(); process.exit(0); });
