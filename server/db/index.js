import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { SCHEMA_SQL, FTS_SCHEMA_SQL, FTS_TRIGGERS_SQL } from './schema.js';

export const STORAGE_DIR = path.join(os.homedir(), '.llmui');
export const DB_PATH = path.join(STORAGE_DIR, 'llmui.db');

let db = null;

export function getDb() {
  if (db) return db;

  // Ensure storage directory exists
  fs.mkdirSync(STORAGE_DIR, { recursive: true });

  // Open database with WAL mode for better concurrent read performance
  db = new Database(DB_PATH);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  // Initialize schema
  db.exec(SCHEMA_SQL);

  // Initialize FTS5 (separate to handle potential errors)
  try {
    db.exec(FTS_SCHEMA_SQL);
    db.exec(FTS_TRIGGERS_SQL);
  } catch (err) {
    // FTS5 might already exist or have issues
    if (!err.message.includes('already exists')) {
      console.warn('FTS5 setup warning:', err.message);
    }
  }

  return db;
}

export function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

// Check if database has any data
export function isDatabaseEmpty() {
  const db = getDb();
  const result = db.prepare('SELECT COUNT(*) as count FROM conversations').get();
  return result.count === 0;
}
