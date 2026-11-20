/**
 * Compute machines ("backends"): each runs a llama.cpp router, an sd-server
 * and the sd-fetch helper. Jellyfin is the default and is always used unless
 * another machine is explicitly selected (System page); the choice is stored
 * in ~/.llmui/machine.json.
 *
 * Every machine is probed every PROBE_INTERVAL_MS. When the selected machine
 * isn't the default and the service a request needs is down, the request goes
 * to the default machine instead (resolveMachine), and /api/machines reports
 * the fallback so the UI can show it. Selecting or falling back never loads or
 * unloads anything.
 *
 * URLs and names can be overridden per machine in ~/.llmui/machines.json:
 *   { "workstation": { "llamaUrl": "http://host:8081/v1", "name": "..." } }
 * OPENAI_BASE_URL still sets the default machine's router URL. sd-server and
 * sd-fetch URLs are kept in each machine's sd config file (see server/sd.js).
 */

import fs from "fs";
import os from "os";
import path from "path";

export const STORAGE_DIR = path.join(os.homedir(), ".llmui");
const SELECTION_FILE = path.join(STORAGE_DIR, "machine.json");
const OVERRIDES_FILE = path.join(STORAGE_DIR, "machines.json");

export const DEFAULT_MACHINE_ID = "jellyfin";
export const PROBE_INTERVAL_MS = 10000;
const PROBE_TIMEOUT_MS = 4000;

const BUILTIN = [
  {
    id: "jellyfin",
    name: "Jellyfin",
    gpuLabel: "RX 580 8 GB · Vulkan",
    llamaUrl: process.env.OPENAI_BASE_URL || "http://100.118.190.15:8081/v1",
    // LLAMA_API_KEY env var, else LLAMA_API_KEY=... in this file.
    llamaKeyEnv: "LLAMA_API_KEY",
    llamaKeyFile: "llama.env",
    sdUrl: "http://100.118.190.15:8082",
    fetchUrl: "http://100.118.190.15:8083",
    fetchTokenFile: "sd-fetch.token",
    sdConfigFile: "sd_config.json",
    gpuMemoryGiB: 8,
  },
  {
    id: "workstation",
    name: "Workstation",
    gpuLabel: "RTX 3070 8 GB · CUDA",
    llamaUrl: "http://100.126.189.91:8081/v1",
    llamaKeyFile: "workstation-llama.key",
    sdUrl: "http://100.126.189.91:8082",
    fetchUrl: "http://100.126.189.91:8083",
    fetchTokenFile: "workstation-fetch.token",
    sdConfigFile: "sd_config.workstation.json",
    gpuMemoryGiB: 8,
  },
];

const OVERRIDABLE = ["name", "gpuLabel", "llamaUrl", "sdUrl", "fetchUrl", "gpuMemoryGiB"];

function readOverrides() {
  try {
    const data = JSON.parse(fs.readFileSync(OVERRIDES_FILE, "utf-8"));
    return data && typeof data === "object" ? data : {};
  } catch (err) {
    if (err.code !== "ENOENT") console.error(`Ignoring ${OVERRIDES_FILE}:`, err.message);
    return {};
  }
}

function build() {
  const overrides = readOverrides();
  return BUILTIN.map((b) => {
    const o = overrides[b.id] || {};
    const m = { ...b };
    for (const k of OVERRIDABLE) if (o[k] !== undefined) m[k] = o[k];
    if (b.id === DEFAULT_MACHINE_ID && process.env.OPENAI_BASE_URL) m.llamaUrl = process.env.OPENAI_BASE_URL;
    const openaiUrl = String(m.llamaUrl).replace(/\/+$/, "");
    return Object.freeze({
      ...m,
      isDefault: b.id === DEFAULT_MACHINE_ID,
      openaiUrl, // includes /v1
      rootUrl: openaiUrl.replace(/\/v1$/, ""), // router management: /models, /models/load, ...
      llamaKeyPath: path.join(STORAGE_DIR, m.llamaKeyFile),
      fetchTokenPath: path.join(STORAGE_DIR, m.fetchTokenFile),
      sdConfigPath: path.join(STORAGE_DIR, m.sdConfigFile),
    });
  });
}

const MACHINES = build();

export const listMachines = () => MACHINES;
export const getMachine = (id) => MACHINES.find((m) => m.id === id) || null;
export const defaultMachine = () => getMachine(DEFAULT_MACHINE_ID);

// ------------------------------------------------------------
// Selection (persisted)
// ------------------------------------------------------------

function readSelection() {
  try {
    const { selected } = JSON.parse(fs.readFileSync(SELECTION_FILE, "utf-8"));
    return getMachine(selected) ? selected : DEFAULT_MACHINE_ID;
  } catch {
    return DEFAULT_MACHINE_ID;
  }
}

let selectedId = readSelection();

export const selectedMachine = () => getMachine(selectedId);

export function selectMachine(id) {
  if (!getMachine(id)) throw Object.assign(new Error(`Unknown machine "${id}"`), { status: 400 });
  selectedId = id;
  fs.mkdirSync(STORAGE_DIR, { recursive: true });
  const tmp = `${SELECTION_FILE}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ selected: id }, null, 2) + "\n");
  fs.renameSync(tmp, SELECTION_FILE);
  return getMachine(id);
}

// ------------------------------------------------------------
// Health
// ------------------------------------------------------------

// id → { checkedAt, llama: {ok, error}, sd: {ok, error}, fetch: {ok, error} }
const health = new Map();
let probers = null; // { llama(m), sd(m), fetch(m) } → Promise<{ok, error}>; set by startMachineMonitor

const SERVICE_FOR = { chat: "llama", image: "sd" };

/**
 * Where a request of `kind` ("chat" | "image") goes:
 * { machine, fallback: null | { from: machine, reason } }.
 * The selected machine, unless it isn't the default and that service was
 * last seen down; then the default machine. Unknown health counts as up.
 */
export function resolveMachine(kind) {
  const selected = selectedMachine();
  if (selected.isDefault) return { machine: selected, fallback: null };
  const service = health.get(selected.id)?.[SERVICE_FOR[kind]];
  if (service && service.ok === false) {
    return { machine: defaultMachine(), fallback: { from: selected, reason: service.error || "unreachable" } };
  }
  return { machine: selected, fallback: null };
}

/** Record a service as down right away (e.g. a request couldn't connect) and re-probe soon. */
export function markServiceDown(machine, kind, error) {
  const h = { ...(health.get(machine.id) || {}) };
  h[SERVICE_FOR[kind]] = { ok: false, error };
  h.checkedAt = Date.now();
  health.set(machine.id, h);
  if (probers) setTimeout(() => probeMachine(machine).catch(() => {}), 1000);
}

async function settle(fn) {
  try {
    return await fn();
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

export async function probeMachine(machine) {
  if (!probers) return health.get(machine.id) || null;
  const [llama, sd, fetchHelper] = await Promise.all([
    settle(() => probers.llama(machine, PROBE_TIMEOUT_MS)),
    settle(() => probers.sd(machine, PROBE_TIMEOUT_MS)),
    settle(() => probers.fetch(machine, PROBE_TIMEOUT_MS)),
  ]);
  const h = { checkedAt: Date.now(), llama, sd, fetch: fetchHelper };
  health.set(machine.id, h);
  return h;
}

export const probeAll = () => Promise.all(MACHINES.map((m) => probeMachine(m).catch(() => null)));

/** Start probing every machine on an interval. `p` supplies one probe per service. */
export function startMachineMonitor(p) {
  probers = p;
  probeAll();
  const timer = setInterval(probeAll, PROBE_INTERVAL_MS);
  timer.unref?.();
  return () => clearInterval(timer);
}

/** Error text from a fetch() that failed before any response. */
export function networkErrorText(err) {
  return err?.cause?.code || err?.cause?.message || err?.message || String(err);
}

/** True when a fetch() failed to connect at all (so trying another machine is safe). */
export function isConnectError(err) {
  if (!err || err.name === "AbortError") return false;
  const code = err.cause?.code || err.code;
  return [
    "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ENOTFOUND", "EAI_AGAIN",
    "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET", "ECONNRESET",
  ].includes(code);
}

const publicMachine = (m) => ({ id: m.id, name: m.name, gpuLabel: m.gpuLabel, isDefault: m.isDefault });

/** Body of GET /api/machines. */
export function machinesSnapshot() {
  const chat = resolveMachine("chat");
  const image = resolveMachine("image");
  return {
    selected: selectedId,
    defaultId: DEFAULT_MACHINE_ID,
    effective: { chat: chat.machine.id, image: image.machine.id },
    fallback: {
      chat: chat.fallback ? { from: chat.fallback.from.id, reason: chat.fallback.reason } : null,
      image: image.fallback ? { from: image.fallback.from.id, reason: image.fallback.reason } : null,
    },
    machines: MACHINES.map((m) => {
      const h = health.get(m.id) || null;
      return {
        ...publicMachine(m),
        status: h && {
          checkedAt: h.checkedAt,
          online: !!(h.llama?.ok || h.sd?.ok || h.fetch?.ok),
          llama: h.llama,
          sd: h.sd,
          fetch: h.fetch,
        },
      };
    }),
  };
}

export { publicMachine };

/**
 * Express middleware: req.machine = where this `kind` of request goes.
 * A client that pins a machine with X-LLMUI-Machine gets 409 if it no longer
 * matches, so a delete/unload/install never lands on a machine it didn't show.
 */
export function routeTo(kind) {
  return (req, res, next) => {
    if (!req.machine) {
      const { machine, fallback } = resolveMachine(kind);
      req.machine = machine;
      req.machineFallback = fallback;
    }
    const pinned = req.get("X-LLMUI-Machine");
    if (pinned && pinned !== req.machine.id) {
      return res.status(409).json({
        error: `Requests now go to ${req.machine.name}, not ${getMachine(pinned)?.name || pinned}; reload and try again`,
        code: "machine_changed",
        machine: req.machine.id,
      });
    }
    next();
  };
}
