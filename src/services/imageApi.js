/**
 * Image generation client — all requests go through the authenticated Express
 * server (/api/images/*), which talks to stable-diffusion.cpp's sd-server.
 */

import { authHeaders } from "./auth.js";
import { pinHeader, checkMachineChanged } from "./machinePin.js";

const BASE = "/api/images";

/** `pin`: send the machine the UI shows, so the server refuses if images moved elsewhere. */
async function getJson(path, { pin = false, ...init } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { ...(await authHeaders()), ...(pin ? pinHeader("image") : {}) },
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    checkMachineChanged(response.status, data);
    throw new Error(data.error || `Request failed (${response.status})`);
  }
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

  /** { checkpoints, modelDefaults, samplers, schedulers, defaults }; `machine`: that machine's, read-only. */
  options(machine) {
    return getJson(machine ? `/options?machine=${encodeURIComponent(machine)}` : "/options");
  }

  // ── Model management (Models → Image) ────────────────────────────────

  /**
   * { files, recipes, default, gpuBytes, sdError, helper }.
   * `machine`: list that machine's files instead (read-only, System page).
   */
  models(machine) {
    return getJson(machine ? `/models?machine=${encodeURIComponent(machine)}` : "/models");
  }

  /** { repos: [{ id, sha, files: [...] }], gpuBytes } */
  searchHF(q) {
    return getJson(`/models/hf/search?q=${encodeURIComponent(q)}`);
  }

  /** Start a download on the sd-server host. Resolves with the helper job. */
  install({ repo, path, revision, category, recipe }) {
    return getJson("/models/install", {
      pin: true,
      method: "POST",
      body: JSON.stringify({ repo, path, revision, category, recipe }),
    });
  }

  /** { job } — the latest download job, or null */
  currentInstall() {
    return getJson("/models/install/current");
  }

  cancelInstall(id) {
    return getJson(`/models/install/${encodeURIComponent(id)}/cancel`, { method: "POST", pin: true });
  }

  deleteFile(category, name) {
    return getJson(`/models/files/${encodeURIComponent(category)}/${encodeURIComponent(name)}`, { method: "DELETE", pin: true });
  }

  /** Save a model's recipe + component files; makeDefault also sets it as the machine's default. */
  saveSetup({ model, recipe, components, makeDefault }) {
    return getJson("/models/setup", {
      pin: true,
      method: "PUT",
      body: JSON.stringify({ model, recipe, components, makeDefault }),
    });
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
