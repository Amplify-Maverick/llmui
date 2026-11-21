import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { isolateHome, listen } from "./testHelpers.js";

isolateHome();
const express = (await import("express")).default;
const { getDb } = await import("./db/index.js");
const auth = await import("./auth.js");
const { createAuth, createDevice, deviceForToken, revokeDevice, pruneUnusedDevices, listDevices,
  signSession, verifySession, browserIdentity, PAIRING_WINDOW_MS, SESSION_TTL_MS } = auth;
const { parsePairingText } = await import("./pairing.js");

const SERVER_TOKEN = "f".repeat(64);
const SECRET = "s3cret";
let server;

before(async () => {
  getDb();
  process.env.LLMUI_PUBLIC_URL = "https://box.example.ts.net:8452";
  const { requireAuth, router } = createAuth({ serverToken: SERVER_TOKEN, sessionSecret: SECRET, allowedUsers: [] });
  const app = express();
  app.set("trust proxy", "loopback");
  app.use(express.json());
  app.use("/api", router);
  app.get("/api/whoami", requireAuth, (req, res) => res.json(req.principal));
  server = await listen(app);
});
after(() => server.close());

const call = (path, { headers = {}, ...init } = {}) => fetch(server.url + path, { ...init, headers });
const bearer = (t) => ({ Authorization: `Bearer ${t}` });

test("no credentials, a wrong token, or a cookie without the web header → 401", async () => {
  assert.equal((await call("/api/whoami")).status, 401);
  assert.equal((await call("/api/whoami", { headers: bearer("0".repeat(64)) })).status, 401);
  const cookie = `llmui_session=${encodeURIComponent(signSession(SECRET, "local"))}`;
  assert.equal((await call("/api/whoami", { headers: { Cookie: cookie } })).status, 401);
  assert.equal((await call("/api/whoami", { headers: { Cookie: cookie, "X-LLMUI-Web": "1" } })).status, 200);
  const forged = `llmui_session=${encodeURIComponent(signSession("other", "local"))}`;
  assert.equal((await call("/api/whoami", { headers: { Cookie: forged, "X-LLMUI-Web": "1" } })).status, 401);
});

test("the server token still works (TUI, local tools)", async () => {
  const res = await call("/api/whoami", { headers: bearer(SERVER_TOKEN) });
  assert.deepEqual(await res.json(), { kind: "server" });
});

test("pairing creates a named device token carried in a llmui-pair:v1 QR text; revoking it locks it out", async () => {
  const res = await call("/api/devices", {
    method: "POST",
    headers: { ...bearer(SERVER_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify({ name: " iPhone " }),
  });
  assert.equal(res.status, 201);
  const body = await res.json();
  assert.equal(body.device.name, "iPhone");
  assert.equal(body.device.lastUsedAt, null);
  assert.match(body.token, /^[0-9a-f]{64}$/);
  assert.equal(body.expiresIfUnusedAt, body.device.createdAt + PAIRING_WINDOW_MS);
  assert.deepEqual(parsePairingText(body.text), { url: "https://box.example.ts.net:8452", token: body.token });
  assert.equal(body.pairing.prefix, "llmui-pair:v1:");

  // Only a hash is stored.
  const row = getDb().prepare("SELECT * FROM devices WHERE id = ?").get(body.device.id);
  assert.notEqual(row.token_hash, body.token);
  assert.ok(!JSON.stringify(row).includes(body.token));

  const me = await (await call("/api/whoami", { headers: bearer(body.token) })).json();
  assert.deepEqual(me, { kind: "device", id: body.device.id, name: "iPhone" });
  const list = await (await call("/api/devices", { headers: bearer(body.token) })).json();
  const mine = list.devices.find((d) => d.id === body.device.id);
  assert.equal(mine.current, true);
  assert.ok(mine.lastUsedAt > 0);

  const del = await call(`/api/devices/${body.device.id}`, { method: "DELETE", headers: bearer(SERVER_TOKEN) });
  assert.equal(del.status, 200);
  assert.equal((await call("/api/whoami", { headers: bearer(body.token) })).status, 401);
  assert.equal((await call(`/api/devices/${body.device.id}`, { method: "DELETE", headers: bearer(SERVER_TOKEN) })).status, 404);
});

test("device name is required", async () => {
  for (const name of ["", "  ", "x".repeat(65), 5]) {
    const res = await call("/api/devices", {
      method: "POST",
      headers: { ...bearer(SERVER_TOKEN), "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    assert.equal(res.status, 400);
  }
});

test("a token never used within the pairing window expires; a used one doesn't", () => {
  const t0 = Date.now() - PAIRING_WINDOW_MS - 1000;
  const stale = createDevice("old", t0);
  const used = createDevice("used", t0);
  assert.ok(deviceForToken(used.token, t0 + 1000));
  assert.equal(deviceForToken(stale.token), null);
  assert.ok(deviceForToken(used.token));
  const fresh = createDevice("fresh");
  const stale2 = createDevice("old2", t0);
  assert.equal(pruneUnusedDevices(), 1);
  const names = listDevices().map((d) => d.name);
  assert.ok(names.includes("fresh") && names.includes("used") && !names.includes("old2"));
  revokeDevice(fresh.device.id);
  revokeDevice(used.device.id);
  void stale2;
});

test("session cookies are signed, expire, and carry their identity", () => {
  const v = signSession(SECRET, "tailscale:alice@example.com", 1000);
  assert.equal(verifySession(SECRET, v, 2000), "tailscale:alice@example.com");
  assert.equal(verifySession(SECRET, v, 1000 + SESSION_TTL_MS + 1), null);
  assert.equal(verifySession("x", v, 2000), null);
  assert.equal(verifySession(SECRET, v.replace("v1.", "v1.9"), 2000), null);
  assert.equal(verifySession(SECRET, "garbage"), null);
});

test("who may get a browser session", () => {
  const req = (peer, headers = {}) => ({
    socket: { remoteAddress: peer },
    get: (h) => Object.entries(headers).find(([k]) => k.toLowerCase() === h.toLowerCase())?.[1],
  });
  // tailscale serve (loopback peer) with an identity
  assert.equal(browserIdentity(req("127.0.0.1", { "Tailscale-User-Login": "a@b", "X-Forwarded-For": "100.64.0.2" })), "tailscale:a@b");
  // a browser on the box itself, no proxy
  assert.equal(browserIdentity(req("::1")), "local");
  // tailnet request without an identity (tagged device): proxied, no login
  assert.equal(browserIdentity(req("127.0.0.1", { "X-Forwarded-For": "100.64.0.9" })), null);
  // not via loopback at all (HOST=0.0.0.0): headers aren't trusted
  assert.equal(browserIdentity(req("100.64.0.9", { "Tailscale-User-Login": "a@b" })), null);
  // allow-list
  assert.equal(browserIdentity(req("127.0.0.1", { "Tailscale-User-Login": "eve@x" }), { allowedUsers: ["a@b"] }), null);
});

test("POST /api/session sets an HttpOnly cookie for an allowed browser and refuses others", async () => {
  const ok = await call("/api/session", { method: "POST", headers: { "Tailscale-User-Login": "alice@example.com", "X-Forwarded-For": "100.64.0.2", "X-Forwarded-Proto": "https" } });
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { identity: "tailscale:alice@example.com" });
  const cookie = ok.headers.get("set-cookie");
  assert.match(cookie, /^llmui_session=[^;]+; Path=\/; HttpOnly; SameSite=Strict; Max-Age=\d+; Secure$/);
  const value = cookie.split(";")[0];
  const me = await (await call("/api/whoami", { headers: { Cookie: value, "X-LLMUI-Web": "1" } })).json();
  assert.deepEqual(me, { kind: "browser", identity: "tailscale:alice@example.com" });

  const local = await call("/api/session", { method: "POST" });
  assert.equal(local.status, 200);
  assert.doesNotMatch(local.headers.get("set-cookie"), /Secure/);

  const refused = await call("/api/session", { method: "POST", headers: { "X-Forwarded-For": "100.64.0.9" } });
  assert.equal(refused.status, 403);
  assert.equal(refused.headers.get("set-cookie"), null);
});
