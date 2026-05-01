/**
 * ComfyUI API client — all requests go through the authenticated Express server
 * on port 3001 (/comfyui/*).
 */

import { authHeaders } from "./auth.js";

const AUTH_SERVER = "http://localhost:3001";

class ComfyUIAPI {
  // ── Config ───────────────────────────────────────────────────────────

  async getConfig() {
    const response = await fetch(`${AUTH_SERVER}/comfyui/config`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch ComfyUI config");
    const data = await response.json();
    return data.comfyuiUrl;
  }

  async setConfig(url) {
    const response = await fetch(`${AUTH_SERVER}/comfyui/config`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ comfyuiUrl: url }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to update ComfyUI URL");
    }
    return response.json();
  }

  // ── Status ───────────────────────────────────────────────────────────

  async checkConnection() {
    try {
      const response = await fetch(`${AUTH_SERVER}/comfyui/status`, {
        headers: await authHeaders(),
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) return false;
      const data = await response.json();
      return data.ok === true;
    } catch {
      return false;
    }
  }

  // ── Models ───────────────────────────────────────────────────────────

  async listCheckpoints() {
    const response = await fetch(`${AUTH_SERVER}/comfyui/models/checkpoints`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch checkpoints");
    const data = await response.json();
    return data.models || [];
  }

  async listLoras() {
    const response = await fetch(`${AUTH_SERVER}/comfyui/models/loras`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch LoRAs");
    const data = await response.json();
    return data.models || [];
  }

  async listSamplers() {
    const response = await fetch(`${AUTH_SERVER}/comfyui/samplers`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch samplers");
    return response.json(); // { samplers: [], schedulers: [] }
  }

  // ── Generation (SSE stream) ──────────────────────────────────────────

  /**
   * Start a txt2img generation. Returns an object with:
   *  - eventSource: for listening to progress events
   *  - abort: function to cancel
   *
   * Events emitted: queued, progress, complete, error
   */
  async txt2img(params, onEvent) {
    const controller = new AbortController();

    const response = await fetch(`${AUTH_SERVER}/comfyui/txt2img`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(err || "Failed to start generation");
    }

    // Read the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const readStream = async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6));
                onEvent(event);
              } catch {
                // skip malformed
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    // Start reading in background
    readStream().catch((err) => {
      if (err.name !== "AbortError") {
        onEvent({ type: "error", error: err.message });
      }
    });

    return {
      abort: () => controller.abort(),
    };
  }

  // ── History (DB-backed) ──────────────────────────────────────────────

  async listGenerations(page = 1, limit = 20) {
    const response = await fetch(
      `${AUTH_SERVER}/comfyui/generations?page=${page}&limit=${limit}`,
      { headers: await authHeaders() }
    );
    if (!response.ok) throw new Error("Failed to fetch generations");
    return response.json();
  }

  async getGeneration(id) {
    const response = await fetch(`${AUTH_SERVER}/comfyui/generations/${id}`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch generation");
    return response.json();
  }

  async deleteGeneration(id) {
    const response = await fetch(`${AUTH_SERVER}/comfyui/generations/${id}`, {
      method: "DELETE",
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to delete generation");
    return response.json();
  }

  /**
   * Get the URL for an image (for <img src=...>).
   * Includes auth token as query param since <img> can't set headers.
   */
  getImageUrl(generationId, imageId) {
    return `${AUTH_SERVER}/comfyui/generations/${generationId}/images/${imageId}`;
  }

  // ── Models Path ────────────────────────────────────────────────────────

  async getModelsPath() {
    const response = await fetch(`${AUTH_SERVER}/comfyui/models-path`, {
      headers: await authHeaders(),
    });
    if (!response.ok) throw new Error("Failed to fetch models path");
    const data = await response.json();
    return data.modelsPath || "";
  }

  async setModelsPath(modelsPath) {
    const response = await fetch(`${AUTH_SERVER}/comfyui/models-path`, {
      method: "PUT",
      headers: await authHeaders(),
      body: JSON.stringify({ modelsPath }),
    });
    if (!response.ok) {
      const data = await response.json();
      throw new Error(data.error || "Failed to update models path");
    }
    return response.json();
  }

  // ── Civitai Search ─────────────────────────────────────────────────────

  async searchCivitai({ query, types, sort, limit, page, nsfw } = {}) {
    const params = new URLSearchParams();
    if (query) params.set("query", query);
    if (types) params.set("types", types);
    if (sort) params.set("sort", sort);
    if (limit) params.set("limit", limit);
    if (page) params.set("page", page);
    if (nsfw !== undefined) params.set("nsfw", nsfw);

    const response = await fetch(
      `${AUTH_SERVER}/comfyui/civitai/search?${params.toString()}`,
      { headers: await authHeaders() }
    );
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || "Failed to search Civitai");
    }
    return response.json();
  }

  // ── Model Download (SSE stream) ────────────────────────────────────────

  async downloadModel({ downloadUrl, filename, modelType }, onEvent) {
    const controller = new AbortController();

    const response = await fetch(`${AUTH_SERVER}/comfyui/models/download`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({ downloadUrl, filename, modelType }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({ error: "Download failed" }));
      throw new Error(err.error || "Failed to start download");
    }

    // Read the SSE stream
    const reader = response.body.getReader();
    const decoder = new TextDecoder();

    const readStream = async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("data: ")) {
              try {
                const event = JSON.parse(line.slice(6));
                onEvent(event);
              } catch {
                // skip malformed
              }
            }
          }
        }
      } finally {
        reader.releaseLock();
      }
    };

    readStream().catch((err) => {
      if (err.name !== "AbortError") {
        onEvent({ type: "error", error: err.message });
      }
    });

    return {
      abort: () => controller.abort(),
    };
  }
}

export const comfyApi = new ComfyUIAPI();
export default ComfyUIAPI;
