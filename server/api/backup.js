import express from 'express';
import fs from 'fs';
import path from 'path';
import { getDb, STORAGE_DIR, DB_PATH } from '../db/index.js';

const router = express.Router();

// POST /api/backup - Create database backup
router.post('/', async (req, res) => {
  const db = getDb();
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupsDir = path.join(STORAGE_DIR, 'backups');
  const backupPath = path.join(backupsDir, `llmui_${timestamp}.db`);

  try {
    // Ensure backups directory exists
    fs.mkdirSync(backupsDir, { recursive: true });

    // Use SQLite's backup API through better-sqlite3
    await db.backup(backupPath);

    res.json({
      success: true,
      path: backupPath,
      timestamp
    });
  } catch (err) {
    res.status(500).json({ error: 'Backup failed', details: err.message });
  }
});

// GET /api/backup/list - List available backups
router.get('/list', (req, res) => {
  const backupsDir = path.join(STORAGE_DIR, 'backups');

  try {
    if (!fs.existsSync(backupsDir)) {
      return res.json({ backups: [] });
    }

    const files = fs.readdirSync(backupsDir)
      .filter(f => f.endsWith('.db'))
      .map(f => {
        const stats = fs.statSync(path.join(backupsDir, f));
        return {
          filename: f,
          path: path.join(backupsDir, f),
          size: stats.size,
          created: stats.mtime.toISOString()
        };
      })
      .sort((a, b) => new Date(b.created) - new Date(a.created));

    res.json({ backups: files });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list backups', details: err.message });
  }
});

export default router;
