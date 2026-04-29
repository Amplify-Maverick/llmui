import express from 'express';
import { getDb } from '../db/index.js';

const router = express.Router();

// GET /api/settings - Get all settings
router.get('/', (req, res) => {
  const db = getDb();
  const rows = db.prepare('SELECT key, value FROM settings').all();

  const settings = {};
  for (const row of rows) {
    try {
      settings[row.key] = JSON.parse(row.value);
    } catch {
      settings[row.key] = row.value;
    }
  }

  res.json(settings);
});

// PUT /api/settings - Replace all settings
router.put('/', (req, res) => {
  const db = getDb();
  const settings = req.body;

  const upsert = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const insertAll = db.transaction(() => {
    for (const [key, value] of Object.entries(settings)) {
      upsert.run(key, JSON.stringify(value));
    }
  });

  insertAll();
  res.json({ success: true });
});

// GET /api/settings/:key - Get single setting
router.get('/:key', (req, res) => {
  const db = getDb();
  const { key } = req.params;

  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  if (!row) {
    return res.json({ data: null });
  }

  try {
    res.json({ data: JSON.parse(row.value) });
  } catch {
    res.json({ data: row.value });
  }
});

// PUT /api/settings/:key - Set single setting
router.put('/:key', (req, res) => {
  const db = getDb();
  const { key } = req.params;
  const { data } = req.body;

  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, JSON.stringify(data));
  res.json({ success: true });
});

// DELETE /api/settings/:key - Delete setting
router.delete('/:key', (req, res) => {
  const db = getDb();
  const { key } = req.params;

  db.prepare('DELETE FROM settings WHERE key = ?').run(key);
  res.json({ success: true });
});

export default router;
