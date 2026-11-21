import { test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { EventLog, streamLog } from "./eventlog.js";
import { listen, readAllNdjson, readAllSse } from "./testHelpers.js";

test("events get sequence numbers; since() and subscribe() see the rest; nothing after the end", () => {
  const log = new EventLog();
  const seen = [];
  log.subscribe((e, ended) => seen.push([e.type, ended]));
  log.push({ type: "a" });
  log.push({ type: "b" });
  assert.deepEqual(log.since(1).map((e) => e.seq), [2]);
  assert.deepEqual(log.since(0).map((e) => e.type), ["a", "b"]);
  log.push({ type: "end" }, { end: true });
  assert.equal(log.push({ type: "late" }), null);
  assert.deepEqual(seen, [["a", false], ["b", false], ["end", true]]);
  assert.equal(log.listeners.size, 0);
});

test("streamLog replays from `after`, follows live, and ends with the log", async () => {
  const log = new EventLog();
  log.push({ type: "one" });
  log.push({ type: "two" });
  const app = express();
  app.get("/n", (req, res) => streamLog(req, res, log, { after: req.query.after }));
  app.get("/s", (req, res) => streamLog(req, res, log, { after: req.query.after, format: "sse" }));
  const server = await listen(app);
  try {
    const pending = fetch(`${server.url}/n?after=1`).then(readAllNdjson);
    setTimeout(() => log.push({ type: "three" }, { end: true }), 30);
    assert.deepEqual((await pending).map((e) => [e.seq, e.type]), [[2, "two"], [3, "three"]]);
    const sse = await (await fetch(`${server.url}/s?after=0`)).text();
    assert.match(sse, /^data: \{"seq":1,"type":"one"\}\n\n/);
    assert.equal((await readAllSse(await fetch(`${server.url}/s?after=2`))).length, 1);
  } finally {
    await server.close();
  }
});
