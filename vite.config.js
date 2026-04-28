import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tokenPlugin from "./config/vite-token-plugin.js";

export default defineConfig({
  plugins: [react(), tokenPlugin()],
  server: {
    port: 3000,
    // NOTE: No proxy to Ollama. All Ollama API calls go through the
    // authenticated Express server on port 3001 (/ollama/*, /api/gpu).
    // The /api/llmui-token endpoint is served by a Vite plugin (middleware).
  },
});
