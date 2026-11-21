// Server-side runs: POST /api/conversations/:id/send, reattach, cancel, and
// the stored reply (with its Think text). The model is a fake llama.cpp
// server on loopback that streams SSE like the real one.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { isolateHome, listen, readAllNdjson, readNdjsonUntil, waitFor } from "./testHelpers.js";

isolateHome();

// ── fake llama.cpp router ────────────────────────────────────────────
// Streams Think, "Hel", then waits until `release()` (or the request is
// aborted), then "lo" and the final chunk with timings.
let gate;
const newGate = () => {
  let release;
  const promise = new Promise((r) => (release = r));
  gate = { promise, release };
};
newGate();
const upstreamRequests = [];
const fake = http.createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", async () => {
    upstreamRequests.push(JSON.parse(body));
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
    send({ choices: [{ delta: { reasoning_content: "Two plus two" } }] });
    send({ choices: [{ delta: { reasoning_content: " is four." } }] });
    send({ choices: [{ delta: { content: "Hel" } }] });
    const closed = new Promise((r) => res.on("close", r));
    await Promise.race([gate.promise, closed]);
    if (res.writableEnded || res.destroyed) return;
    send({ choices: [{ delta: { content: "lo" } }] });
    send({
      choices: [{ delta: {}, finish_reason: "stop" }],
      timings: { predicted_n: 10, predicted_ms: 500, predicted_per_second: 20, prompt_n: 5, prompt_ms: 50, prompt_per_second: 100 },
    });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
process.env.OPENAI_BASE_URL = `http://127.0.0.1:${fake.address().port}/v1`;

const express = (await import("express")).default;
const { getDb } = await import("./db/index.js");
const { runsRouter, resolveTurnSettings, historyForModel, startRun } = await import("./runs.js");
const messagesRouter = (await import("./api/messages.js")).default;
const conversationsRouter = (await import("./api/conversations.js")).default;
const exportRouter = (await import("./api/export.js")).default;

const app = express();
app.use(express.json());
app.use("/api/conversations", conversationsRouter);
app.use("/api", messagesRouter);
app.use("/api", runsRouter);
app.use("/api/export", exportRouter);
let server;
const url = (p) => server.url + p;
const json = (method, p, body) =>
  fetch(url(p), { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });

before(async () => {
  getDb();
  server = await listen(app);
});
after(async () => {
  gate.release();
  await server.close();
  fake.closeAllConnections();
  fake.close();
});

async function newChat(fields = {}) {
  return (await (await json("POST", "/api/conversations", { model: "test/model:Q4", ...fields })).json()).id;
}

test("send stores the user message, streams the run and stores the reply with its Think text", async () => {
  newGate();
  gate.release();
  const id = await newChat();
  const res = await json("POST", `/api/conversations/${id}/send`, { content: "What is 2+2?", enableThinking: true, enabledTools: [] });
  assert.equal(res.status, 200);
  assert.match(res.headers.get("content-type"), /ndjson/);
  const runId = res.headers.get("x-llmui-run-id");
  const events = await readAllNdjson(res);

  assert.deepEqual(events.map((e) => e.type), ["start", "thinking", "thinking", "content", "content", "done"]);
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  assert.equal(events[0].runId, runId);
  const done = events.at(-1);
  assert.equal(done.timings.predicted_per_second, 20);
  assert.ok(done.messageId);

  const { messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json();
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [["user", "What is 2+2?"], ["assistant", "Hello"]]);
  assert.equal(messages[1].id, done.messageId);
  assert.equal(messages[1].thinking, "Two plus two is four.");
  assert.equal(messages[1].tokensPerSec, 20);
  assert.equal(messages[1].model, "test/model:Q4");
  assert.equal(messages[0].thinking, undefined);

  // The model got the history built on the server, with thinking on.
  const sent = upstreamRequests.at(-1);
  assert.deepEqual(sent.messages, [{ role: "user", content: "What is 2+2?" }]);
  assert.equal(sent.chat_template_kwargs.enable_thinking, true);
  assert.equal(sent.tools, undefined);

  // The chat got its title from the first message.
  const conv = await (await fetch(url(`/api/conversations/${id}`))).json();
  assert.equal(conv.title, "What is 2+2?");
  assert.equal(conv.activeRunId, null);
});

test("disconnecting doesn't stop the run; reattach by run id or chat id gets what was missed", async () => {
  newGate();
  const id = await newChat();
  const res = await json("POST", `/api/conversations/${id}/send`, { content: "hi", enabledTools: [] });
  const runId = res.headers.get("x-llmui-run-id");
  const seen = await readNdjsonUntil(res, (e) => e.type === "content");
  const lastSeq = seen.at(-1).seq;

  // While it runs: the chat reports it, and its messages can't be rewritten.
  const conv = await (await fetch(url(`/api/conversations/${id}`))).json();
  assert.equal(conv.activeRunId, runId);
  const snap = await (await fetch(url(`/api/runs/${runId}`))).json();
  assert.equal(snap.status, "running");
  assert.equal(snap.content, "Hel");
  const put = await json("PUT", `/api/conversations/${id}/messages`, { messages: [] });
  assert.equal(put.status, 409);
  assert.equal((await put.json()).code, "run_in_progress");
  const again = await json("POST", `/api/conversations/${id}/send`, { content: "again" });
  assert.equal(again.status, 409);

  gate.release();
  const final = await waitFor(async () => {
    const s = await (await fetch(url(`/api/runs/${runId}`))).json();
    return s.status === "completed" && s;
  });
  assert.equal(final.content, "Hello");

  const rest = await readAllNdjson(await fetch(url(`/api/runs/${runId}/events?after=${lastSeq}`)));
  assert.deepEqual(rest.map((e) => e.type), ["content", "done"]);
  assert.equal(rest[0].seq, lastSeq + 1);
  const byChat = await readAllNdjson(await fetch(url(`/api/conversations/${id}/run/events?after=0`)));
  assert.equal(byChat.length, final.seq);
  assert.equal(byChat[0].type, "start");

  const { messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json();
  assert.deepEqual(messages.map((m) => m.content), ["hi", "Hello"]);
});

test("cancel stops the run and keeps what was written", async () => {
  newGate();
  const id = await newChat();
  const res = await json("POST", `/api/conversations/${id}/send`, { content: "write a lot", enabledTools: [] });
  const runId = res.headers.get("x-llmui-run-id");
  const streamed = readAllNdjson(res);
  await waitFor(async () => (await (await fetch(url(`/api/runs/${runId}`))).json()).content === "Hel");

  const cancelled = await (await json("POST", `/api/runs/${runId}/cancel`)).json();
  assert.equal(cancelled.status, "cancelled");
  const events = await streamed;
  const last = events.at(-1);
  assert.equal(last.type, "cancelled");
  assert.ok(last.messageId);
  const { messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json();
  assert.deepEqual(messages.map((m) => [m.role, m.content]), [["user", "write a lot"], ["assistant", "Hel"]]);
  assert.equal(messages[1].thinking, "Two plus two is four.");
});

test("regenerate replaces the last reply; no content answers the history as it stands", async () => {
  newGate();
  gate.release();
  const id = await newChat();
  await readAllNdjson(await json("POST", `/api/conversations/${id}/send`, { content: "first", enabledTools: [] }));

  // Nothing to answer: the chat ends with a reply.
  const refused = await json("POST", `/api/conversations/${id}/send`, {});
  assert.equal(refused.status, 400);

  const events = await readAllNdjson(await json("POST", `/api/conversations/${id}/send`, { regenerate: true, enabledTools: [] }));
  assert.equal(events.at(-1).type, "done");
  let { messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json();
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  assert.equal(messages[1].id, events.at(-1).messageId);

  // A chat that ends with a user message (e.g. an edit branch) is answered as is.
  await json("POST", `/api/conversations/${id}/messages`, { role: "user", content: "second" });
  await readAllNdjson(await json("POST", `/api/conversations/${id}/send`, { enabledTools: [] }));
  ({ messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json());
  assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
  assert.deepEqual(upstreamRequests.at(-1).messages.map((m) => m.content), ["first", "Hello", "second"]);
});

test("send validation", async () => {
  const id = await newChat({ model: null });
  assert.equal((await json("POST", `/api/conversations/nope/send`, { content: "x" })).status, 404);
  const noModel = await json("POST", `/api/conversations/${id}/send`, { content: "x" });
  assert.equal(noModel.status, 400);
  assert.match((await noModel.json()).error, /model is required/);
  assert.equal((await json("POST", `/api/conversations/${id}/send`, { content: 5, model: "m" })).status, 400);
  assert.equal((await json("POST", `/api/conversations/${id}/send`, { content: "x", model: "m", enabledTools: "all" })).status, 400);
  assert.equal((await json("POST", `/api/conversations/${id}/send`, { content: "x", model: "m", regenerate: true })).status, 400);
  // Nothing was stored by the refusals.
  const { messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json();
  assert.equal(messages.length, 0);
  assert.equal((await fetch(url(`/api/runs/nope`))).status, 404);
  assert.deepEqual(await (await fetch(url(`/api/conversations/${id}/run`))).json(), { run: null });
});

test("turn settings: request, then chat override, then global; tools never default to all", () => {
  const global = { defaultModel: "g", temperature: 0.7, maxTokens: 2048, systemPrompt: "G", enableThinking: false, enableTools: true, enabledTools: ["calculator"] };
  const conv = { model: null, temperature: 0.2, max_tokens: null, system_prompt: null, enable_thinking: 1 };
  let [s] = resolveTurnSettings({}, conv, global);
  assert.deepEqual(s, { model: "g", temperature: 0.2, maxTokens: 2048, systemPrompt: "G", enableThinking: true, enabledTools: ["calculator"] });
  [s] = resolveTurnSettings({ model: "r", temperature: null, systemPrompt: "", enableThinking: false, enabledTools: [] }, conv, global);
  assert.deepEqual(s, { model: "r", temperature: null, maxTokens: 2048, systemPrompt: "", enableThinking: false, enabledTools: [] });
  [s] = resolveTurnSettings({}, conv, { ...global, enableTools: false });
  assert.deepEqual(s.enabledTools, []);
  assert.equal(resolveTurnSettings({ temperature: 9 }, conv, global)[1], "temperature must be 0-5");
});

test("history for the model: system prompt, images as base64, tool rows and empty replies skipped", () => {
  const out = historyForModel(
    [
      { role: "user", content: "look", images: [{ name: "a.png", type: "image/png", data: "QUJD" }] },
      { role: "assistant", content: "" },
      { role: "tool", content: "{}" },
      { role: "assistant", content: "ok", thinking: "hidden" },
    ],
    "Be brief."
  );
  assert.deepEqual(out, [
    { role: "system", content: "Be brief." },
    { role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:image/png;base64,QUJD" } }] },
    { role: "assistant", content: "ok" },
  ]);
});

test("thinking is stored and returned by the message routes, and copied into branches", async () => {
  const id = await newChat();
  const put = await json("PUT", `/api/conversations/${id}/messages`, {
    messages: [
      { role: "user", content: "q" },
      { role: "assistant", content: "a", thinking: "because" },
    ],
  });
  assert.equal(put.status, 200);
  let { messages } = await (await fetch(url(`/api/conversations/${id}/messages`))).json();
  assert.equal(messages[1].thinking, "because");
  await json("PATCH", `/api/messages/${messages[1].id}`, { thinking: "edited" });
  const posted = await (await json("POST", `/api/conversations/${id}/messages`, { role: "assistant", content: "b", thinking: "more" })).json();
  assert.equal(posted.thinking, "more");
  const branch = await (await json("POST", `/api/conversations/${id}/branch`, { branchAtMessageId: messages[1].id })).json();
  ({ messages } = await (await fetch(url(`/api/conversations/${branch.id}/messages`))).json());
  assert.equal(messages[1].thinking, "edited");
});

// ── which machine wrote each reply ───────────────────────────────────

const getMessages = async (id) => (await (await fetch(url(`/api/conversations/${id}/messages`))).json()).messages;

test("send, regenerate and an edit branch store the machine (and model) on the reply", async () => {
  newGate();
  gate.release();
  const id = await newChat();
  const res = await json("POST", `/api/conversations/${id}/send`, { content: "hi", enabledTools: [] });
  const header = res.headers.get("x-llmui-machine");
  const events = await readAllNdjson(res);
  const machine = events.at(-1).machine;
  assert.equal(machine, "jellyfin");
  assert.equal(header, machine);
  assert.equal(events[0].machine, machine);

  let messages = await getMessages(id);
  assert.deepEqual(messages.map((m) => [m.role, m.machine, m.model ?? null]), [["user", null, null], ["assistant", machine, "test/model:Q4"]]);
  assert.equal((await (await fetch(url(`/api/runs/${events[0].runId}`))).json()).machine, machine);

  // Regenerate.
  await readAllNdjson(await json("POST", `/api/conversations/${id}/send`, { regenerate: true, model: "other/model:Q8", enabledTools: [] }));
  messages = await getMessages(id);
  assert.deepEqual([messages[1].machine, messages[1].model], [machine, "other/model:Q8"]);

  // Edit: branch with edited text, then send with no content.
  const branch = await (await json("POST", `/api/conversations/${id}/branch`, { branchAtMessageId: messages[0].id, editedContent: "hello" })).json();
  await readAllNdjson(await json("POST", `/api/conversations/${branch.id}/send`, { enabledTools: [] }));
  const branched = await getMessages(branch.id);
  assert.deepEqual(branched.map((m) => [m.role, m.content, m.machine]), [["user", "hello", null], ["assistant", "Hello", machine]]);
});

test("a cancelled reply records the machine it fell back to", async () => {
  const id = await newChat();
  getDb().prepare("INSERT INTO messages (id, conversation_id, role, content, created_at, position) VALUES (?, ?, 'user', 'q', ?, 0)").run(`u-${id}`, id, Date.now());
  const run = startRun(
    {
      conversationId: id,
      userMessageId: `u-${id}`,
      settings: { model: "m", enabledTools: [], systemPrompt: "" },
      machine: { id: "jellyfin" },
      history: [{ role: "user", content: "q" }],
    },
    {
      runToolLoop: async ({ track, emit, signal }) => {
        track({ id: "workstation" });
        emit({ type: "content", content: "partial" });
        await new Promise((_, reject) => signal.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError"))));
      },
    }
  );
  run.controller.abort();
  await run.done;
  assert.equal(run.status, "cancelled");
  const messages = await getMessages(id);
  assert.deepEqual([messages[1].content, messages[1].machine], ["partial", "workstation"]);
});

test("machine: null on old rows, kept by PUT and branches, validated on POST, in exports", async () => {
  const id = await newChat();
  // A row written before the column existed: nothing is inferred.
  getDb().prepare("INSERT INTO messages (id, conversation_id, role, content, model, created_at, position) VALUES (?, ?, 'assistant', 'old', 'x', ?, 0)").run(`old-${id}`, id, Date.now());
  let messages = await getMessages(id);
  assert.equal(messages[0].machine, null);
  assert.ok("machine" in messages[0]);

  // The web app saves by PUTting back what it loaded: the machine survives.
  await json("PUT", `/api/conversations/${id}/messages`, {
    messages: [...messages, { role: "user", content: "q" }, { role: "assistant", content: "a", model: "x", machine: "workstation" }],
  });
  messages = await getMessages(id);
  assert.deepEqual(messages.map((m) => m.machine), [null, null, "workstation"]);

  const branch = await (await json("POST", `/api/conversations/${id}/branch`, { branchAtMessageId: messages[2].id })).json();
  assert.deepEqual((await getMessages(branch.id)).map((m) => m.machine), [null, null, "workstation"]);

  const bad = await json("POST", `/api/conversations/${id}/messages`, { role: "assistant", content: "b", machine: 5 });
  assert.equal(bad.status, 400);
  const posted = await (await json("POST", `/api/conversations/${id}/messages`, { role: "assistant", content: "b", machine: "jellyfin" })).json();
  assert.equal(posted.machine, "jellyfin");

  // Export → import keeps it (and the nulls).
  const exported = await (await fetch(url(`/api/export/conversations/${id}`))).json();
  assert.deepEqual(exported.conversations[0].messages.map((m) => m.machine), [null, null, "workstation", "jellyfin"]);
  const before = new Set((await (await fetch(url("/api/conversations"))).json()).conversations.map((c) => c.id));
  await json("POST", "/api/export/import", exported);
  const imported = (await (await fetch(url("/api/conversations"))).json()).conversations.find((c) => !before.has(c.id));
  assert.deepEqual((await getMessages(imported.id)).map((m) => m.machine), [null, null, "workstation", "jellyfin"]);
});
