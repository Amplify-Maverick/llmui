/**
 * Message rows ↔ API message objects (docs/api.md §3.7), shared by the
 * messages router and server-side runs.
 */

import { nanoid } from "nanoid";

export const ROLES = ["user", "assistant", "system", "tool"];

export const MESSAGE_COLUMNS = `id, role, content, model, images, created_at as timestamp,
  position, tokens_per_sec as tokensPerSec, tool_calls as toolCalls, thinking, machine_id as machine,
  status, compare_group as compareGroup, compare_slot as compareSlot, compare_picked as picked`;

/** Message statuses the server stores. null = a normal, finished message. */
export const MESSAGE_STATUSES = ["interrupted"];
export const statusOrNull = (v) => (MESSAGE_STATUSES.includes(v) ? v : null);

/**
 * Compare fields of an API message → column values. Only kept when the
 * group id is a non-empty string.
 */
export function compareColumns(msg) {
  const group = typeof msg.compareGroup === "string" && msg.compareGroup.trim() ? msg.compareGroup.trim().slice(0, 64) : null;
  if (!group) return { compareGroup: null, compareSlot: null, picked: null };
  return {
    compareGroup: group,
    compareSlot: Number.isInteger(msg.compareSlot) ? msg.compareSlot : null,
    picked: msg.picked ? 1 : 0,
  };
}

/**
 * A row selected with MESSAGE_COLUMNS → the API object. Absent optional fields
 * are omitted; `machine` is always present (null when it wasn't recorded).
 */
export function toApiMessage(m) {
  const out = {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    timestamp: m.timestamp,
    position: m.position,
    tokensPerSec: m.tokensPerSec,
    machine: m.machine ?? null,
    status: m.status ?? null,
  };
  if (m.compareGroup) {
    out.compareGroup = m.compareGroup;
    out.compareSlot = m.compareSlot ?? null;
    out.picked = m.picked === 1;
  }
  if (m.images) out.images = JSON.parse(m.images);
  if (m.toolCalls) out.toolCalls = JSON.parse(m.toolCalls);
  if (m.thinking) out.thinking = m.thinking;
  return out;
}

/** A machine id as stored: a non-empty string (at most 64 chars), else null. */
export const machineOrNull = (v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 64) : null);

export function listMessages(db, conversationId) {
  return db
    .prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE conversation_id = ? ORDER BY position ASC`)
    .all(conversationId)
    .map(toApiMessage);
}

/**
 * Append one message at the end of a conversation, bump its updated_at, and
 * auto-title it from a first user message while the title is "New Chat".
 * Returns the stored API object.
 */
export function appendMessage(db, conversationId, msg) {
  const { pos } = db
    .prepare("SELECT COALESCE(MAX(position), -1) as pos FROM messages WHERE conversation_id = ?")
    .get(conversationId);
  const id = msg.id || nanoid();
  const position = pos + 1;
  const now = msg.timestamp || Date.now();
  const content = msg.content || "";
  const cmp = compareColumns(msg);
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls, thinking, machine_id,
      status, compare_group, compare_slot, compare_picked)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, conversationId, msg.role, content,
    msg.model || null,
    msg.images ? JSON.stringify(msg.images) : null,
    now, position,
    msg.tokensPerSec || null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.thinking || null,
    machineOrNull(msg.machine),
    statusOrNull(msg.status),
    cmp.compareGroup, cmp.compareSlot, cmp.picked
  );
  db.prepare("UPDATE conversations SET updated_at = ? WHERE id = ?").run(now, conversationId);
  if (msg.role === "user" && position === 0 && content) {
    const conv = db.prepare("SELECT title FROM conversations WHERE id = ?").get(conversationId);
    if (conv?.title === "New Chat") {
      const title = content.slice(0, 30) + (content.length > 30 ? "..." : "");
      db.prepare("UPDATE conversations SET title = ? WHERE id = ?").run(title, conversationId);
    }
  }
  return toApiMessage(
    db.prepare(`SELECT ${MESSAGE_COLUMNS} FROM messages WHERE id = ?`).get(id)
  );
}
