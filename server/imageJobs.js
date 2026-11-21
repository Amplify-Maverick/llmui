/**
 * Image generation jobs (docs/api.md §8.3).
 *
 * A job owns its machine's GPU from start to finish and runs whether or not
 * anyone is watching: closing a stream never cancels it. Only
 * POST /api/images/jobs/:id/cancel does. Progress is an event log (see
 * eventlog.js) that clients replay from any point.
 *
 * Jobs live in memory for JOB_RETENTION_MS after they end. Each job is also
 * a row in the `image_jobs` table (written at start, about once a second
 * while it runs, and at the end), and a completed job's images are stored
 * with its id (image_generations.job_id), so its state can still be read
 * after that, or after a restart. On startup, recoverInterruptedJobs() marks
 * jobs the last process left running as "interrupted".
 */

import { nanoid } from "nanoid";
import { EventLog } from "./eventlog.js";
import { getDb } from "./db/index.js";
import * as sd from "./sd.js";

export const JOB_RETENTION_MS = 60 * 60 * 1000;
export const JOB_FLUSH_MS = 1000;
/** Ended job rows older than this are deleted on startup. */
export const JOB_ROW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
export const JOB_INTERRUPTED_ERROR = "The server restarted while this image was being generated";

const parseJson = (s) => {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
};

/** An image_jobs row → the same snapshot shape as a live job. */
export function jobRowSnapshot(row) {
  return {
    id: row.id,
    status: row.status,
    machine: row.machine_id,
    params: parseJson(row.params),
    stage: row.status === "running" ? row.stage : null,
    message: row.message || "",
    progress: parseJson(row.progress),
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    error: row.error,
    result: parseJson(row.result),
    seq: row.seq,
  };
}

export const jobRow = (id) => getDb().prepare("SELECT * FROM image_jobs WHERE id = ?").get(id) || null;

/** Ended jobs from the database that aren't in memory, created after `since`, newest first. */
export function storedJobsSince(since) {
  return getDb()
    .prepare("SELECT * FROM image_jobs WHERE created_at >= ? ORDER BY created_at DESC LIMIT 50")
    .all(since)
    .filter((row) => !jobs.has(row.id))
    .map(jobRowSnapshot);
}

function writeJob(job, insert = false) {
  job.dirty = false;
  try {
    const db = getDb();
    const values = [
      job.status, job.stage, job.message, job.progress ? JSON.stringify(job.progress) : null,
      job.result ? JSON.stringify(job.result) : null, job.error, job.sdJobId || null, job.log.seq, Date.now(), job.finishedAt,
    ];
    if (insert) {
      db.prepare(`
        INSERT INTO image_jobs (status, stage, message, progress, result, error, sd_job_id, seq, updated_at, finished_at, id, machine_id, params, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(...values, job.id, job.machine.id, JSON.stringify(job.params), job.createdAt);
    } else {
      db.prepare(`
        UPDATE image_jobs SET status = ?, stage = ?, message = ?, progress = ?, result = ?, error = ?, sd_job_id = ?, seq = ?,
          updated_at = ?, finished_at = ? WHERE id = ?
      `).run(...values, job.id);
    }
  } catch (err) {
    console.error(`Image job ${job.id}: couldn't record its state:`, err.message);
  }
}

/** Write every running job's state now (the server is shutting down). */
export function flushJobs() {
  for (const job of jobs.values()) if (job.status === "running") writeJob(job);
}

/**
 * On startup: jobs the last process left running were cut off. Mark them
 * "interrupted" and return their rows, so the caller can tell sd-server to
 * stop them and free the GPU. Also deletes ended rows older than
 * JOB_ROW_RETENTION_MS.
 */
export function recoverInterruptedJobs(db = getDb(), now = Date.now()) {
  const rows = db.prepare("SELECT * FROM image_jobs WHERE status = 'running'").all();
  const mark = db.prepare("UPDATE image_jobs SET status = 'interrupted', stage = NULL, error = ?, finished_at = ?, updated_at = ? WHERE id = ?");
  for (const row of rows) {
    mark.run(JOB_INTERRUPTED_ERROR, now, now, row.id);
    console.log(`Image job ${row.id} on ${row.machine_id} was interrupted by a restart`);
  }
  db.prepare("DELETE FROM image_jobs WHERE status != 'running' AND COALESCE(finished_at, updated_at) < ?").run(now - JOB_ROW_RETENTION_MS);
  return rows;
}

/**
 * After a restart: stop an interrupted job's sd-server job (if it got that
 * far) and unload the SD model, so the GPU is free for chat. Best effort.
 */
export async function cleanUpInterruptedJob(machine, row, deps = {}) {
  const api = { ...sd, ...deps };
  if (row.sd_job_id) {
    await api.sdFetch(machine, `/sdcpp/v1/jobs/${encodeURIComponent(row.sd_job_id)}/cancel`, { method: "POST", body: {} })
      .catch((err) => console.warn(`Couldn't cancel sd-server job ${row.sd_job_id} on ${machine.name}:`, err.message));
  }
  await api.unloadSdModel(machine, { timeoutMs: 60000 })
    .catch((err) => console.warn(`Couldn't unload the SD model on ${machine.name}:`, err.message));
}

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
    job.dirty = true;
    job.log.push({ type, ...data });
  };
  const signal = job.controller.signal;
  const checkAborted = () => {
    if (signal.aborted) throw Object.assign(new Error("Generation cancelled"), { code: "cancelled" });
  };

  send("job", { jobId: job.id, machine: machine.id });
  writeJob(job, true);
  const flushTimer = setInterval(() => job.dirty && writeJob(job), deps.flushMs ?? JOB_FLUSH_MS);
  flushTimer.unref?.();

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
      const result = await api.txt2img(machine, p, {
        signal,
        onProgress: (pr) => send("progress", pr),
        // Recorded at once: after a restart it's how the job is stopped on sd-server.
        onSubmitted: (sdJobId) => {
          job.sdJobId = sdJobId;
          writeJob(job);
        },
      });
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
      clearInterval(flushTimer);
      job.finishedAt = Date.now();
      job.stage = null;
      job.log.push(terminal, { end: true });
      writeJob(job);
      job.resolveDone();
      setTimeout(() => jobs.delete(job.id), JOB_RETENTION_MS).unref?.();
    }
  })();

  return job;
}
