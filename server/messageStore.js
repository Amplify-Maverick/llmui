/**
 * Message rows ↔ API message objects (docs/api.md §3.7), shared by the
 * messages router and server-side runs.
 */

import { nanoid } from "nanoid";

export const ROLES = ["user", "assistant", "system", "tool"];

export const MESSAGE_COLUMNS = `id, role, content, model, images, created_at as timestamp,
  position, tokens_per_sec as tokensPerSec, tool_calls as toolCalls, thinking`;

/** A row selected with MESSAGE_COLUMNS → the API object. Absent optional fields are omitted. */
export function toApiMessage(m) {
  const out = {
    id: m.id,
    role: m.role,
    content: m.content,
    model: m.model,
    timestamp: m.timestamp,
    position: m.position,
    tokensPerSec: m.tokensPerSec,
  };
  if (m.images) out.images = JSON.parse(m.images);
  if (m.toolCalls) out.toolCalls = JSON.parse(m.toolCalls);
  if (m.thinking) out.thinking = m.thinking;
  return out;
}

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
  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls, thinking)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, conversationId, msg.role, content,
    msg.model || null,
    msg.images ? JSON.stringify(msg.images) : null,
    now, position,
    msg.tokensPerSec || null,
    msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
    msg.thinking || null
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
