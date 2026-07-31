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
    proxy: Object.fromEntries(
      // Forward all backend routes to the Express server on 3001.
      // This lets remote clients (Tailscale, LAN) use relative URLs without
      // CORS issues, and keeps Express safely bound to localhost only.
      ["/api", "/ollama", "/comfyui", "/storage", "/auth", "/health"].map(
        (path) => [
          path,
          {
            target: "http://localhost:3001",
            changeOrigin: true,
            // changeOrigin only rewrites Host. The browser's Origin header
            // (e.g. http://box.tailde6c83.ts.net:3000) would otherwise be
            // forwarded and rejected by the Express CORS allowlist. From the
            // browser's point of view this is a same-origin request, so drop
            // the header and let Express treat it as a server-to-server call.
            configure: (proxy) => {
              proxy.on("proxyReq", (proxyReq) => {
                proxyReq.removeHeader("origin");
              });
            },
          },
        ]
      )
    ),
  },
});
