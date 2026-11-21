import express from 'express';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import { ROLES, appendMessage, listMessages } from '../messageStore.js';
import { activeRunFor } from '../runs.js';

const router = express.Router();

/** 404 unless the conversation exists. Returns true when it does. */
function requireConversation(db, id, res) {
  if (db.prepare('SELECT 1 FROM conversations WHERE id = ?').get(id)) return true;
  res.status(404).json({ error: 'Conversation not found' });
  return false;
}

/**
 * 409 while a server-side run is generating a reply in this chat: writing the
 * message list under it would race the reply it's about to store.
 */
function refuseDuringRun(conversationId, res) {
  const run = activeRunFor(conversationId);
  if (!run) return false;
  res.status(409).json({ error: 'A reply is being generated in this chat; try again when it finishes', code: 'run_in_progress', runId: run.id });
  return true;
}

// GET /api/conversations/:conversationId/messages - List messages
router.get('/conversations/:conversationId/messages', (req, res) => {
  const db = getDb();
  const { conversationId } = req.params;
  if (!requireConversation(db, conversationId, res)) return;
  res.json({ messages: listMessages(db, conversationId) });
});

// POST /api/conversations/:conversationId/messages - Append message
router.post('/conversations/:conversationId/messages', (req, res) => {
  const db = getDb();
  const { conversationId } = req.params;
  if (!requireConversation(db, conversationId, res)) return;
  if (refuseDuringRun(conversationId, res)) return;
  const { id, role, content, model, images, tokensPerSec, toolCalls, timestamp, thinking } = req.body;
  if (!ROLES.includes(role)) {
    return res.status(400).json({ error: 'role must be user, assistant, system or tool' });
  }
  if (thinking !== undefined && thinking !== null && typeof thinking !== 'string') {
    return res.status(400).json({ error: 'thinking must be a string' });
  }
  res.json(appendMessage(db, conversationId, { id, role, content, model, images, tokensPerSec, toolCalls, timestamp, thinking }));
});

// PUT /api/conversations/:conversationId/messages - Bulk replace all messages
// Used by the debounced save pattern
router.put('/conversations/:conversationId/messages', (req, res) => {
  const db = getDb();
  const { conversationId } = req.params;
  if (!requireConversation(db, conversationId, res)) return;
  if (refuseDuringRun(conversationId, res)) return;
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  const deleteAll = db.prepare('DELETE FROM messages WHERE conversation_id = ?');
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls, thinking)
    VALUES (@id, @conversationId, @role, @content, @model, @images, @createdAt, @position, @tokensPerSec, @toolCalls, @thinking)
  `);

  const replaceAll = db.transaction(() => {
    deleteAll.run(conversationId);
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      insertMsg.run({
        id: msg.id || nanoid(),
        conversationId,
        role: msg.role || 'user',
        content: msg.content || '',
        model: msg.model || null,
        images: msg.images ? JSON.stringify(msg.images) : null,
        createdAt: msg.timestamp || Date.now(),
        position: i,
        tokensPerSec: msg.tokensPerSec || null,
        toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
        thinking: typeof msg.thinking === 'string' && msg.thinking ? msg.thinking : null
      });
    }
    // Update conversation
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), conversationId);
  });

  replaceAll();

  res.json({ success: true, count: messages.length });
});

// PATCH /api/messages/:id - Edit message
router.patch('/messages/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { content, tokensPerSec, toolCalls, thinking } = req.body;

  const updates = [];
  const params = [];

  if (content !== undefined) {
    updates.push('content = ?');
    params.push(content);
  }
  if (tokensPerSec !== undefined) {
    updates.push('tokens_per_sec = ?');
    params.push(tokensPerSec);
  }
  if (toolCalls !== undefined) {
    updates.push('tool_calls = ?');
    params.push(JSON.stringify(toolCalls));
  }
  if (thinking !== undefined) {
    updates.push('thinking = ?');
    params.push(thinking || null);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  params.push(id);
  const result = db.prepare(`UPDATE messages SET ${updates.join(', ')} WHERE id = ?`).run(...params);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Message not found' });
  }

  // Update parent conversation timestamp
  const msg = db.prepare('SELECT conversation_id FROM messages WHERE id = ?').get(id);
  if (msg) {
    db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), msg.conversation_id);
  }

  res.json({ success: true });
});

// DELETE /api/messages/:id - Delete message
router.delete('/messages/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { truncateAfter = 'false' } = req.query;

  const msg = db.prepare('SELECT conversation_id, position FROM messages WHERE id = ?').get(id);
  if (!msg) {
    return res.status(404).json({ error: 'Message not found' });
  }
  if (refuseDuringRun(msg.conversation_id, res)) return;

  if (truncateAfter === 'true') {
    // Delete this message and all after it
    db.prepare('DELETE FROM messages WHERE conversation_id = ? AND position >= ?').run(msg.conversation_id, msg.position);
  } else {
    // Delete just this message
    db.prepare('DELETE FROM messages WHERE id = ?').run(id);
    // Reorder remaining messages
    db.prepare(`
      UPDATE messages SET position = position - 1
      WHERE conversation_id = ? AND position > ?
    `).run(msg.conversation_id, msg.position);
  }

  // Update conversation timestamp
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), msg.conversation_id);

  res.json({ success: true });
});

export default router;
