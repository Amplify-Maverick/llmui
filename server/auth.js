/**
 * Who may call the API (docs/api.md §2).
 *
 * Three kinds of credentials, checked by requireAuth in this order:
 *
 *  1. Device tokens (`Authorization: Bearer <token>`): one per paired device,
 *     created by POST /api/devices (Settings → Pair iPhone), listed with their
 *     last use and revocable. Only a SHA-256 of each token is stored. A token
 *     nobody has used within PAIRING_WINDOW_MS of its creation expires, so a
 *     QR code that was shown but never scanned stops working.
 *  2. The server token in ~/.llmui/token (also a Bearer token). Never served
 *     over HTTP; local tools (the TUI) read the file.
 *  3. A browser session: an HttpOnly cookie signed with a secret in
 *     ~/.llmui/session_secret, plus the header `X-LLMUI-Web: 1` on every
 *     request. The custom header makes cross-site requests need a CORS
 *     preflight, which only allowed origins pass, so another site can't ride
 *     the cookie. POST /api/session issues the cookie only to a request that
 *     either came through `tailscale serve` with a Tailscale identity (the
 *     Tailscale-User-Login header, which tailscale serve sets from the
 *     tailnet's own record of the caller and strips from what clients send) or
 *     came straight from this host's loopback with no proxy in between.
 *
 * Express must listen on loopback only (HOST=127.0.0.1, the default): the
 * identity header is trusted because only tailscale serve (or a local process,
 * which can read ~/.llmui/token anyway) can reach the port.
 */

import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb } from "./db/index.js";
import { PAIR_VERSION, PAIR_PREFIX, publicUrl, pairingText } from "./pairing.js";

export const SESSION_COOKIE = "llmui_session";
export const WEB_HEADER = "X-LLMUI-Web";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const PAIRING_WINDOW_MS = 10 * 60 * 1000;
const LAST_USED_WRITE_MS = 60 * 1000; // write last_used_at at most this often per device

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
const newToken = () => crypto.randomBytes(32).toString("hex");

function safeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

/** Read a secret file, creating it (0600) with fresh random hex if it doesn't exist. */
export function readOrCreateSecret(file) {
  try {
    const v = fs.readFileSync(file, "utf-8").trim();
    if (v) return v;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const v = newToken();
  fs.writeFileSync(file, v, { mode: 0o600 });
  return v;
}

// ------------------------------------------------------------
// Device tokens
// ------------------------------------------------------------

const lastWrite = new Map(); // device id → ms of the last last_used_at write

const publicDevice = (row, currentId = null) => ({
  id: row.id,
  name: row.name,
  createdAt: row.created_at,
  lastUsedAt: row.last_used_at ?? null,
  current: row.id === currentId,
});

/** Create a device token. Returns { device, token } (the only time the token is visible). */
export function createDevice(name, now = Date.now()) {
  const token = newToken();
  const id = nanoid();
  getDb()
    .prepare("INSERT INTO devices (id, name, token_hash, created_at, last_used_at) VALUES (?, ?, ?, ?, NULL)")
    .run(id, name, sha256(token), now);
  return { device: publicDevice({ id, name, created_at: now, last_used_at: null }), token };
}

export function listDevices(currentId = null) {
  return getDb()
    .prepare("SELECT id, name, created_at, last_used_at FROM devices ORDER BY created_at DESC")
    .all()
    .map((r) => publicDevice(r, currentId));
}

export function revokeDevice(id) {
  lastWrite.delete(id);
  return getDb().prepare("DELETE FROM devices WHERE id = ?").run(id).changes > 0;
}

/** Delete tokens that were never used within the pairing window. */
export function pruneUnusedDevices(now = Date.now()) {
  return getDb()
    .prepare("DELETE FROM devices WHERE last_used_at IS NULL AND created_at < ?")
    .run(now - PAIRING_WINDOW_MS).changes;
}

/** The device a bearer token belongs to (recording the use), or null. */
export function deviceForToken(token, now = Date.now()) {
  if (!/^[0-9a-f]{64}$/.test(token)) return null;
  const db = getDb();
  const row = db.prepare("SELECT id, name, created_at, last_used_at FROM devices WHERE token_hash = ?").get(sha256(token));
  if (!row) return null;
  if (row.last_used_at == null && now - row.created_at > PAIRING_WINDOW_MS) {
    revokeDevice(row.id);
    return null;
  }
  if (row.last_used_at == null || now - (lastWrite.get(row.id) ?? 0) >= LAST_USED_WRITE_MS) {
    db.prepare("UPDATE devices SET last_used_at = ? WHERE id = ?").run(now, row.id);
    lastWrite.set(row.id, now);
  }
  return { id: row.id, name: row.name };
}

// ------------------------------------------------------------
// Browser sessions (signed cookie)
// ------------------------------------------------------------

const b64url = (s) => Buffer.from(s).toString("base64url");

export function signSession(secret, identity, now = Date.now()) {
  const body = `v1.${now + SESSION_TTL_MS}.${b64url(identity)}`;
  return `${body}.${crypto.createHmac("sha256", secret).update(body).digest("base64url")}`;
}

/** The identity a session cookie was issued to, or null if it's forged or expired. */
export function verifySession(secret, value, now = Date.now()) {
  const parts = String(value || "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return null;
  const body = parts.slice(0, 3).join(".");
  const mac = crypto.createHmac("sha256", secret).update(body).digest("base64url");
  if (!safeEqual(mac, parts[3])) return null;
  if (!(Number(parts[1]) > now)) return null;
  try {
    return Buffer.from(parts[2], "base64url").toString("utf-8");
  } catch {
    return null;
  }
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie || "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return null;
}

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * Who a browser asking for a session is, or null if it may not have one.
 * `req.socket.remoteAddress` is the TCP peer: tailscale serve, the Vite dev
 * proxy, or a local browser, all on loopback. Anything else is refused.
 */
export function browserIdentity(req, { allowedUsers = [] } = {}) {
  if (!LOOPBACK.has(req.socket?.remoteAddress)) return null;
  const login = req.get("Tailscale-User-Login");
  if (login) {
    if (allowedUsers.length && !allowedUsers.includes(login)) return null;
    return `tailscale:${login}`;
  }
  // No identity header. Only a request with no proxy hop at all counts as
  // local: tailscale serve adds X-Forwarded-For, so a tailnet request without
  // an identity (a tagged device) is refused.
  if (req.get("X-Forwarded-For") || req.get("Forwarded")) return null;
  return "local";
}

// ------------------------------------------------------------
// Middleware and routes
// ------------------------------------------------------------

/**
 * Build the auth layer. `serverToken` is the ~/.llmui/token value;
 * `sessionSecret` signs browser cookies.
 */
export function createAuth({ serverToken, sessionSecret, allowedUsers = parseUsers(process.env.LLMUI_TAILSCALE_USERS) }) {
  function requireAuth(req, res, next) {
    const header = req.headers.authorization;
    if (header?.startsWith("Bearer ")) {
      const token = header.slice(7).trim();
      if (serverToken && safeEqual(token, serverToken)) {
        req.principal = { kind: "server" };
        return next();
      }
      const device = deviceForToken(token);
      if (device) {
        req.principal = { kind: "device", ...device };
        return next();
      }
      return res.status(401).json({ error: "Unauthorized" });
    }
    const cookie = readCookie(req, SESSION_COOKIE);
    if (cookie && req.get(WEB_HEADER) === "1") {
      const identity = verifySession(sessionSecret, cookie);
      if (identity) {
        req.principal = { kind: "browser", identity };
        return next();
      }
    }
    return res.status(401).json({ error: "Unauthorized" });
  }

  const router = Router();

  // Browser session: sets the cookie for a tailnet user or a local browser.
  router.post("/session", (req, res) => {
    res.set("Cache-Control", "no-store");
    const identity = browserIdentity(req, { allowedUsers });
    if (!identity) {
      return res.status(403).json({
        error: "Open LLMUI through tailscale serve as a tailnet user, or from this machine",
        code: "not_allowed",
      });
    }
    const secure = req.secure || req.get("X-Forwarded-Proto") === "https" || !!req.get("Tailscale-User-Login");
    res.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${encodeURIComponent(signSession(sessionSecret, identity))}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}${secure ? "; Secure" : ""}`
    );
    res.json({ identity });
  });

  // Paired devices (Settings → Devices).
  router.get("/devices", requireAuth, (req, res) => {
    pruneUnusedDevices();
    res.set("Cache-Control", "no-store");
    res.json({ devices: listDevices(req.principal?.kind === "device" ? req.principal.id : null) });
  });

  // Pair a device: a new token for it, plus the QR text that carries it.
  router.post("/devices", requireAuth, (req, res) => {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    if (!name || name.length > 64) return res.status(400).json({ error: "name is required (1-64 characters)" });
    pruneUnusedDevices();
    const { device, token } = createDevice(name);
    const url = publicUrl();
    res.set("Cache-Control", "no-store");
    res.status(201).json({
      device,
      token,
      expiresIfUnusedAt: device.createdAt + PAIRING_WINDOW_MS,
      pairing: { version: PAIR_VERSION, prefix: PAIR_PREFIX, url },
      // null when the server doesn't know its public URL: the browser then
      // builds the text with its own origin.
      text: url ? pairingText(url, token) : null,
    });
  });

  router.delete("/devices/:id", requireAuth, (req, res) => {
    if (!revokeDevice(req.params.id)) return res.status(404).json({ error: "Device not found" });
    res.json({ success: true });
  });

  return { requireAuth, router };
}

function parseUsers(s) {
  return (s || "").split(",").map((x) => x.trim()).filter(Boolean);
}
