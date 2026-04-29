import express from 'express';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';

const router = express.Router();

// GET /api/conversations/:conversationId/messages - List messages
router.get('/conversations/:conversationId/messages', (req, res) => {
  const db = getDb();
  const { conversationId } = req.params;

  const messages = db.prepare(`
    SELECT id, role, content, model, images, created_at as timestamp,
           position, tokens_per_sec as tokensPerSec, tool_calls as toolCalls
    FROM messages
    WHERE conversation_id = ?
    ORDER BY position ASC
  `).all(conversationId);

  res.json({
    messages: messages.map(m => ({
      ...m,
      images: m.images ? JSON.parse(m.images) : undefined,
      toolCalls: m.toolCalls ? JSON.parse(m.toolCalls) : undefined
    }))
  });
});

// POST /api/conversations/:conversationId/messages - Append message
router.post('/conversations/:conversationId/messages', (req, res) => {
  const db = getDb();
  const { conversationId } = req.params;
  const { id: providedId, role, content, model, images, tokensPerSec, toolCalls, timestamp } = req.body;

  // Get next position
  const lastPos = db.prepare(`
    SELECT COALESCE(MAX(position), -1) as pos FROM messages WHERE conversation_id = ?
  `).get(conversationId);

  const id = providedId || nanoid();
  const position = lastPos.pos + 1;
  const now = timestamp || Date.now();

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id, conversationId, role, content || '',
    model || null,
    images ? JSON.stringify(images) : null,
    now, position,
    tokensPerSec || null,
    toolCalls ? JSON.stringify(toolCalls) : null
  );

  // Update conversation timestamp
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  // Auto-title if first user message and title is "New Chat"
  if (role === 'user' && position === 0) {
    const conv = db.prepare('SELECT title FROM conversations WHERE id = ?').get(conversationId);
    if (conv && conv.title === 'New Chat' && content) {
      const autoTitle = content.slice(0, 30) + (content.length > 30 ? '...' : '');
      db.prepare('UPDATE conversations SET title = ? WHERE id = ?').run(autoTitle, conversationId);
    }
  }

  res.json({
    id,
    role,
    content,
    model,
    images,
    timestamp: now,
    position,
    tokensPerSec,
    toolCalls
  });
});

// PUT /api/conversations/:conversationId/messages - Bulk replace all messages
// Used by the debounced save pattern
router.put('/conversations/:conversationId/messages', (req, res) => {
  const db = getDb();
  const { conversationId } = req.params;
  const { messages } = req.body;

  if (!Array.isArray(messages)) {
    return res.status(400).json({ error: 'messages must be an array' });
  }

  const deleteAll = db.prepare('DELETE FROM messages WHERE conversation_id = ?');
  const insertMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls)
    VALUES (@id, @conversationId, @role, @content, @model, @images, @createdAt, @position, @tokensPerSec, @toolCalls)
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
        toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null
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
  const { content, tokensPerSec, toolCalls } = req.body;

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
