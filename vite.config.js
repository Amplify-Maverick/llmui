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
      },
    },
  },
});
