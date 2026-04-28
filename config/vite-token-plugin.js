import fs from "fs";
import path from "path";
import os from "os";

/**
 * Vite plugin that exposes a /api/llmui-token endpoint returning the auth token.
 *
 * Token delivery approach: Option A (endpoint-based)
 * - Reads ~/.llmui/token server-side and exposes GET /api/llmui-token returning { token }
 * - This endpoint is only reachable through Vite, which runs on the same machine as the user
 * - LAN clients fetch the token through Vite's dev server, which reads it from disk
 *
 * Why this approach vs injecting into index.html (Option B):
 * - Cleaner separation: token is fetched on-demand, not embedded in HTML
 * - Easier to debug: can curl the endpoint to verify token delivery
 * - Consistent with existing pattern used by the app
 *
 * PRODUCTION NOTE: This plugin only runs during Vite dev/preview mode.
 * For production deployment (serving dist/ after vite build), you'll need
 * a different token delivery mechanism, such as:
 * - Serving dist/ from the same Express server that has the token
 * - Having that server inject the token into index.html at serve time
 * - Or using a reverse proxy that injects the token header
 */
export default function tokenPlugin() {
  const tokenPath = path.join(os.homedir(), ".llmui", "token");

  return {
    name: "llmui-token",
    configureServer(server) {
      server.middlewares.use("/api/llmui-token", (_req, res) => {
        res.setHeader("Content-Type", "application/json");
        res.setHeader("Cache-Control", "no-store");

        try {
          const token = fs.readFileSync(tokenPath, "utf-8").trim();
          res.end(JSON.stringify({ token }));
        } catch (err) {
          if (err.code === "ENOENT") {
            res.statusCode = 503;
            res.end(
              JSON.stringify({
                error: "Token not found",
                message:
                  "Storage server may not have started yet. Ensure server/index.js is running.",
              })
            );
          } else {
            res.statusCode = 500;
            res.end(
              JSON.stringify({
                error: "Failed to read token",
                message: err.message,
              })
            );
          }
        }
      });
    },
  };
}
