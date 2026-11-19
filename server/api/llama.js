/**
 * llama.cpp router management, proxied with the server-side API key.
 * Mounted at /api/llama behind requireAuth; the browser never talks to the
 * model server directly.
 */

import express from "express";
import { llamaFetch, upstreamError } from "../llama.js";

const router = express.Router();

/** Normalise one entry of the router's GET /models list. */
export function normalizeModel(m) {
  return {
    id: m.id,
    status: m.status?.value || "unknown",
    failed: !!m.status?.failed,
    inCache: m.in_cache ?? null,
    memory: m.memory || null,
    contextLength: m.meta?.n_ctx || m.meta?.n_ctx_train || null,
    size: m.meta?.size || 0,
  };
}

// GET /api/llama/models — every model the router knows about, with status.
router.get("/models", async (req, res) => {
  try {
    const response = await llamaFetch("/models", { signal: AbortSignal.timeout(10000) });
    if (!response.ok) {
      return res.status(response.status === 401 ? 502 : response.status).json({
        error: response.status === 401
          ? "Model server rejected the API key (check LLAMA_API_KEY in ~/.llmui/llama.env)"
          : await upstreamError(response),
      });
    }
    const data = await response.json();
    res.json({ models: (data.data || data.models || []).map(normalizeModel) });
  } catch (err) {
    res.status(502).json({ error: `Model server unreachable: ${err.message}` });
  }
});

export default router;
