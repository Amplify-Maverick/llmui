/**
 * Image generation client — all requests go through the authenticated Express
 * server (/api/images/*), which talks to stable-diffusion.cpp's sd-server.
 */

import { authHeaders } from "./auth.js";

const BASE = "/api/images";

async function getJson(path, init = {}) {
  const response = await fetch(`${BASE}${path}`, { ...init, headers: await authHeaders() });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `Request failed (${response.status})`);
  return data;
}

class ImageAPI {
  /** { ok, url, state, busy, error? } */
  async status() {
    try {
      return await getJson("/status", { signal: AbortSignal.timeout(8000) });
    } catch (err) {
      return { ok: false, error: err.message };
    }
  }

  /** { checkpoints, samplers, schedulers, defaults } */
  options() {
    return getJson("/options");
  }

  /**
   * Start a txt2img job. Calls onEvent for each SSE event
   * (stage, progress, complete, error). Resolves with { abort } once the
   * stream is open; throws with the server's error text if it refuses.
   */
  async txt2img(params, onEvent) {
    const controller = new AbortController();
    const response = await fetch(`${BASE}/txt2img`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(params),
      signal: controller.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        // not JSON
      }
      throw new Error(message || `Failed to start generation (${response.status})`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let sawTerminal = false;
    (async () => {
      let buffer = "";
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";
          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            let event;
            try {
              event = JSON.parse(line.slice(6));
            } catch {
              continue;
            }
            if (event.type === "complete" || event.type === "error") sawTerminal = true;
            onEvent(event);
          }
        }
        if (!sawTerminal) onEvent({ type: "error", error: "Connection closed before the image finished" });
      } catch (err) {
        if (err.name !== "AbortError") onEvent({ type: "error", error: err.message });
      } finally {
        reader.releaseLock();
      }
    })();

    return { abort: () => controller.abort() };
  }

  // ── History (DB-backed) ──────────────────────────────────────────────

  listGenerations(page = 1, limit = 20) {
    return getJson(`/generations?page=${page}&limit=${limit}`);
  }

  getGeneration(id) {
    return getJson(`/generations/${encodeURIComponent(id)}`);
  }

  deleteGeneration(id) {
    return getJson(`/generations/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /** URL of a stored image; fetch it with auth headers (see AuthImage). */
  getImageUrl(generationId, imageId) {
    return `${BASE}/generations/${encodeURIComponent(generationId)}/images/${encodeURIComponent(imageId)}`;
  }
}

export const imageApi = new ImageAPI();
