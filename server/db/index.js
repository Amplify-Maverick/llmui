import Database from 'better-sqlite3';
import path from 'path';
import os from 'os';
import fs from 'fs';
import { SCHEMA_SQL, FTS_SCHEMA_SQL, FTS_TRIGGERS_SQL } from './schema.js';
import { runMigrations } from './migrations.js';

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

  // Run migrations first for existing databases (adds new columns before indexes)
  // We need to ensure tables exist first, but without indexes that depend on new columns
  const tableOnlySQL = `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New Chat',
      model TEXT,
      tags TEXT DEFAULT '[]',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      archived INTEGER DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
      content TEXT NOT NULL,
      model TEXT,
      images TEXT,
      created_at INTEGER NOT NULL,
      position INTEGER NOT NULL,
      parent_id TEXT,
      tokens_per_sec REAL,
      tool_calls TEXT,
      FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES messages(id) ON DELETE SET NULL
    );
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `;
  db.exec(tableOnlySQL);

  // Run migrations to add new columns to existing tables
  runMigrations(db);

  // Now apply full schema (will add indexes safely since columns now exist)
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
