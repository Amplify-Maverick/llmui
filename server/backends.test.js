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
    { index: 0, name: "RTX 3070", vendor: "nvidia", state: "active", temperature: 55, utilization: 12, memoryUsed: 900, memoryTotal: 8192, powerDraw: 31.5 }
  );
  assert.deepEqual(
    normalizeHelperGpu({ name: "", temp_c: null, util_pct: "7", power_w: NaN }, 2),
    { index: 2, name: null, vendor: null, state: "active", temperature: null, utilization: null, memoryUsed: null, memoryTotal: null, powerDraw: null }
  );
});

test("machineFromQuery: only listed requests can name a machine; others are refused", () => {
  const run = (mw, req) => {
    let status = null;
    let nexted = false;
    const res = { status: (s) => ((status = s), { json: () => {} }) };
    mw({ baseUrl: "", ...req }, res, () => (nexted = true));
    return { status, nexted };
  };
  const mw = b.machineFromQuery([
    ["GET", "/models"],
    ["DELETE", /^\/files\/[^/]+$/],
  ]);

  const req = { method: "GET", path: "/models", query: { machine: "workstation" }, baseUrl: "" };
  let status = null;
  let nexted = false;
  mw(req, { status: (s) => ((status = s), { json: () => {} }) }, () => (nexted = true));
  assert.deepEqual({ status, nexted }, { status: null, nexted: true });
  assert.equal(req.machine.id, "workstation");
  assert.equal(req.machineFromQuery, true);

  assert.deepEqual(run(mw, { method: "DELETE", path: "/files/x", query: { machine: "workstation" } }), { status: null, nexted: true });
  // No ?machine: untouched, routed as usual.
  assert.deepEqual(run(mw, { method: "POST", path: "/models/load", query: {} }), { status: null, nexted: true });
  // Naming a machine on anything else is refused, not ignored.
  for (const [method, path] of [["POST", "/models/load"], ["POST", "/models"], ["GET", "/models/sse"], ["DELETE", "/files/a/b"]]) {
    assert.deepEqual(run(mw, { method, path, query: { machine: "workstation" } }), { status: 400, nexted: false }, `${method} ${path}`);
  }
  assert.deepEqual(run(mw, { method: "GET", path: "/models", query: { machine: "nope" } }), { status: 404, nexted: false });
  // The string form is GET-only.
  assert.deepEqual(run(b.machineFromQuery("/models"), { method: "POST", path: "/models", query: { machine: "workstation" } }), { status: 400, nexted: false });
});

test("only the default machine starts with a default image model", async () => {
  const { machineDefaults, dropInheritedDefault, DEFAULT_SD_CONFIG } = await import("./sd.js");
  const jelly = b.getMachine("jellyfin");
  const ws = b.getMachine("workstation");
  assert.equal(machineDefaults(jelly).model, DEFAULT_SD_CONFIG.model);
  assert.equal(machineDefaults(ws).model, null);
  assert.equal(machineDefaults(ws).recipe, null);
  assert.equal(machineDefaults(ws).steps, DEFAULT_SD_CONFIG.steps);

  // A copy of Jellyfin's default in the workstation's file is dropped...
  const copied = { ...DEFAULT_SD_CONFIG, models: {} };
  assert.equal(dropInheritedDefault(ws, copied), true);
  assert.deepEqual([copied.model, copied.recipe], [null, null]);
  // ...but not on Jellyfin, and not a default set up on the workstation itself.
  assert.equal(dropInheritedDefault(jelly, { ...DEFAULT_SD_CONFIG }), false);
  const ownSetup = { ...DEFAULT_SD_CONFIG, models: { [DEFAULT_SD_CONFIG.model]: { recipe: "sd1-checkpoint" } } };
  assert.equal(dropInheritedDefault(ws, ownSetup), false);
  const other = { ...DEFAULT_SD_CONFIG, model: "checkpoints/other.safetensors" };
  assert.equal(dropInheritedDefault(ws, other), false);
});
