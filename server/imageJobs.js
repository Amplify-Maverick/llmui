/**
 * Image generation jobs (docs/api.md §8.3).
 *
 * A job owns its machine's GPU from start to finish and runs whether or not
 * anyone is watching: closing a stream never cancels it. Only
 * POST /api/images/jobs/:id/cancel does. Progress is an event log (see
 * eventlog.js) that clients replay from any point.
 *
 * Jobs live in memory for JOB_RETENTION_MS after they end. A completed job's
 * images are stored with its id (image_generations.job_id), so its result can
 * still be found after that, or after a restart.
 */

import { nanoid } from "nanoid";
import { EventLog } from "./eventlog.js";
import * as sd from "./sd.js";

export const JOB_RETENTION_MS = 60 * 60 * 1000;

const jobs = new Map(); // job id → job

export const getJob = (id) => jobs.get(id) || null;

/** Jobs still in memory, newest first. */
export const listJobs = () => [...jobs.values()].sort((a, b) => b.createdAt - a.createdAt);

export function jobSnapshot(job) {
  return {
    id: job.id,
    status: job.status,
    machine: job.machine.id,
    params: job.params,
    stage: job.stage,
    message: job.message,
    progress: job.progress,
    createdAt: job.createdAt,
    finishedAt: job.finishedAt,
    error: job.error,
    result: job.result,
    seq: job.log.seq,
  };
}

/**
 * Start a job on `machine` for validated params `p` and model `setup`. The
 * caller has already taken the machine's GPU lock (acquireImageLock); the job
 * releases it when it ends. `saveGeneration(machine, p, setup, result,
 * timings, jobId)` stores the images and returns { generationId, imageIds }.
 * `deps` replaces sd.js functions in tests.
 */
export function startImageJob({ machine, p, setup, saveGeneration }, deps = {}) {
  const api = { ...sd, ...deps };
  const job = {
    id: nanoid(),
    status: "running",
    machine,
    params: p,
    stage: "starting",
    message: "",
    progress: null,
    createdAt: Date.now(),
    finishedAt: null,
    error: null,
    result: null,
    log: new EventLog(),
    controller: new AbortController(),
  };
  job.done = new Promise((resolve) => (job.resolveDone = resolve));
  jobs.set(job.id, job);

  const send = (type, data = {}) => {
    if (type === "stage") Object.assign(job, { stage: data.stage, message: data.message || "" });
    if (type === "progress") Object.assign(job, { stage: data.stage, message: "", progress: data });
    job.log.push({ type, ...data });
  };
  const signal = job.controller.signal;
  const checkAborted = () => {
    if (signal.aborted) throw Object.assign(new Error("Generation cancelled"), { code: "cancelled" });
  };

  send("job", { jobId: job.id, machine: machine.id });

  (async () => {
    const t0 = Date.now();
    let sdLoaded = false;
    let terminal;
    try {
      // Only this machine's chat models; other machines are never touched.
      send("stage", { stage: "freeing_gpu", message: `Unloading chat models on ${machine.name}…` });
      await api.unloadChatModels(machine, {
        signal,
        onWait: (models) => send("stage", {
          stage: "freeing_gpu",
          message: `Waiting for ${models.map((m) => `${m.id} (${m.status})`).join(", ")} to unload…`,
        }),
      });
      checkAborted();

      send("stage", { stage: "loading_model", message: `Loading ${p.checkpoint}…` });
      sdLoaded = true; // from here on, always try to unload
      const keepalive = setInterval(() => send("stage", { stage: "loading_model", message: `Loading ${p.checkpoint}…` }), 5000);
      try {
        await api.loadSdModel(machine, { ...setup, signal });
      } finally {
        clearInterval(keepalive);
      }
      checkAborted();

      const tGen = Date.now();
      const result = await api.txt2img(machine, p, { signal, onProgress: (pr) => send("progress", pr) });
      checkAborted();

      const timings = { totalMs: Date.now() - t0, generateMs: result.elapsedMs ?? Date.now() - tGen };
      const { generationId, imageIds } = saveGeneration(machine, p, setup, result, timings, job.id);
      job.result = { generationId, imageIds, seed: p.seed, imageCount: imageIds.length, api: result.api, timings };
      job.status = "completed";
      terminal = { type: "complete", machine: machine.id, ...job.result };
    } catch (err) {
      if (err.code === "cancelled" || signal.aborted) {
        job.status = "cancelled";
        terminal = { type: "cancelled" };
      } else {
        console.error("Image generation failed:", err.message);
        job.status = "failed";
        job.error = err.message;
        terminal = { type: "error", error: err.message };
      }
    } finally {
      if (sdLoaded) {
        try {
          await api.unloadSdModel(machine);
        } catch (err) {
          console.error("Failed to unload SD model:", err.message);
        }
      }
      api.releaseImageLock(machine);
      job.finishedAt = Date.now();
      job.stage = null;
      job.log.push(terminal, { end: true });
      job.resolveDone();
      setTimeout(() => jobs.delete(job.id), JOB_RETENTION_MS).unref?.();
    }
  })();

  return job;
}
