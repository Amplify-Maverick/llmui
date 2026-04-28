import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import gpuStatsPlugin from "./config/vite-gpu-plugin.js";

export default defineConfig({
  plugins: [react(), gpuStatsPlugin()],
  server: {
    port: 3000,
    proxy: {
      "/api": {
        target: "http://localhost:11434",
        changeOrigin: true,
        configure: (proxy) => {
          // Block dangerous endpoints - require authentication via Express server
          proxy.on("proxyReq", (proxyReq, req, res) => {
            const blockedPaths = ["/api/pull", "/api/delete"];
            if (blockedPaths.some((p) => req.url.startsWith(p))) {
              res.writeHead(403, { "Content-Type": "application/json" });
              res.end(
                JSON.stringify({
                  error:
                    "This endpoint requires authentication. Use /ollama/pull or /ollama/delete on port 3001.",
                })
              );
              proxyReq.destroy();
            }
          });
        },
      },
    },
  },
});
