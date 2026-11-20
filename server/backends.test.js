import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

// backends.js reads ~/.llmui at import; point HOME at a scratch dir first.
const home = fs.mkdtempSync(path.join(os.tmpdir(), "llmui-backends-"));
process.env.HOME = home;
delete process.env.OPENAI_BASE_URL;
fs.mkdirSync(path.join(home, ".llmui"));
fs.writeFileSync(
  path.join(home, ".llmui", "machines.json"),
  JSON.stringify({ workstation: { llamaUrl: "http://ws.test:8081/v1/", bogus: 1 } })
);

const b = await import("./backends.js");
const { parseKeyFile } = await import("./llama.js");
const { normalizeHelperGpu } = await import("./sdfetch.js");

test.after(() => fs.rmSync(home, { recursive: true, force: true }));

test("jellyfin is the default and the initial selection", () => {
  assert.equal(b.selectedMachine().id, "jellyfin");
  assert.equal(b.resolveMachine("chat").machine.id, "jellyfin");
  assert.equal(b.resolveMachine("image").machine.id, "jellyfin");
  const snap = b.machinesSnapshot();
  assert.deepEqual(snap.effective, { chat: "jellyfin", image: "jellyfin" });
  assert.deepEqual(snap.fallback, { chat: null, image: null });
});

test("overrides apply to known fields only; URLs are normalised", () => {
  const ws = b.getMachine("workstation");
  assert.equal(ws.openaiUrl, "http://ws.test:8081/v1");
  assert.equal(ws.rootUrl, "http://ws.test:8081");
  assert.equal(ws.bogus, undefined);
  assert.equal(ws.fetchTokenPath, path.join(home, ".llmui", "workstation-fetch.token"));
});

test("selection persists and unknown ids are refused", () => {
  assert.throws(() => b.selectMachine("nope"), /Unknown machine/);
  b.selectMachine("workstation");
  const saved = JSON.parse(fs.readFileSync(path.join(home, ".llmui", "machine.json"), "utf-8"));
  assert.equal(saved.selected, "workstation");
  assert.equal(b.resolveMachine("chat").machine.id, "workstation"); // unknown health counts as up
});

test("a down service falls back to jellyfin for that kind only", () => {
  b.selectMachine("workstation");
  const ws = b.getMachine("workstation");
  b.markServiceDown(ws, "chat", "ECONNREFUSED");
  const chat = b.resolveMachine("chat");
  assert.equal(chat.machine.id, "jellyfin");
  assert.equal(chat.fallback.from.id, "workstation");
  assert.equal(chat.fallback.reason, "ECONNREFUSED");
  assert.equal(b.resolveMachine("image").machine.id, "workstation");
  const snap = b.machinesSnapshot();
  assert.deepEqual(snap.fallback.chat, { from: "workstation", reason: "ECONNREFUSED" });
  assert.equal(snap.selected, "workstation");
});

test("selecting jellyfin never reports a fallback, even with the workstation down", () => {
  b.selectMachine("jellyfin");
  b.markServiceDown(b.getMachine("workstation"), "image", "timeout");
  assert.deepEqual(b.machinesSnapshot().fallback, { chat: null, image: null });
});

function runMiddleware(mw, headers = {}) {
  const req = { get: (h) => headers[h] };
  let status = 200;
  let body = null;
  let nextCalled = false;
  const res = {
    status(s) {
      status = s;
      return this;
    },
    json(x) {
      body = x;
      return this;
    },
  };
  mw(req, res, () => (nextCalled = true));
  return { req, status, body, nextCalled };
}

test("routeTo sets req.machine and rejects a stale machine pin", () => {
  b.selectMachine("jellyfin");
  const ok = runMiddleware(b.routeTo("chat"), { "X-LLMUI-Machine": "jellyfin" });
  assert.equal(ok.nextCalled, true);
  assert.equal(ok.req.machine.id, "jellyfin");

  const stale = runMiddleware(b.routeTo("chat"), { "X-LLMUI-Machine": "workstation" });
  assert.equal(stale.nextCalled, false);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.code, "machine_changed");
  assert.equal(stale.body.machine, "jellyfin");

  assert.equal(runMiddleware(b.routeTo("image")).nextCalled, true); // no pin: anything goes
});

test("isConnectError: connection failures only, never client aborts", () => {
  const err = (code) => Object.assign(new TypeError("fetch failed"), { cause: { code } });
  assert.equal(b.isConnectError(err("ECONNREFUSED")), true);
  assert.equal(b.isConnectError(err("UND_ERR_CONNECT_TIMEOUT")), true);
  assert.equal(b.isConnectError(Object.assign(new Error("x"), { name: "AbortError" })), false);
  assert.equal(b.isConnectError(new Error("HTTP 500")), false);
});

test("parseKeyFile accepts a bare key or LLAMA_API_KEY=", () => {
  assert.equal(parseKeyFile("abc123\n"), "abc123");
  assert.equal(parseKeyFile("# c\nexport LLAMA_API_KEY='k1'\n"), "k1");
  assert.equal(parseKeyFile("OTHER=1\nLLAMA_API_KEY=k2"), "k2");
  assert.equal(parseKeyFile("OTHER=1\n"), "");
  assert.equal(parseKeyFile(""), "");
});

test("normalizeHelperGpu maps sd-fetch fields and keeps nulls", () => {
  assert.deepEqual(
    normalizeHelperGpu({ index: 0, name: "RTX 3070", vendor: "nvidia", temp_c: 55, util_pct: 12, vram_used_mib: 900, vram_total_mib: 8192, power_w: 31.5 }),
    { index: 0, name: "RTX 3070", vendor: "nvidia", temperature: 55, utilization: 12, memoryUsed: 900, memoryTotal: 8192, powerDraw: 31.5 }
  );
  assert.deepEqual(
    normalizeHelperGpu({ name: "", temp_c: null, util_pct: "7", power_w: NaN }, 2),
    { index: 2, name: null, vendor: null, temperature: null, utilization: null, memoryUsed: null, memoryTotal: null, powerDraw: null }
  );
});
