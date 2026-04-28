import { execSync } from "child_process";

/**
 * Vite plugin that exposes a /api/gpu endpoint returning live NVIDIA GPU stats
 * via nvidia-smi. Falls back gracefully if nvidia-smi is not available.
 */
export default function gpuStatsPlugin() {
  return {
    name: "gpu-stats",
    configureServer(server) {
      server.middlewares.use("/api/gpu", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");

        try {
          const raw = execSync(
            'nvidia-smi --query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit,clocks.current.graphics,clocks.current.memory --format=csv,noheader,nounits',
            { timeout: 3000, encoding: "utf-8" }
          ).trim();

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

          res.end(JSON.stringify({ ok: true, gpus, timestamp: Date.now() }));
        } catch (err) {
          res.statusCode = 500;
          res.end(
            JSON.stringify({
              ok: false,
              error: "nvidia-smi not available or failed",
              message: err.message,
            })
          );
        }
      });
    },
  };
}
