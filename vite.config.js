import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tokenPlugin from "./config/vite-token-plugin.js";

export default defineConfig({
  plugins: [react(), tokenPlugin()],
  server: {
    port: 3000,
    host: true, // bind to 0.0.0.0 so Tailscale clients can reach the dev server
    allowedHosts: ["box.tailde6c83.ts.net"],
    // NOTE: No proxy to Ollama. All Ollama API calls go through the
    // authenticated Express server on port 3001 (/ollama/*, /api/gpu).
    // The /api/llmui-token endpoint is served by a Vite plugin (middleware).
    proxy: {
      // Forward all backend routes to the Express server on 3001.
      // This lets remote clients (Tailscale, LAN) use relative URLs without
      // CORS issues, and keeps Express safely bound to localhost only.
      "/api": { target: "http://localhost:3001", changeOrigin: true },
      "/ollama": { target: "http://localhost:3001", changeOrigin: true },
      "/comfyui": { target: "http://localhost:3001", changeOrigin: true },
      "/storage": { target: "http://localhost:3001", changeOrigin: true },
      "/auth": { target: "http://localhost:3001", changeOrigin: true },
      "/health": { target: "http://localhost:3001", changeOrigin: true },
    },
  },
});
