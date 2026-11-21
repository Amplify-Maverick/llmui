/**
 * Image generation client — all requests go through the authenticated Express
 * server (/api/images/*), which talks to stable-diffusion.cpp's sd-server.
 */

import { authHeaders } from "./auth.js";
import { pinHeader, checkMachineChanged } from "./machinePin.js";

const BASE = "/api/images";

/** `path` aimed at `machine` (?machine=<id>), or unchanged without one. */
const at = (path, machine) =>
  machine ? `${path}${path.includes("?") ? "&" : "?"}machine=${encodeURIComponent(machine)}` : path;

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
    return getJson(at("/options", machine));
  }

  // ── Model management (Models → Image) ────────────────────────────────

  /**
   * { files, recipes, default, gpuBytes, sdError, helper }.
   * `machine`: list that machine's files instead (read-only, System page).
   */
  models(machine) {
    return getJson(at("/models", machine));
  }

  /** { repos: [{ id, sha, files: [...] }], gpuBytes } */
  searchHF(q) {
    return getJson(`/models/hf/search?q=${encodeURIComponent(q)}`);
  }

  /**
   * Start a download on the sd-server host. Resolves with the helper job.
   * `machine` (install / job / cancel / delete): that machine, even if it isn't selected.
   */
  install({ repo, path, revision, category, recipe }, machine) {
    return getJson(at("/models/install", machine), {
      pin: !machine,
      method: "POST",
      body: JSON.stringify({ repo, path, revision, category, recipe }),
    });
  }

  /** { job } — the latest download job, or null */
  currentInstall(machine) {
    return getJson(at("/models/install/current", machine));
  }

  cancelInstall(id, machine) {
    return getJson(at(`/models/install/${encodeURIComponent(id)}/cancel`, machine), { method: "POST", pin: !machine });
  }

  deleteFile(category, name, machine) {
    return getJson(at(`/models/files/${encodeURIComponent(category)}/${encodeURIComponent(name)}`, machine), {
      method: "DELETE",
      pin: !machine,
    });
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
   * Start a txt2img job and watch it (docs/api.md §8.3). Calls onEvent for
   * each event: job (first, with jobId), stage, progress, then one of
   * complete / error / cancelled. If the connection drops, reattaches to the
   * job where it left off. Resolves once the stream is open with
   * { jobId, detach }: detach() stops watching (the job keeps running; use
   * cancelJob to stop it). Throws with the server's error text if it refuses.
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
      const data = await response.json().catch(() => ({}));
      throw new Error(data.error || `Failed to start generation (${response.status})`);
    }
    const jobId = response.headers.get("X-LLMUI-Job-Id");
    this._follow(jobId, response, 0, onEvent, controller);
    return { jobId, detach: () => controller.abort() };
  }

  /** Watch a running job from event `after` on; same events and return as txt2img. */
  watchJob(jobId, onEvent, after = 0) {
    const controller = new AbortController();
    this._follow(jobId, null, after, onEvent, controller);
    return { jobId, detach: () => controller.abort() };
  }

  async _follow(jobId, response, after, onEvent, controller) {
    let seq = after;
    let attempts = 0;
    for (;;) {
      let terminal = false;
      try {
        if (!response) {
          response = await fetch(`${BASE}/jobs/${encodeURIComponent(jobId)}/events?after=${seq}`, {
            headers: await authHeaders(),
            signal: controller.signal,
          });
          if (!response.ok) {
            const data = await response.json().catch(() => ({}));
            throw Object.assign(new Error(data.error || `Lost the job (${response.status})`), { status: response.status });
          }
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        try {
          for (;;) {
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
              if (event.seq) seq = event.seq;
              attempts = 0;
              if (["complete", "error", "cancelled"].includes(event.type)) terminal = true;
              onEvent(event);
            }
          }
        } finally {
          reader.releaseLock();
        }
      } catch (err) {
        if (err.name === "AbortError") return;
        if (err.status === 404 || !jobId || ++attempts > 6) {
          onEvent({ type: "error", error: err.message });
          return;
        }
      }
      if (terminal || controller.signal.aborted) return;
      // Connection dropped mid-job: the job carries on; pick it up again.
      response = null;
      await new Promise((r) => setTimeout(r, Math.min(1000 * Math.max(attempts, 1), 5000)));
    }
  }

  /** Stop a job. Resolves with its snapshot once it has stopped. */
  cancelJob(jobId) {
    return getJson(`/jobs/${encodeURIComponent(jobId)}/cancel`, { method: "POST" });
  }

  /** Jobs the server still holds, newest first; `active` = only running ones. */
  listJobs({ active = false } = {}) {
    return getJson(`/jobs${active ? "?active=1" : ""}`);
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

  /** The stored record of one image ("llmui.image/v1": prompt, machine, model, recipe, settings, timings, size). */
  getImageMeta(generationId, imageId) {
    return getJson(`/generations/${encodeURIComponent(generationId)}/images/${encodeURIComponent(imageId)}/meta`);
  }

  /** URL of a stored image; fetch it with auth headers (see AuthImage). */
  getImageUrl(generationId, imageId) {
    return `${BASE}/generations/${encodeURIComponent(generationId)}/images/${encodeURIComponent(imageId)}`;
  }
}

export const imageApi = new ImageAPI();
