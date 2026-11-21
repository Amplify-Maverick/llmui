// The "before" half of server/restart.test.js: an LLMUI server process (runs,
// Compare, image jobs) whose model server and sd-server never finish. The
// test starts a reply, a Compare and an image job here, waits until their
// partial state is in the database, then kills this process with SIGKILL.
// HOME comes from the parent, so both use the same scratch database.
import http from "node:http";

// Fake llama.cpp router: Think, then "Partial reply", then nothing, ever.
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { model } = JSON.parse(body);
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ choices: [{ delta: { reasoning_content: `Thinking as ${model}.` } }] });
    send({ choices: [{ delta: { content: "Partial " } }] });
    send({ choices: [{ delta: { content: `reply from ${model}` } }] });
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;

const express = (await import("express")).default;
const { getDb } = await import("../db/index.js");
const { runsRouter } = await import("../runs.js");
const conversationsRouter = (await import("../api/conversations.js")).default;
const imagesRouter = (await import("../api/images.js")).default;
const { acquireImageLock } = await import("../sd.js");
const { getMachine } = await import("../backends.js");

getDb();
// The other machine: chats are streaming on Jellyfin, which holds its GPU.
const machine = getMachine("workstation");
const app = express();
app.use(express.json());
app.locals.runDeps = { flushMs: 100 };
app.locals.imageJobDeps = {
  flushMs: 100,
  unloadChatModels: async () => {},
  loadSdModel: async () => {},
  unloadSdModel: async () => {},
  // Submitted to sd-server, one step done, then it never ends.
  txt2img: async (m, p, { onProgress, onSubmitted }) => {
    onSubmitted("sd-job-1");
    onProgress({ stage: "sampling", step: 1, totalSteps: 4, pass: 1, value: 0.25 });
    await new Promise(() => {});
  },
};
app.locals.prepareImageJob = async (req) => {
  const busy = acquireImageLock(machine);
  if (busy) return { status: 409, body: { error: busy, code: "gpu_busy" } };
  const p = { prompt: req.body.prompt, negativePrompt: "", checkpoint: "checkpoints/x.safetensors", width: 64, height: 64,
    steps: 4, cfgScale: 7, sampler: "euler", scheduler: null, seed: 42, batchCount: 1 };
  return { machine, p, setup: { recipe: "sd1-checkpoint", models: { model: p.checkpoint } } };
};
app.use("/api/conversations", conversationsRouter);
app.use("/api", runsRouter);
app.use("/api/images", imagesRouter);
const server = app.listen(0, "127.0.0.1", () => {
  process.stdout.write(`listening http://127.0.0.1:${server.address().port}\n`);
});
