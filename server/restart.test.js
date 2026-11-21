// A simulated restart: a server process (testFixtures/restartChild.js) is
// killed with SIGKILL in the middle of a reply, a Compare and an image job.
// This process then starts on the same database, recovers, and serves the
// final saved state: interrupted replies (with Continue and Retry), and an
// interrupted image job, all readable by run or job id.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { isolateHome, listen, readAllNdjson, readAllSse, readNdjsonUntil, waitFor } from "./testHelpers.js";

isolateHome();

// The model server after the restart: finishes every reply.
const upstreamRequests = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    upstreamRequests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ choices: [{ delta: { reasoning_content: "Picking up." } }] });
    send({ choices: [{ delta: { content: " and the rest." } }] });
    send({
      choices: [{ delta: {}, finish_reason: "stop" }],
      timings: { predicted_n: 4, predicted_ms: 200, predicted_per_second: 20, prompt_n: 5, prompt_ms: 50, prompt_per_second: 100 },
    });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));

// ── before the restart (child process) ───────────────────────────────

const child = spawn(process.execPath, [fileURLToPath(new URL("./testFixtures/restartChild.js", import.meta.url))], {
  env: process.env,
  stdio: ["ignore", "pipe", "inherit"],
});
// Never leave it running, whatever happens to this test.
process.on("exit", () => child.kill("SIGKILL"));
const childUrl = await new Promise((resolve, reject) => {
  let out = "";
  child.stdout.on("data", (c) => {
    out += c;
    const m = out.match(/listening (\S+)/);
    if (m) resolve(m[1]);
  });
  child.on("exit", (code) => reject(new Error(`child exited (${code})`)));
});
const cpost = (p, body) => fetch(childUrl + p, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });

const chatId = (await (await cpost("/api/conversations", { model: "test/model:Q4" })).json()).id;
const sendRes = await cpost(`/api/conversations/${chatId}/send`, { content: "Tell me a story", enableThinking: true, enabledTools: [] });
const runId = sendRes.headers.get("x-llmui-run-id");
const seenBeforeCrash = await readNdjsonUntil(sendRes, (e) => e.type === "content" && e.content.startsWith("reply"));
const lastSeqSeen = seenBeforeCrash.at(-1).seq;

const cmpId = (await (await cpost("/api/conversations", { model: "test/model:Q4" })).json()).id;
const compare = await (await cpost(`/api/conversations/${cmpId}/compare`, {
  content: "Which is better?",
  enableThinking: true,
  enabledTools: [],
  sides: [{ model: "test/a:Q4", machine: "jellyfin" }, { model: "test/b:Q4", machine: "jellyfin" }],
})).json();

const job = await (await cpost("/api/images/jobs", { prompt: "a fox" })).json();

// Wait until every partial is in the database, then kill the server mid-flight.
const { getDb } = await import("./db/index.js");
await waitFor(() => {
  const db = getDb();
  const rows = db.prepare("SELECT content, thinking FROM runs WHERE status = 'running'").all();
  const jobRow = db.prepare("SELECT progress, sd_job_id FROM image_jobs WHERE id = ?").get(job.id);
  return rows.length === 3 && rows.every((r) => r.content.endsWith("Q4") && r.thinking) && jobRow?.progress && jobRow.sd_job_id;
}, { timeout: 5000, interval: 50 }).catch((err) => {
  const db = getDb();
  console.error(db.prepare("SELECT id, status, content, thinking FROM runs").all(), db.prepare("SELECT * FROM image_jobs").all());
  throw err;
});
child.kill("SIGKILL");
await new Promise((r) => child.once("exit", r));

// ── after the restart (this process) ─────────────────────────────────

process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;
const express = (await import("express")).default;
const { runsRouter, recoverInterruptedRuns, CONTINUE_PROMPT } = await import("./runs.js");
const { recoverInterruptedJobs, cleanUpInterruptedJob } = await import("./imageJobs.js");
const conversationsRouter = (await import("./api/conversations.js")).default;
const messagesRouter = (await import("./api/messages.js")).default;
const imagesRouter = (await import("./api/images.js")).default;
const { getMachine } = await import("./backends.js");

// What server/index.js does on startup.
const recovered = recoverInterruptedRuns();
const interruptedJobs = recoverInterruptedJobs();
const cleanup = [];
for (const row of interruptedJobs) {
  await cleanUpInterruptedJob(getMachine(row.machine_id), row, {
    sdFetch: async (m, p) => cleanup.push(["sdFetch", m.id, p]),
    unloadSdModel: async (m) => cleanup.push(["unloadSd", m.id]),
  });
}

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationsRouter);
app.use("/api", messagesRouter);
app.use("/api", runsRouter);
app.use("/api/images", imagesRouter);
let server;
const url = (p) => server.url + p;
const getJson = async (p) => (await fetch(url(p))).json();
const post = (p, body) => fetch(url(p), { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
const messagesOf = async (id) => (await getJson(`/api/conversations/${id}/messages`)).messages;

before(async () => {
  server = await listen(app);
});
after(async () => {
  await server.close();
  fake.closeAllConnections();
  fake.close();
});

test("recovery stores each cut-off reply as an interrupted message, keeping Think text, model and machine", async () => {
  assert.equal(recovered.length, 3);
  const messages = await messagesOf(chatId);
  assert.deepEqual(messages.map((m) => [m.role, m.status]), [["user", null], ["assistant", "interrupted"]]);
  const reply = messages[1];
  assert.equal(reply.content, "Partial reply from test/model:Q4");
  assert.equal(reply.thinking, "Thinking as test/model:Q4.");
  assert.equal(reply.machine, "jellyfin");
  assert.equal(reply.model, "test/model:Q4");

  // Recovering again finds nothing left running.
  assert.equal(recoverInterruptedRuns().length, 0);
});

test("reattach by run id after the restart returns the saved state instead of 404", async () => {
  const snap = await getJson(`/api/runs/${runId}`);
  assert.equal(snap.status, "interrupted");
  assert.equal(snap.content, "Partial reply from test/model:Q4");
  assert.equal(snap.messageId, (await messagesOf(chatId))[1].id);
  assert.ok(snap.seq >= 1);

  // Events: one end event, past the last seq the client saw.
  const events = await readAllNdjson(await fetch(url(`/api/runs/${runId}/events?after=${lastSeqSeen}`)));
  assert.deepEqual(events.map((e) => e.type), ["interrupted"]);
  assert.ok(events[0].seq > lastSeqSeen);
  assert.equal(events[0].messageId, snap.messageId);
  const sse = await readAllSse(await fetch(url(`/api/conversations/${chatId}/run/events?format=sse`)));
  assert.equal(sse.at(-1).type, "interrupted");

  const conv = await getJson(`/api/conversations/${chatId}`);
  assert.equal(conv.activeRunId, null);
  assert.deepEqual(conv.activeRunIds, []);
  assert.equal((await getJson(`/api/conversations/${chatId}/run`)).run.id, runId);
  // Nothing is running, so the chat accepts writes again.
  assert.equal((await post(`/api/runs/${runId}/cancel`)).status, 200);
});

test("Continue sends the partial as context and appends to the same message", async () => {
  const [, reply] = await messagesOf(chatId);
  const res = await post(`/api/conversations/${chatId}/send`, { continue: true, enableThinking: true, enabledTools: [] });
  assert.equal(res.status, 200);
  const events = await readAllNdjson(res);
  assert.equal(events[0].type, "start");
  assert.equal(events[0].continues, reply.id);
  assert.equal(events[0].content, reply.content);
  assert.equal(events.at(-1).type, "done");
  assert.equal(events.at(-1).messageId, reply.id);

  const sent = upstreamRequests.at(-1);
  assert.equal(sent.model, "test/model:Q4");
  assert.deepEqual(sent.messages.slice(-3), [
    { role: "user", content: "Tell me a story" },
    { role: "assistant", content: "Partial reply from test/model:Q4" },
    { role: "user", content: CONTINUE_PROMPT },
  ]);

  const messages = await messagesOf(chatId);
  assert.equal(messages.length, 2);
  assert.equal(messages[1].id, reply.id);
  assert.equal(messages[1].content, "Partial reply from test/model:Q4 and the rest.");
  assert.equal(messages[1].thinking, "Thinking as test/model:Q4.\n\nPicking up.");
  assert.equal(messages[1].status, null);
  assert.equal(messages[1].machine, "jellyfin");
  assert.equal(messages[1].tokensPerSec, 20);
});

test("an interrupted Compare keeps both replies in their group; each side can be retried on its own", async () => {
  let messages = await messagesOf(cmpId);
  assert.deepEqual(
    messages.map((m) => [m.role, m.status, m.compareGroup ?? null, m.compareSlot ?? null, m.model]),
    [
      ["user", null, null, null, null],
      ["assistant", "interrupted", compare.compareGroup, 0, "test/a:Q4"],
      ["assistant", "interrupted", compare.compareGroup, 1, "test/b:Q4"],
    ]
  );
  assert.equal(messages[1].thinking, "Thinking as test/a:Q4.");
  for (const r of compare.runs) assert.equal((await getJson(`/api/runs/${r.id}`)).status, "interrupted");
  assert.deepEqual((await getJson(`/api/conversations/${cmpId}/runs`)).runs.map((r) => r.status), ["interrupted", "interrupted"]);

  // Two replies at the end: continuing needs to say which.
  const ambiguous = await post(`/api/conversations/${cmpId}/send`, { continue: true });
  assert.equal(ambiguous.status, 400);

  // Retry side B: replaced in place (same group and slot, its own model); A stays.
  const retry = await readAllNdjson(await post(`/api/conversations/${cmpId}/send`, { regenerate: true, messageId: messages[2].id, enabledTools: [] }));
  assert.equal(retry.at(-1).type, "done");
  assert.equal(upstreamRequests.at(-1).model, "test/b:Q4");
  assert.deepEqual(upstreamRequests.at(-1).messages.map((m) => m.role), ["user"]);
  messages = await messagesOf(cmpId);
  assert.deepEqual(
    messages.map((m) => [m.status, m.compareSlot ?? null, m.model, m.content]),
    [
      [null, null, null, "Which is better?"],
      ["interrupted", 0, "test/a:Q4", "Partial reply from test/a:Q4"],
      [null, 1, "test/b:Q4", " and the rest."],
    ]
  );
  assert.equal(messages[2].compareGroup, compare.compareGroup);
});

test("an interrupted image job reads as interrupted by id, keeps its settings, and sd-server is told to stop", async () => {
  assert.deepEqual(interruptedJobs.map((r) => r.id), [job.id]);
  assert.deepEqual(cleanup, [
    ["sdFetch", "workstation", "/sdcpp/v1/jobs/sd-job-1/cancel"],
    ["unloadSd", "workstation"],
  ]);

  const snap = await getJson(`/api/images/jobs/${job.id}`);
  assert.equal(snap.status, "interrupted");
  assert.equal(snap.machine, "workstation");
  assert.equal(snap.params.prompt, "a fox");
  assert.equal(snap.params.seed, 42);
  assert.equal(snap.progress.value, 0.25);
  assert.ok(snap.finishedAt);

  const result = await fetch(url(`/api/images/jobs/${job.id}/result`));
  assert.equal(result.status, 409);
  assert.equal((await result.json()).code, "job_interrupted");
  const events = await readAllSse(await fetch(url(`/api/images/jobs/${job.id}/events?after=3`)));
  assert.deepEqual(events.map((e) => e.type), ["interrupted"]);
  assert.ok(events[0].seq > 3);
  assert.deepEqual((await getJson("/api/images/jobs")).jobs.map((j) => [j.id, j.status]), [[job.id, "interrupted"]]);
  assert.deepEqual((await getJson("/api/images/jobs?active=1")).jobs, []);
  assert.equal((await (await post(`/api/images/jobs/${job.id}/cancel`)).json()).status, "interrupted");
});
