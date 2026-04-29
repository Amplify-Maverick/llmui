import express from 'express';
import { getDb } from '../db/index.js';

const router = express.Router();

// GET /api/search?q=...&conversation_id=...
router.get('/', (req, res) => {
  const db = getDb();
  const { q, conversation_id, limit = 50 } = req.query;

  if (!q || q.trim().length === 0) {
    return res.status(400).json({ error: 'Query parameter q is required' });
  }

  // FTS5 query with snippet extraction
  let query = `
    SELECT m.id, m.conversation_id as conversationId, m.role, m.content,
           m.created_at as timestamp, c.title as conversationTitle,
           snippet(messages_fts, 0, '<mark>', '</mark>', '...', 32) as snippet
    FROM messages_fts
    JOIN messages m ON messages_fts.rowid = m.rowid
    JOIN conversations c ON m.conversation_id = c.id
    WHERE messages_fts MATCH ?
  `;

  const params = [q];

  if (conversation_id) {
    query += ' AND m.conversation_id = ?';
    params.push(conversation_id);
  }

  query += ' ORDER BY rank LIMIT ?';
  params.push(parseInt(limit));

  try {
    const results = db.prepare(query).all(...params);
    res.json({ results });
  } catch (err) {
    // FTS5 query syntax error
    res.status(400).json({ error: 'Invalid search query', details: err.message });
  }
});

export default router;
