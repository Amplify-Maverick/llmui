import express from 'express';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';

const router = express.Router();

// GET /api/conversations - List conversations with pagination
router.get('/', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, archived = 'false' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const isArchived = archived === 'true' ? 1 : 0;

  const conversations = db.prepare(`
    SELECT id, title, model, tags, created_at as createdAt, updated_at as updatedAt, archived,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount
    FROM conversations
    WHERE archived = ?
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(isArchived, parseInt(limit), offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM conversations WHERE archived = ?').get(isArchived);

  res.json({
    conversations: conversations.map(c => ({
      ...c,
      tags: JSON.parse(c.tags || '[]')
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total.count
    }
  });
});

// POST /api/conversations - Create new conversation
router.post('/', (req, res) => {
  const db = getDb();
  const { model, title = 'New Chat', tags = [] } = req.body;
  const id = nanoid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO conversations (id, title, model, tags, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(id, title, model || null, JSON.stringify(tags), now, now);

  res.json({
    id,
    title,
    model,
    tags,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    archived: 0
  });
});

// GET /api/conversations/:id - Get single conversation
router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const conversation = db.prepare(`
    SELECT id, title, model, tags, created_at as createdAt, updated_at as updatedAt, archived,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount
    FROM conversations
    WHERE id = ?
  `).get(id);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({
    ...conversation,
    tags: JSON.parse(conversation.tags || '[]')
  });
});

// PATCH /api/conversations/:id - Update conversation (rename, tags, archive)
router.patch('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, tags, model, archived } = req.body;

  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }
  if (tags !== undefined) {
    updates.push('tags = ?');
    params.push(JSON.stringify(tags));
  }
  if (model !== undefined) {
    updates.push('model = ?');
    params.push(model);
  }
  if (archived !== undefined) {
    updates.push('archived = ?');
    params.push(archived ? 1 : 0);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  const result = db.prepare(`
    UPDATE conversations SET ${updates.join(', ')} WHERE id = ?
  `).run(...params);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({ success: true });
});

// DELETE /api/conversations/:id - Delete conversation
router.delete('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  // CASCADE will delete messages automatically
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({ success: true });
});

export default router;
