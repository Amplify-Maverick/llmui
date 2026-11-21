/**
 * Server-side chat runs (docs/api.md §4.1).
 *
 * POST /api/conversations/:id/send stores the user message, builds the history
 * from the database, runs the model (with tools if enabled) and stores the
 * reply, all on the server. The run doesn't depend on the request that
 * started it: the client watches its event log and may disconnect at any time
 * and reattach later, by run id or by chat id, to get what it missed.
 * Only POST /api/runs/:id/cancel stops a run.
 *
 * Runs live in memory. A finished run stays readable for RUN_RETENTION_MS;
 * after that (or after a server restart) the stored messages are the record.
 */

import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb } from "./db/index.js";
import { EventLog, streamLog } from "./eventlog.js";
import { runToolLoop } from "./chatLoop.js";
import { toOpenAIMessage } from "./openai.js";
import { getToolsSchema } from "./tools/index.js";
import { resolveMachine } from "./backends.js";
import { isImageJobActive, imageBusyBody, beginChat } from "./sd.js";
import { appendMessage, listMessages } from "./messageStore.js";

export const RUN_RETENTION_MS = 30 * 60 * 1000;

const runs = new Map(); // run id → run
const latestByConversation = new Map(); // conversation id → run id (active or most recent)

export function getRun(id) {
  return runs.get(id) || null;
}

/** The run currently generating a reply in this chat, or null. */
export function activeRunFor(conversationId) {
  const run = runs.get(latestByConversation.get(conversationId));
  return run && run.status === "running" ? run : null;
}

/** The active run for this chat, else the most recent one still kept, else null. */
export function latestRunFor(conversationId) {
  return runs.get(latestByConversation.get(conversationId)) || null;
}

/** Stop any run in this chat (the chat is being deleted). */
export function cancelRunsFor(conversationId) {
  const run = activeRunFor(conversationId);
  if (run) run.controller.abort();
}

export function runSnapshot(run) {
  return {
    id: run.id,
    conversationId: run.conversationId,
    status: run.status,
    model: run.model,
    machine: run.machine,
    userMessageId: run.userMessageId,
    messageId: run.messageId,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    seq: run.log.seq,
    content: run.content,
    thinking: run.thinking,
    toolCalls: run.toolCalls,
    timings: run.timings,
  };
}

function forget(run) {
  setTimeout(() => {
    runs.delete(run.id);
    if (latestByConversation.get(run.conversationId) === run.id) latestByConversation.delete(run.conversationId);
  }, RUN_RETENTION_MS).unref?.();
}

// ------------------------------------------------------------
// Settings for a turn
// ------------------------------------------------------------

function globalSettings(db) {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'llmui_settings'").get();
  try {
    return (row && JSON.parse(row.value)) || {};
  } catch {
    return {};
  }
}

const numOrNull = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

/**
 * What this turn runs with: the request's value if it sent one, else the
 * chat's override, else the global setting (§10.1). Returns [settings, error].
 */
export function resolveTurnSettings(body, conv, global) {
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  const model = (typeof body.model === "string" && body.model.trim()) || conv.model || global.defaultModel || null;
  if (!model) return [null, "model is required (no model in the request, the chat or the settings)"];

  let enabledTools;
  if (has("enabledTools") && body.enabledTools !== null) {
    if (!Array.isArray(body.enabledTools) || body.enabledTools.some((t) => typeof t !== "string")) {
      return [null, "enabledTools must be an array of tool names"];
    }
    enabledTools = body.enabledTools;
  } else {
    enabledTools = global.enableTools && Array.isArray(global.enabledTools) ? global.enabledTools : [];
  }

  const convThinking = conv.enable_thinking === 1 ? true : conv.enable_thinking === 0 ? false : null;
  const temperature = has("temperature") ? numOrNull(body.temperature) : conv.temperature ?? numOrNull(global.temperature);
  const maxTokens = has("maxTokens") ? numOrNull(body.maxTokens) : conv.max_tokens ?? numOrNull(global.maxTokens);
  if (temperature !== null && !(temperature >= 0 && temperature <= 5)) return [null, "temperature must be 0-5"];
  if (maxTokens !== null && !(Number.isInteger(maxTokens) && maxTokens > 0)) return [null, "maxTokens must be a positive integer"];
  const systemPrompt = has("systemPrompt") ? body.systemPrompt : conv.system_prompt ?? global.systemPrompt ?? "";
  if (systemPrompt !== null && typeof systemPrompt !== "string") return [null, "systemPrompt must be a string"];

  return [
    {
      model,
      enableThinking: has("enableThinking") && body.enableThinking !== null ? !!body.enableThinking : convThinking ?? !!global.enableThinking,
      enabledTools,
      temperature,
      maxTokens,
      systemPrompt: systemPrompt || "",
    },
    null,
  ];
}

/** Stored image attachments (or bare base64 strings) → the stored object shape. */
function normalizeImages(images) {
  if (images === undefined || images === null) return [null, null];
  if (!Array.isArray(images)) return [null, "images must be an array"];
  const out = [];
  for (const img of images) {
    if (typeof img === "string" && img) out.push({ name: "image", type: "image/png", data: img.replace(/^data:[^,]*,/, "") });
    else if (img && typeof img.data === "string" && img.data) {
      out.push({
        name: typeof img.name === "string" ? img.name : "image",
        type: typeof img.type === "string" ? img.type : "image/png",
        ...(Number.isFinite(img.size) ? { size: img.size } : {}),
        data: img.data.replace(/^data:[^,]*,/, ""),
      });
    } else return [null, "each image must be a base64 string or {name, type, data}"];
  }
  return [out.length ? out : null, null];
}

/** Stored history → messages for the model. Tool rows and empty assistant rows are skipped. */
export function historyForModel(history, systemPrompt) {
  const out = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of history) {
    if (!["user", "assistant", "system"].includes(m.role)) continue;
    if (m.role === "assistant" && !m.content) continue;
    const images = (m.images || []).map((i) => (typeof i === "string" ? i : i?.data)).filter(Boolean);
    out.push(toOpenAIMessage({ role: m.role, content: m.content || "", images }));
  }
  return out;
}

// ------------------------------------------------------------
// Running
// ------------------------------------------------------------

/**
 * Start a run. Everything that can be refused has been checked; `history` is
 * the stored conversation ending in the user message to answer.
 * `deps` lets tests replace the model loop.
 */
export function startRun({ conversationId, userMessageId, settings, machine, history }, deps = {}) {
  const run = {
    id: nanoid(),
    conversationId,
    status: "running",
    model: settings.model,
    machine: machine.id,
    userMessageId,
    messageId: null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    content: "",
    thinking: "",
    toolCalls: [],
    timings: null,
    log: new EventLog(),
    controller: new AbortController(),
  };
  // Resolves when the run has ended and its reply (if any) is stored.
  run.done = new Promise((resolve) => (run.resolveDone = resolve));
  runs.set(run.id, run);
  latestByConversation.set(conversationId, run.id);

  run.log.push({ type: "start", runId: run.id, conversationId, userMessageId, model: settings.model, machine: machine.id });

  const releases = [beginChat(machine)];
  const emit = (e) => {
    if (e.type === "content") run.content += e.content;
    else if (e.type === "thinking") run.thinking += e.content;
    else if (e.type === "tool_call") run.toolCalls.push({ id: e.id, name: e.name, arguments: e.arguments, status: "calling" });
    else if (e.type === "tool_result") {
      const tc = run.toolCalls.find((t) => t.id === e.id);
      if (tc) Object.assign(tc, { status: "completed", result: e.result, error: e.error });
    }
    run.log.push(e);
  };

  /** Store what the model produced (if anything). Returns the message id or null. */
  const save = () => {
    if (!run.content && !run.thinking && run.toolCalls.length === 0) return null;
    try {
      const msg = appendMessage(getDb(), conversationId, {
        role: "assistant",
        content: run.content,
        thinking: run.thinking || null,
        model: run.model,
        machine: run.machine,
        toolCalls: run.toolCalls.length ? run.toolCalls : null,
        tokensPerSec: run.timings?.predicted_per_second || null,
      });
      return msg.id;
    } catch (err) {
      console.error(`Run ${run.id}: couldn't save the reply:`, err.message);
      return null;
    }
  };

  const finish = (status, event) => {
    run.status = status;
    run.finishedAt = Date.now();
    run.messageId = save();
    run.log.push({ ...event, messageId: run.messageId }, { end: true });
    for (const release of releases) release();
    forget(run);
    run.resolveDone();
  };

  (async () => {
    try {
      const result = await (deps.runToolLoop || runToolLoop)({
        machine,
        model: settings.model,
        messages: historyForModel(history, settings.systemPrompt),
        tools: getToolsSchema(settings.enabledTools),
        modelOptions: { temperature: settings.temperature, num_predict: settings.maxTokens },
        enableThinking: settings.enableThinking,
        signal: run.controller.signal,
        // A turn fell back to another machine: that's where the reply now comes from.
        track: (m) => {
          run.machine = m.id;
          releases.push(beginChat(m));
        },
        emit,
      });
      run.timings = result.timings;
      run.machine = result.machine.id;
      finish("completed", { type: "done", iterations: result.iterations, machine: result.machine.id, timings: result.timings });
    } catch (err) {
      if (err.name === "AbortError" || run.controller.signal.aborted) {
        finish("cancelled", { type: "cancelled" });
      } else {
        run.error = err.message || "Chat failed";
        if (err.code !== "max_iterations") console.error(`Run ${run.id} failed:`, run.error);
        finish("failed", { type: "error", error: run.error });
      }
    }
  })();

  return run;
}

// ------------------------------------------------------------
// Routes (mounted at /api behind requireAuth)
// ------------------------------------------------------------

export const runsRouter = Router();

const wantsSse = (req) => req.query.format === "sse";

runsRouter.post("/conversations/:id/send", (req, res) => {
  const db = getDb();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  const busy = activeRunFor(conv.id);
  if (busy) {
    return res.status(409).json({ error: "A reply is already being generated in this chat", code: "run_in_progress", runId: busy.id });
  }

  const hasContent = body.content !== undefined && body.content !== null;
  if (hasContent && typeof body.content !== "string") return res.status(400).json({ error: "content must be a string" });
  const [images, imagesError] = normalizeImages(body.images);
  if (imagesError) return res.status(400).json({ error: imagesError });
  const sending = hasContent || !!images;
  if (sending && !(body.content || "").trim() && !images) return res.status(400).json({ error: "content is empty" });
  if (sending && body.regenerate) return res.status(400).json({ error: "regenerate can't be combined with content" });

  const [settings, invalid] = resolveTurnSettings(body, conv, globalSettings(db));
  if (invalid) return res.status(400).json({ error: invalid });

  const { machine } = resolveMachine("chat");
  if (isImageJobActive(machine)) return res.status(409).json(imageBusyBody());

  let userMessageId;
  let history;
  try {
    db.transaction(() => {
      if (body.regenerate) {
        // Drop the trailing assistant reply (or replies) being regenerated.
        const rows = db.prepare("SELECT id, role FROM messages WHERE conversation_id = ? ORDER BY position DESC").all(conv.id);
        for (const r of rows) {
          if (r.role !== "assistant") break;
          db.prepare("DELETE FROM messages WHERE id = ?").run(r.id);
        }
      }
      if (sending) {
        userMessageId = appendMessage(db, conv.id, { role: "user", content: body.content || "", images }).id;
      }
      history = listMessages(db, conv.id);
      const last = history[history.length - 1];
      if (!last || last.role !== "user") {
        throw Object.assign(new Error("Nothing to reply to: the chat doesn't end with a user message"), { status: 400 });
      }
      userMessageId ||= last.id;
      if (conv.model !== settings.model) {
        db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(settings.model, conv.id);
      }
    })();
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: err.message });
    throw err;
  }

  const run = startRun({ conversationId: conv.id, userMessageId, settings, machine, history }, req.app.locals.runDeps);
  res.setHeader("X-LLMUI-Run-Id", run.id);
  res.setHeader("X-LLMUI-Machine", machine.id);
  streamLog(req, res, run.log, { format: wantsSse(req) ? "sse" : "ndjson" });
});

runsRouter.get("/conversations/:id/run", (req, res) => {
  if (!getDb().prepare("SELECT 1 FROM conversations WHERE id = ?").get(req.params.id)) {
    return res.status(404).json({ error: "Conversation not found" });
  }
  const run = latestRunFor(req.params.id);
  res.set("Cache-Control", "no-store");
  res.json({ run: run ? runSnapshot(run) : null });
});

// Reattach to a chat's current (or latest kept) run.
runsRouter.get("/conversations/:id/run/events", (req, res) => {
  const run = latestRunFor(req.params.id);
  if (!run) return res.status(404).json({ error: "No run for this chat", code: "no_run" });
  res.setHeader("X-LLMUI-Run-Id", run.id);
  streamLog(req, res, run.log, { after: req.query.after, format: wantsSse(req) ? "sse" : "ndjson" });
});

runsRouter.get("/runs/:id", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found", code: "no_run" });
  res.set("Cache-Control", "no-store");
  res.json(runSnapshot(run));
});

runsRouter.get("/runs/:id/events", (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found", code: "no_run" });
  res.setHeader("X-LLMUI-Run-Id", run.id);
  streamLog(req, res, run.log, { after: req.query.after, format: wantsSse(req) ? "sse" : "ndjson" });
});

// Stop a run. Whatever it produced so far is stored. Answers once the run has
// ended (or after 10 s, with status still "running").
runsRouter.post("/runs/:id/cancel", async (req, res) => {
  const run = getRun(req.params.id);
  if (!run) return res.status(404).json({ error: "Run not found", code: "no_run" });
  if (run.status === "running") {
    run.controller.abort();
    await Promise.race([run.done, new Promise((r) => setTimeout(r, 10000).unref?.())]);
  }
  res.json(runSnapshot(run));
});
