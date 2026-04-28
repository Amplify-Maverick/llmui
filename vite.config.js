import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import gpuStatsPlugin from "./config/vite-gpu-plugin.js";
import tokenPlugin from "./config/vite-token-plugin.js";

export default defineConfig({
  plugins: [react(), gpuStatsPlugin(), tokenPlugin()],
  server: {
    port: 3000,
    // NOTE: No proxy to Ollama. All Ollama API calls go through the
    // authenticated Express server on port 3001 (/ollama/*).
    // The /api/gpu and /api/llmui-token endpoints are served by Vite
    // plugins (middleware), not proxied.
  },
});
