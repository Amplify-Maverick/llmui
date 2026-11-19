import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tokenPlugin from "./config/vite-token-plugin.js";

export default defineConfig({
  plugins: [react(), tokenPlugin()],
  server: {
    port: 3000,
    // Loopback only — remote (Tailscale) clients come in through nginx
    // (deploy/llmui.nginx), which proxies to 127.0.0.1:3000.
    host: "127.0.0.1",
    allowedHosts: ["box.tailde6c83.ts.net"],
    // No direct proxy to any model server. Model calls go through the
    // authenticated Express server on port 3001 (/openai/v1/*, /api/chat-with-tools,
    // see server/openai.js), as do GPU stats (/api/gpu).
    // The /api/llmui-token endpoint is served by a Vite plugin (middleware).
    proxy: Object.fromEntries(
      // Forward all backend routes to the Express server on 3001.
      // This lets remote clients use relative URLs without CORS issues.
      ["/api", "/openai", "/comfyui", "/storage", "/auth", "/health"].map(
        (path) => [
          path,
          {
            target: "http://127.0.0.1:3001",
            changeOrigin: true,
            // changeOrigin only rewrites Host. The browser's Origin header
            // (e.g. https://box.tailde6c83.ts.net:8446) would otherwise be
            // forwarded and rejected by the Express CORS allowlist. From the
            // browser's point of view this is a same-origin request, so drop
            // the header and let Express treat it as a server-to-server call.
            configure: (proxy) => {
              proxy.on("proxyReq", (proxyReq, _req, res) => {
                proxyReq.removeHeader("origin");
                // If the browser disconnects before the backend has started
                // responding (e.g. Stop while the model is still processing
                // the prompt), http-proxy doesn't always notice. Tear down the
                // backend request so Express aborts the upstream generation.
                res.on("close", () => {
                  if (!res.writableFinished) proxyReq.destroy();
                });
              });
            },
          },
        ]
      )
    ),
  },
});
