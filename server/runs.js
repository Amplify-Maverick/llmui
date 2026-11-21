/**
 * Server-side chat runs (docs/api.md §4).
 *
 * POST /api/conversations/:id/send stores the user message, builds the history
 * from the database, runs the model (with tools if enabled) and stores the
 * reply, all on the server. The run doesn't depend on the request that
 * started it: the client watches its event log and may disconnect at any time
 * and reattach later, by run id or by chat id, to get what it missed.
 * Only POST /api/runs/:id/cancel stops a run.
 *
 * POST /api/conversations/:id/compare does the same for two models at once:
 * one user message, two runs in parallel, two stored replies that share a
 * compare group id.
 *
 * Every run is also a row in the `runs` table, written when it starts, about
 * once a second while it streams (the partial reply), and when it ends. On
 * startup, recoverInterruptedRuns() turns rows the last process left
 * "running" into stored replies with status "interrupted". The event log
 * itself lives in memory: a run that ended before this process started is
 * answered from its row (snapshot, and a single end event).
 */

import { Router } from "express";
import { nanoid } from "nanoid";
import { getDb } from "./db/index.js";
import { EventLog, streamLog } from "./eventlog.js";
import { runToolLoop } from "./chatLoop.js";
import { toOpenAIMessage } from "./openai.js";
import { getToolsSchema } from "./tools/index.js";
import { resolveMachine, getMachine } from "./backends.js";
import { isImageJobActive, imageBusyBody, beginChat } from "./sd.js";
import { appendMessage, listMessages } from "./messageStore.js";

/** How long an ended run's event log stays in memory (its row stays in the database). */
export const RUN_RETENTION_MS = 30 * 60 * 1000;
/** How often a running run's partial reply is written to the database. */
export const FLUSH_MS = 1000;
/** Ended run rows older than this are deleted on startup. */
export const RUN_ROW_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const INTERRUPTED_ERROR = "The server restarted while this reply was being written";

/** Sent (not stored) after the partial reply when continuing an interrupted one. */
export const CONTINUE_PROMPT =
  "Your previous reply was cut off. Continue it exactly where it stopped, without repeating anything or commenting on the interruption.";

const runs = new Map(); // run id → run
const latestByConversation = new Map(); // conversation id → [run ids] of its latest turn (two for Compare)

export function getRun(id) {
  return runs.get(id) || null;
}

/** Runs generating replies in this chat right now (two during a Compare). */
export function activeRunsFor(conversationId) {
  return (latestByConversation.get(conversationId) || [])
    .map((id) => runs.get(id))
    .filter((run) => run && run.status === "running");
}

/** A run currently generating a reply in this chat, or null. */
export function activeRunFor(conversationId) {
  return activeRunsFor(conversationId)[0] || null;
}

/** Stop any run in this chat (the chat is being deleted). */
export function cancelRunsFor(conversationId) {
  for (const run of activeRunsFor(conversationId)) run.controller.abort();
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
    continues: run.continues || null,
    compareGroup: run.compareGroup || null,
    compareSlot: run.compareSlot ?? null,
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
    const ids = latestByConversation.get(run.conversationId);
    if (ids?.includes(run.id) && ids.every((id) => id === run.id || !runs.has(id))) {
      latestByConversation.delete(run.conversationId);
    }
  }, RUN_RETENTION_MS).unref?.();
}

// ------------------------------------------------------------
// The runs table
// ------------------------------------------------------------

const parseJson = (s, fallback = null) => {
  if (!s) return fallback;
  try {
    return JSON.parse(s);
  } catch {
    return fallback;
  }
};

/** A runs row → the same snapshot shape as a live run. */
export function rowSnapshot(row) {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    status: row.status,
    model: row.model,
    machine: row.machine_id,
    userMessageId: row.user_message_id,
    messageId: row.status === "running" ? null : row.message_id,
    continues: row.continues ? row.message_id : null,
    compareGroup: row.compare_group,
    compareSlot: row.compare_slot,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    error: row.error,
    seq: row.seq,
    content: row.content,
    thinking: row.thinking,
    toolCalls: parseJson(row.tool_calls, []),
    timings: parseJson(row.timings),
  };
}

const runRow = (id) => getDb().prepare("SELECT * FROM runs WHERE id = ?").get(id);

/** The end event a run that ended before this process started is replayed as. */
export function endEventFor(snap) {
  const base = { messageId: snap.messageId };
  switch (snap.status) {
    case "completed":
      return { type: "done", iterations: null, machine: snap.machine, timings: snap.timings, ...base };
    case "failed":
      return { type: "error", error: snap.error, ...base };
    case "cancelled":
      return { type: "cancelled", ...base };
    default:
      return { type: "interrupted", error: snap.error || INTERRUPTED_ERROR, ...base };
  }
}

function safely(what, run, fn) {
  try {
    fn();
  } catch (err) {
    console.error(`Run ${run.id}: couldn't ${what}:`, err.message);
  }
}

function insertRow(run) {
  safely("record the run", run, () =>
    getDb().prepare(`
      INSERT INTO runs (id, conversation_id, status, model, machine_id, user_message_id, message_id, continues,
        compare_group, compare_slot, content, thinking, tool_calls, seq, started_at, updated_at)
      VALUES (?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      run.id, run.conversationId, run.model, run.machine, run.userMessageId, run.continues || null, run.continues ? 1 : 0,
      run.compareGroup || null, run.compareSlot ?? null, run.content, run.thinking,
      run.toolCalls.length ? JSON.stringify(run.toolCalls) : null, run.log.seq, run.startedAt, Date.now()
    )
  );
}

/** Write the partial reply (and, once ended, the outcome). */
function writeRow(run) {
  run.dirty = false;
  safely("save the partial reply", run, () =>
    getDb().prepare(`
      UPDATE runs SET status = ?, machine_id = ?, content = ?, thinking = ?, tool_calls = ?, seq = ?, updated_at = ?,
        message_id = COALESCE(?, message_id), timings = ?, iterations = ?, error = ?, finished_at = ?
      WHERE id = ?
    `).run(
      run.status, run.machine, run.content, run.thinking, run.toolCalls.length ? JSON.stringify(run.toolCalls) : null,
      run.log.seq, Date.now(), run.messageId, run.timings ? JSON.stringify(run.timings) : null, run.iterations ?? null,
      run.error, run.finishedAt, run.id
    )
  );
}

/** Write every running run's partial reply now (the server is shutting down). */
export function flushRuns() {
  for (const run of runs.values()) if (run.status === "running") writeRow(run);
}

/**
 * On startup: every run the last process left "running" was cut off. Store
 * what it had written as the reply, with status "interrupted" (a continued
 * reply gets its text back with that status), and mark the run interrupted.
 * Also deletes ended run rows older than RUN_ROW_RETENTION_MS. Returns the
 * recovered runs' snapshots.
 */
export function recoverInterruptedRuns(db = getDb(), now = Date.now()) {
  const rows = db.prepare("SELECT * FROM runs WHERE status = 'running' ORDER BY started_at, compare_slot").all();
  const recovered = [];
  for (const row of rows) {
    db.transaction(() => {
      let messageId = null;
      const toolCalls = parseJson(row.tool_calls);
      if (row.continues && row.message_id) {
        const res = db.prepare(`
          UPDATE messages SET content = ?, thinking = ?, tool_calls = ?, model = ?, machine_id = ?, status = 'interrupted'
          WHERE id = ? AND conversation_id = ?
        `).run(row.content, row.thinking || null, row.tool_calls, row.model, row.machine_id, row.message_id, row.conversation_id);
        if (res.changes) messageId = row.message_id;
      } else {
        // Stored even when empty, so the chat shows the cut-off reply with Retry.
        messageId = appendMessage(db, row.conversation_id, {
          role: "assistant",
          content: row.content,
          thinking: row.thinking || null,
          toolCalls: toolCalls?.length ? toolCalls : null,
          model: row.model,
          machine: row.machine_id,
          status: "interrupted",
          compareGroup: row.compare_group,
          compareSlot: row.compare_slot,
        }).id;
      }
      db.prepare("UPDATE runs SET status = 'interrupted', message_id = ?, error = ?, finished_at = ?, updated_at = ? WHERE id = ?")
        .run(messageId, INTERRUPTED_ERROR, now, now, row.id);
    })();
    recovered.push(rowSnapshot(runRow(row.id)));
    console.log(`Run ${row.id} was interrupted by a restart; stored its partial reply (${row.content.length} chars)`);
  }
  db.prepare("DELETE FROM runs WHERE status != 'running' AND COALESCE(finished_at, updated_at) < ?").run(now - RUN_ROW_RETENTION_MS);
  return recovered;
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

/**
 * Stored history → messages for the model. Tool rows and empty assistant rows
 * are skipped. Of a Compare pair only one reply is sent: the picked one, else
 * the one in slot 0.
 */
export function historyForModel(history, systemPrompt) {
  const chosen = new Map(); // compare group → message id sent to the model
  for (const m of history) {
    if (!m.compareGroup || m.role !== "assistant") continue;
    const cur = chosen.get(m.compareGroup);
    if (!cur || (m.picked && !cur.picked) || (!cur.picked && (m.compareSlot ?? 99) < (cur.compareSlot ?? 99))) {
      chosen.set(m.compareGroup, m);
    }
  }
  const out = [];
  if (systemPrompt) out.push({ role: "system", content: systemPrompt });
  for (const m of history) {
    if (!["user", "assistant", "system"].includes(m.role)) continue;
    if (m.role === "assistant" && !m.content) continue;
    if (m.compareGroup && m.role === "assistant" && chosen.get(m.compareGroup)?.id !== m.id) continue;
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
 * `continueMessage`: the stored reply this run carries on (its text is the
 * run's starting point and the model gets it plus CONTINUE_PROMPT).
 * `compare`: { group, slot } for one side of a Compare.
 * `deps` lets tests replace the model loop.
 */
export function startRun({ conversationId, userMessageId, settings, machine, history, continueMessage = null, compare = null }, deps = {}) {
  const run = {
    id: nanoid(),
    conversationId,
    status: "running",
    model: settings.model,
    machine: machine.id,
    userMessageId,
    messageId: null,
    continues: continueMessage?.id || null,
    compareGroup: compare?.group || continueMessage?.compareGroup || null,
    compareSlot: compare ? compare.slot : continueMessage?.compareSlot ?? null,
    startedAt: Date.now(),
    finishedAt: null,
    error: null,
    content: continueMessage?.content || "",
    thinking: continueMessage?.thinking || "",
    toolCalls: continueMessage?.toolCalls ? continueMessage.toolCalls.map((t) => ({ ...t })) : [],
    timings: null,
    iterations: null,
    produced: false, // anything new from the model (a continued reply is only rewritten if so)
    dirty: false,
    log: new EventLog(),
    controller: new AbortController(),
  };
  // Resolves when the run has ended and its reply (if any) is stored.
  run.done = new Promise((resolve) => (run.resolveDone = resolve));
  runs.set(run.id, run);
  // The two sides of a Compare are one turn (a side run again replaces its
  // slot in it); anything else starts a new turn.
  const turn = latestByConversation.get(conversationId) || [];
  const sameCompare = compare && turn.length && runs.get(turn[0])?.compareGroup === compare.group;
  latestByConversation.set(
    conversationId,
    sameCompare ? [...turn.filter((id) => runs.get(id)?.compareSlot !== compare.slot), run.id] : [run.id]
  );

  run.log.push({
    type: "start",
    runId: run.id,
    conversationId,
    userMessageId,
    model: settings.model,
    machine: machine.id,
    ...(run.continues ? { continues: run.continues, content: run.content, thinking: run.thinking } : {}),
    ...(run.compareGroup ? { compareGroup: run.compareGroup, compareSlot: run.compareSlot } : {}),
  });
  insertRow(run);
  const flushTimer = setInterval(() => run.dirty && writeRow(run), deps.flushMs ?? FLUSH_MS);
  flushTimer.unref?.();

  const releases = [beginChat(machine)];
  let thinkingSeparated = !run.thinking;
  const emit = (e) => {
    if (e.type === "thinking" && !thinkingSeparated) {
      // A continued reply's new Think text starts on its own paragraph.
      thinkingSeparated = true;
      e = { ...e, content: `\n\n${e.content}` };
    }
    if (e.type === "content") run.content += e.content;
    else if (e.type === "thinking") run.thinking += e.content;
    else if (e.type === "tool_call") run.toolCalls.push({ id: e.id, name: e.name, arguments: e.arguments, status: "calling" });
    else if (e.type === "tool_result") {
      const tc = run.toolCalls.find((t) => t.id === e.id);
      if (tc) Object.assign(tc, { status: "completed", result: e.result, error: e.error });
    }
    run.produced = true;
    run.dirty = true;
    run.log.push(e);
  };

  /** Store what the model produced (if anything). Returns the message id or null. */
  const save = () => {
    const db = getDb();
    try {
      if (run.continues) {
        if (run.produced) {
          db.prepare(`
            UPDATE messages SET content = ?, thinking = ?, tool_calls = ?, model = ?, machine_id = ?, tokens_per_sec = ?, status = NULL
            WHERE id = ?
          `).run(
            run.content, run.thinking || null, run.toolCalls.length ? JSON.stringify(run.toolCalls) : null,
            run.model, run.machine, run.timings?.predicted_per_second || null, run.continues
          );
        }
        return run.continues;
      }
      if (!run.content && !run.thinking && run.toolCalls.length === 0) return null;
      const msg = appendMessage(db, conversationId, {
        role: "assistant",
        content: run.content,
        thinking: run.thinking || null,
        model: run.model,
        machine: run.machine,
        toolCalls: run.toolCalls.length ? run.toolCalls : null,
        tokensPerSec: run.timings?.predicted_per_second || null,
        compareGroup: run.compareGroup,
        compareSlot: run.compareSlot,
      });
      return msg.id;
    } catch (err) {
      console.error(`Run ${run.id}: couldn't save the reply:`, err.message);
      return null;
    }
  };

  const finish = (status, event) => {
    clearInterval(flushTimer);
    run.status = status;
    run.finishedAt = Date.now();
    run.messageId = save();
    run.log.push({ ...event, messageId: run.messageId }, { end: true });
    writeRow(run);
    for (const release of releases) release();
    forget(run);
    run.resolveDone();
  };

  const messages = historyForModel(history, settings.systemPrompt);
  if (continueMessage) {
    messages.push({ role: "assistant", content: continueMessage.content || "" }, { role: "user", content: CONTINUE_PROMPT });
  }

  (async () => {
    try {
      const result = await (deps.runToolLoop || runToolLoop)({
        machine,
        model: settings.model,
        messages,
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
      run.iterations = result.iterations;
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
// Request helpers
// ------------------------------------------------------------

const badRequest = (message) => Object.assign(new Error(message), { status: 400 });

/**
 * The assistant replies at the end of the chat (after its last user message),
 * oldest first: one reply, or the two of a Compare.
 */
function trailingReplies(history) {
  const out = [];
  for (let i = history.length - 1; i >= 0 && history[i].role === "assistant"; i--) out.unshift(history[i]);
  return out;
}

/**
 * The trailing reply `messageId` names (default: the last message). It must be
 * one of the replies at the end of the chat. Throws a 400 otherwise.
 */
function targetReply(history, messageId, what) {
  const trailing = trailingReplies(history);
  if (!trailing.length) throw badRequest(`Nothing to ${what}: the chat doesn't end with a reply`);
  if (!messageId) {
    if (trailing.length > 1 && trailing.at(-1).compareGroup) {
      throw badRequest(`messageId is required to ${what} one reply of a Compare`);
    }
    return trailing.at(-1);
  }
  const target = trailing.find((m) => m.id === messageId);
  if (!target) throw badRequest(`messageId must be one of the replies at the end of the chat`);
  return target;
}

/** The machine a stored reply came from, if it's still configured. */
const machineOfReply = (m) => (m?.machine && getMachine(m.machine)) || null;

function refuseBusy(res, conversationId) {
  const busy = activeRunFor(conversationId);
  if (!busy) return false;
  res.status(409).json({ error: "A reply is already being generated in this chat", code: "run_in_progress", runId: busy.id });
  return true;
}

/** Validate shared send/compare fields. Returns { sending, images } or throws 400. */
function parseNewMessage(body) {
  const hasContent = body.content !== undefined && body.content !== null;
  if (hasContent && typeof body.content !== "string") throw badRequest("content must be a string");
  const [images, imagesError] = normalizeImages(body.images);
  if (imagesError) throw badRequest(imagesError);
  const sending = hasContent || !!images;
  if (sending && !(body.content || "").trim() && !images) throw badRequest("content is empty");
  if (sending && body.regenerate) throw badRequest("regenerate can't be combined with content");
  if (body.continue !== undefined && body.continue !== null && typeof body.continue !== "boolean") {
    throw badRequest("continue must be true or false");
  }
  if (body.continue && (sending || body.regenerate)) throw badRequest("continue can't be combined with content or regenerate");
  if (body.messageId !== undefined && body.messageId !== null && typeof body.messageId !== "string") {
    throw badRequest("messageId must be a string");
  }
  if (body.messageId && !body.continue && !body.regenerate) throw badRequest("messageId only goes with continue or regenerate");
  return { sending, images };
}

const wantsSse = (req) => req.query.format === "sse";

function sendError(res, err) {
  if (err.status === 400) return res.status(400).json({ error: err.message });
  throw err;
}

// ------------------------------------------------------------
// Routes (mounted at /api behind requireAuth)
// ------------------------------------------------------------

export const runsRouter = Router();

runsRouter.post("/conversations/:id/send", (req, res) => {
  const db = getDb();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (refuseBusy(res, conv.id)) return;

  let sending, images;
  try {
    ({ sending, images } = parseNewMessage(body));
  } catch (err) {
    return sendError(res, err);
  }

  // Continue, or regenerate one reply of a Compare: the reply's own model and
  // machine, unless the request names a model.
  let target = null;
  let history = listMessages(db, conv.id);
  try {
    if (body.continue) target = targetReply(history, body.messageId, "continue");
    else if (body.regenerate && body.messageId) target = targetReply(history, body.messageId, "regenerate");
  } catch (err) {
    return sendError(res, err);
  }
  const keepReplyModel = !!target && (body.continue || !!target.compareGroup);

  const [settings, invalid] = resolveTurnSettings(body, keepReplyModel ? { ...conv, model: target.model || conv.model } : conv, globalSettings(db));
  if (invalid) return res.status(400).json({ error: invalid });

  const machine = (keepReplyModel && machineOfReply(target)) || resolveMachine("chat").machine;
  if (isImageJobActive(machine)) return res.status(409).json(imageBusyBody());

  let userMessageId;
  try {
    db.transaction(() => {
      if (body.regenerate) {
        // Drop the reply being regenerated: the one named, else every trailing reply.
        const doomed = target ? [target] : trailingReplies(history);
        for (const m of doomed) db.prepare("DELETE FROM messages WHERE id = ?").run(m.id);
      }
      if (sending) {
        userMessageId = appendMessage(db, conv.id, { role: "user", content: body.content || "", images }).id;
      }
      history = listMessages(db, conv.id);
      if (body.continue || (body.regenerate && target?.compareGroup)) {
        // Answer from the history before the reply being continued, or before
        // the other side of the Compare whose reply is regenerated.
        history = history.slice(0, history.length - trailingReplies(history).length);
      }
      const last = history[history.length - 1];
      if (!last || last.role !== "user") {
        throw badRequest(
          body.continue
            ? "Nothing to continue: no user message before that reply"
            : "Nothing to reply to: the chat doesn't end with a user message"
        );
      }
      userMessageId ||= last.id;
      if (!keepReplyModel && conv.model !== settings.model) {
        db.prepare("UPDATE conversations SET model = ? WHERE id = ?").run(settings.model, conv.id);
      }
    })();
  } catch (err) {
    return sendError(res, err);
  }

  const compare = body.regenerate && target?.compareGroup ? { group: target.compareGroup, slot: target.compareSlot } : null;
  const run = startRun(
    {
      conversationId: conv.id,
      userMessageId,
      settings,
      machine,
      history,
      continueMessage: body.continue ? target : null,
      compare,
    },
    req.app.locals.runDeps
  );
  res.setHeader("X-LLMUI-Run-Id", run.id);
  res.setHeader("X-LLMUI-Machine", machine.id);
  streamLog(req, res, run.log, { format: wantsSse(req) ? "sse" : "ndjson" });
});

// Compare: one user message, two models answering it in parallel.
runsRouter.post("/conversations/:id/compare", (req, res) => {
  const db = getDb();
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const conv = db.prepare("SELECT * FROM conversations WHERE id = ?").get(req.params.id);
  if (!conv) return res.status(404).json({ error: "Conversation not found" });
  if (refuseBusy(res, conv.id)) return;

  let sending, images;
  try {
    if (body.continue || body.messageId) throw badRequest("continue and messageId go to /send (one reply at a time)");
    ({ sending, images } = parseNewMessage(body));
  } catch (err) {
    return sendError(res, err);
  }

  const sides = body.sides;
  if (!Array.isArray(sides) || sides.length !== 2) return res.status(400).json({ error: "sides must be an array of two {model, machine}" });
  const global = globalSettings(db);
  const resolved = [];
  for (const side of sides) {
    if (!side || typeof side.model !== "string" || !side.model.trim()) {
      return res.status(400).json({ error: "each side needs a model" });
    }
    if (side.machine !== undefined && side.machine !== null && (typeof side.machine !== "string" || !getMachine(side.machine))) {
      return res.status(400).json({ error: `Unknown machine "${side.machine}"` });
    }
    const [settings, invalid] = resolveTurnSettings({ ...body, model: side.model.trim() }, conv, global);
    if (invalid) return res.status(400).json({ error: invalid });
    const machine = side.machine ? getMachine(side.machine) : resolveMachine("chat").machine;
    if (isImageJobActive(machine)) return res.status(409).json({ ...imageBusyBody(), machine: machine.id });
    resolved.push({ settings, machine });
  }

  let userMessageId;
  let history;
  try {
    db.transaction(() => {
      if (body.regenerate) {
        for (const m of trailingReplies(listMessages(db, conv.id))) db.prepare("DELETE FROM messages WHERE id = ?").run(m.id);
      }
      if (sending) userMessageId = appendMessage(db, conv.id, { role: "user", content: body.content || "", images }).id;
      history = listMessages(db, conv.id);
      const last = history[history.length - 1];
      if (!last || last.role !== "user") throw badRequest("Nothing to reply to: the chat doesn't end with a user message");
      userMessageId ||= last.id;
    })();
  } catch (err) {
    return sendError(res, err);
  }

  const group = nanoid();
  const started = resolved.map(({ settings, machine }, slot) =>
    startRun({ conversationId: conv.id, userMessageId, settings, machine, history, compare: { group, slot } }, req.app.locals.runDeps)
  );
  res.status(202).json({ compareGroup: group, userMessageId, runs: started.map(runSnapshot) });
});

/** A run by id: live, else its row. */
function findRun(id) {
  const run = getRun(id);
  if (run) return { run, snap: runSnapshot(run) };
  const row = runRow(id);
  return row ? { run: null, snap: rowSnapshot(row) } : null;
}

/** The chat's latest turn: live runs, else the rows of its latest run (and its Compare partner). */
function latestTurn(conversationId) {
  const live = (latestByConversation.get(conversationId) || []).map((id) => runs.get(id)).filter(Boolean);
  if (live.length) return live.map((run) => ({ run, snap: runSnapshot(run) }));
  const db = getDb();
  const last = db.prepare("SELECT * FROM runs WHERE conversation_id = ? ORDER BY started_at DESC, compare_slot DESC LIMIT 1").get(conversationId);
  if (!last) return [];
  let rows = [last];
  if (last.compare_group) {
    // The latest run of each slot of that Compare.
    const bySlot = new Map();
    for (const row of db.prepare("SELECT * FROM runs WHERE conversation_id = ? AND compare_group = ? ORDER BY started_at DESC")
      .all(conversationId, last.compare_group)) {
      if (!bySlot.has(row.compare_slot)) bySlot.set(row.compare_slot, row);
    }
    rows = [...bySlot.values()].sort((a, b) => (a.compare_slot ?? 0) - (b.compare_slot ?? 0));
  }
  return rows.map((row) => ({ run: null, snap: rowSnapshot(row) }));
}

/** Stream a run's events, or (for one that ended before this process started) its end event. */
function streamRun(req, res, found) {
  res.setHeader("X-LLMUI-Run-Id", found.snap.id);
  const format = wantsSse(req) ? "sse" : "ndjson";
  if (found.run) return streamLog(req, res, found.run.log, { after: req.query.after, format });
  // Its events are gone; the end event carries a seq past anything a client saw.
  const after = Math.max(0, Number(req.query.after) || 0);
  res.setHeader("Content-Type", format === "sse" ? "text/event-stream" : "application/x-ndjson");
  res.setHeader("Cache-Control", "no-cache");
  const e = { seq: Math.max(found.snap.seq, after) + 1, ...endEventFor(found.snap) };
  res.end(format === "sse" ? `data: ${JSON.stringify(e)}\n\n` : JSON.stringify(e) + "\n");
}

const requireChat = (req, res) => {
  if (getDb().prepare("SELECT 1 FROM conversations WHERE id = ?").get(req.params.id)) return true;
  res.status(404).json({ error: "Conversation not found" });
  return false;
};

runsRouter.get("/conversations/:id/run", (req, res) => {
  if (!requireChat(req, res)) return;
  const turn = latestTurn(req.params.id);
  res.set("Cache-Control", "no-store");
  res.json({ run: (turn.find((t) => t.snap.status === "running") || turn[0])?.snap || null });
});

// Every run of the chat's latest turn: one, or the two sides of a Compare.
runsRouter.get("/conversations/:id/runs", (req, res) => {
  if (!requireChat(req, res)) return;
  res.set("Cache-Control", "no-store");
  res.json({ runs: latestTurn(req.params.id).map((t) => t.snap) });
});

// Reattach to a chat's current (or latest) run.
runsRouter.get("/conversations/:id/run/events", (req, res) => {
  const turn = latestTurn(req.params.id);
  const found = turn.find((t) => t.snap.status === "running") || turn[0];
  if (!found) return res.status(404).json({ error: "No run for this chat", code: "no_run" });
  streamRun(req, res, found);
});

runsRouter.get("/runs/:id", (req, res) => {
  const found = findRun(req.params.id);
  if (!found) return res.status(404).json({ error: "Run not found", code: "no_run" });
  res.set("Cache-Control", "no-store");
  res.json(found.snap);
});

runsRouter.get("/runs/:id/events", (req, res) => {
  const found = findRun(req.params.id);
  if (!found) return res.status(404).json({ error: "Run not found", code: "no_run" });
  streamRun(req, res, found);
});

// Stop a run. Whatever it produced so far is stored. Answers once the run has
// ended (or after 10 s, with status still "running").
runsRouter.post("/runs/:id/cancel", async (req, res) => {
  const found = findRun(req.params.id);
  if (!found) return res.status(404).json({ error: "Run not found", code: "no_run" });
  const { run } = found;
  if (run?.status === "running") {
    run.controller.abort();
    await Promise.race([run.done, new Promise((r) => setTimeout(r, 10000).unref?.())]);
  }
  res.json(run ? runSnapshot(run) : found.snap);
});
