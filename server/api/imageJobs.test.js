// Image jobs: generation outlives the stream that started it; status, result,
// events and cancel by job id. sd-server is replaced by fakes (no GPU).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolateHome, listen, readAllSse, waitFor } from "../testHelpers.js";

isolateHome();
const express = (await import("express")).default;
const { getDb } = await import("../db/index.js");
const imagesRouter = (await import("./images.js")).default;
const { acquireImageLock, isImageJobActive } = await import("../sd.js");
const { getMachine } = await import("../backends.js");

const machine = getMachine("jellyfin");
// One PNG header's worth of bytes, so pngSize() reads 64x64.
const png = Buffer.alloc(32);
Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
png.write("IHDR", 12, "ascii");
png.writeUInt32BE(64, 16);
png.writeUInt32BE(64, 20);

let gate;
const calls = [];
const deps = {
  unloadChatModels: async () => calls.push("unloadChat"),
  loadSdModel: async () => calls.push("loadSd"),
  unloadSdModel: async () => calls.push("unloadSd"),
  // Report progress, then wait for the gate (or a cancel).
  txt2img: async (m, p, { onProgress, signal }) => {
    onProgress({ stage: "sampling", step: 1, totalSteps: 2, pass: 1, value: 0.5 });
    await new Promise((resolve, reject) => {
      gate.promise.then(resolve);
      signal.addEventListener("abort", () => reject(Object.assign(new Error("Generation cancelled"), { code: "cancelled" })));
    });
    return { api: "sdcpp", images: [png], generationInfo: [null], elapsedMs: 42 };
  },
};
const newGate = () => {
  let release;
  gate = { promise: new Promise((r) => (release = r)) };
  gate.release = release;
};

let server;
before(async () => {
  getDb();
  const app = express();
  app.use(express.json());
  app.locals.imageJobDeps = deps;
  app.locals.prepareImageJob = async (req) => {
    const busy = acquireImageLock(machine);
    if (busy) return { status: 409, body: { error: busy, code: "gpu_busy" } };
    const p = { prompt: req.body.prompt, negativePrompt: "", checkpoint: "checkpoints/x.safetensors", width: 64, height: 64,
      steps: 2, cfgScale: 7, sampler: "euler", scheduler: null, seed: 7, batchCount: 1 };
    return { machine, p, setup: { recipe: "sd1-checkpoint", models: { model: p.checkpoint } } };
  };
  app.use("/api/images", imagesRouter);
  server = await listen(app);
});
after(() => server.close());

const post = (p, body) => fetch(server.url + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const get = (p) => fetch(server.url + p);

test("closing the txt2img stream doesn't cancel the job; status, events and result by job id", async () => {
  newGate();
  calls.length = 0;
  const controller = new AbortController();
  const res = await fetch(server.url + "/api/images/txt2img", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ prompt: "a fox" }), signal: controller.signal,
  });
  assert.equal(res.status, 200);
  const jobId = res.headers.get("x-llmui-job-id");
  assert.ok(jobId);
  // Read the first event, then hang up (the app went to the background).
  const reader = res.body.getReader();
  const first = new TextDecoder().decode((await reader.read()).value);
  assert.match(first, new RegExp(`"type":"job","jobId":"${jobId}"`));
  controller.abort();

  const running = await waitFor(async () => {
    const s = await (await get(`/api/images/jobs/${jobId}`)).json();
    return s.progress && s;
  });
  assert.equal(running.status, "running");
  assert.equal(running.progress.value, 0.5);
  assert.ok(isImageJobActive(machine));
  const early = await get(`/api/images/jobs/${jobId}/result`);
  assert.equal(early.status, 409);
  assert.equal((await early.json()).code, "job_running");
  const active = await (await get("/api/images/jobs?active=1")).json();
  assert.deepEqual(active.jobs.map((j) => j.id), [jobId]);
  // A second job can't take the GPU meanwhile.
  assert.equal((await post("/api/images/jobs", { prompt: "another" })).status, 409);

  gate.release();
  const done = await waitFor(async () => {
    const s = await (await get(`/api/images/jobs/${jobId}`)).json();
    return s.status === "completed" && s;
  });
  assert.equal(done.result.imageCount, 1);
  assert.ok(!isImageJobActive(machine));
  assert.deepEqual(calls, ["unloadChat", "loadSd", "unloadSd"]);

  const result = await (await get(`/api/images/jobs/${jobId}/result`)).json();
  assert.equal(result.generationId, done.result.generationId);
  assert.equal(result.images[0].url, `/api/images/generations/${result.generationId}/images/${result.imageIds[0]}`);
  const bytes = Buffer.from(await (await get(result.images[0].url)).arrayBuffer());
  assert.ok(bytes.equals(png));

  // Replay from the start: job, stages, progress, complete.
  const events = await readAllSse(await get(`/api/images/jobs/${jobId}/events?after=0`));
  assert.equal(events[0].type, "job");
  assert.equal(events.at(-1).type, "complete");
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  const tail = await readAllSse(await get(`/api/images/jobs/${jobId}/events?after=${events.at(-2).seq}`));
  assert.deepEqual(tail.map((e) => e.type), ["complete"]);

  // The generation records its job id, so the result survives the job being forgotten.
  const row = getDb().prepare("SELECT job_id FROM image_generations WHERE id = ?").get(result.generationId);
  assert.equal(row.job_id, jobId);
});

test("POST /jobs returns 202 at once; cancel stops it, frees the GPU and reports cancelled", async () => {
  newGate();
  calls.length = 0;
  const res = await post("/api/images/jobs", { prompt: "a fox" });
  assert.equal(res.status, 202);
  const job = await res.json();
  assert.equal(job.status, "running");
  await waitFor(async () => (await (await get(`/api/images/jobs/${job.id}`)).json()).progress);

  const cancelled = await (await post(`/api/images/jobs/${job.id}/cancel`)).json();
  assert.equal(cancelled.status, "cancelled");
  assert.ok(!isImageJobActive(machine));
  assert.ok(calls.includes("unloadSd"));
  const result = await get(`/api/images/jobs/${job.id}/result`);
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, "job_cancelled");
  const events = await readAllSse(await get(`/api/images/jobs/${job.id}/events`));
  assert.equal(events.at(-1).type, "cancelled");
  gate.release();
});

test("unknown jobs are 404", async () => {
  for (const p of ["/api/images/jobs/nope", "/api/images/jobs/nope/result", "/api/images/jobs/nope/events"]) {
    assert.equal((await get(p)).status, 404);
  }
  assert.equal((await post("/api/images/jobs/nope/cancel")).status, 404);
});
