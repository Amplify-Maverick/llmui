// Migrations 7 (messages.machine_id) and 8 (runs, image jobs, message status
// and Compare columns), and the backup taken before migrating.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";
import Database from "better-sqlite3";
import { runMigrations } from "./migrations.js";

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "llmui-migrate-"));

/** A database as it was at schema version 6, with one chat. */
function v6Database(file) {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, model TEXT,
      created_at INTEGER, position INTEGER, thinking TEXT);
    CREATE TABLE image_generations (id TEXT PRIMARY KEY);
    CREATE TABLE schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
    INSERT INTO conversations VALUES ('c1', 'Old chat', 1, 1);
    INSERT INTO messages VALUES ('m1', 'c1', 'user', 'hi', NULL, 1, 0, NULL);
    INSERT INTO messages VALUES ('m2', 'c1', 'assistant', 'hello', 'some/model', 2, 1, NULL);
  `);
  const ins = db.prepare("INSERT INTO schema_migrations VALUES (?, 1, 'old')");
  for (let v = 1; v <= 6; v++) ins.run(v);
  return db;
}

test("migration 7 backs up first, adds machine_id and leaves existing rows null", () => {
  const dir = scratch();
  const backups = path.join(dir, "backups");
  const db = v6Database(path.join(dir, "llmui.db"));
  runMigrations(db, { backupDir: backups });

  const files = fs.readdirSync(backups);
  assert.equal(files.length, 1);
  assert.match(files[0], /^llmui_pre-migration-7-8_.*\.db$/);
  // The backup is the database as it was before the migration.
  const copy = new Database(path.join(backups, files[0]), { readonly: true });
  assert.equal(copy.prepare("SELECT COUNT(*) AS n FROM messages").get().n, 2);
  assert.ok(!copy.prepare("PRAGMA table_info(messages)").all().some((c) => c.name === "machine_id"));
  assert.equal(copy.prepare("SELECT MAX(version) AS v FROM schema_migrations").get().v, 6);
  copy.close();

  assert.deepEqual(db.prepare("SELECT id, machine_id FROM messages ORDER BY position").all(), [
    { id: "m1", machine_id: null },
    { id: "m2", machine_id: null },
  ]);

  // Nothing pending: no new backup.
  runMigrations(db, { backupDir: backups });
  assert.equal(fs.readdirSync(backups).length, 1);
  db.close();
});

test("a brand-new database is migrated without a backup", () => {
  const dir = scratch();
  const backups = path.join(dir, "backups");
  const db = new Database(path.join(dir, "llmui.db"));
  // The base tables getDb() creates before migrating.
  db.exec(`
    CREATE TABLE conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT 'New Chat', created_at INTEGER, updated_at INTEGER);
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, role TEXT, content TEXT, created_at INTEGER, position INTEGER);
  `);
  runMigrations(db, { backupDir: backups });
  assert.ok(!fs.existsSync(backups));
  assert.ok(db.prepare("PRAGMA table_info(messages)").all().some((c) => c.name === "machine_id"));
  db.close();
});

test("migration 8 backs up first, adds runs, image_jobs and message status/Compare columns; old rows untouched", () => {
  const dir = scratch();
  const backups = path.join(dir, "backups");
  const db = v6Database(path.join(dir, "llmui.db"));
  db.exec("ALTER TABLE messages ADD COLUMN machine_id TEXT; UPDATE messages SET machine_id = 'jellyfin' WHERE id = 'm2'");
  db.prepare("INSERT INTO schema_migrations VALUES (7, 1, 'old')").run();
  runMigrations(db, { backupDir: backups });

  const files = fs.readdirSync(backups);
  assert.equal(files.length, 1);
  assert.match(files[0], /^llmui_pre-migration-8_.*\.db$/);
  const copy = new Database(path.join(backups, files[0]), { readonly: true });
  assert.ok(!copy.prepare("SELECT 1 FROM sqlite_master WHERE name = 'runs'").get());
  assert.equal(copy.prepare("SELECT machine_id FROM messages WHERE id = 'm2'").get().machine_id, "jellyfin");
  copy.close();

  const cols = db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name);
  for (const c of ["status", "compare_group", "compare_slot", "compare_picked"]) assert.ok(cols.includes(c), c);
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'runs'").get());
  assert.ok(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'image_jobs'").get());
  assert.deepEqual(db.prepare("SELECT id, machine_id, status, compare_group FROM messages ORDER BY position").all(), [
    { id: "m1", machine_id: null, status: null, compare_group: null },
    { id: "m2", machine_id: "jellyfin", status: null, compare_group: null },
  ]);
  db.close();
});
