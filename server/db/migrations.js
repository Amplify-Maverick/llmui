import fs from 'fs';
import path from 'path';

// Database migrations for LLMUI
// Migrations are applied in order, tracked by version number

const MIGRATIONS = [
  {
    version: 1,
    description: 'Add branching and per-conversation settings columns',
    up: (db) => {
      // Check if columns already exist before adding
      const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
      const existingColumns = new Set(tableInfo.map(col => col.name));

      // Branching columns
      if (!existingColumns.has('parent_conversation_id')) {
        db.exec('ALTER TABLE conversations ADD COLUMN parent_conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL');
      }
      if (!existingColumns.has('branch_point_message_id')) {
        db.exec('ALTER TABLE conversations ADD COLUMN branch_point_message_id TEXT');
      }

      // Per-conversation settings columns
      if (!existingColumns.has('temperature')) {
        db.exec('ALTER TABLE conversations ADD COLUMN temperature REAL');
      }
      if (!existingColumns.has('max_tokens')) {
        db.exec('ALTER TABLE conversations ADD COLUMN max_tokens INTEGER');
      }
      if (!existingColumns.has('system_prompt')) {
        db.exec('ALTER TABLE conversations ADD COLUMN system_prompt TEXT');
      }
      if (!existingColumns.has('enable_thinking')) {
        db.exec('ALTER TABLE conversations ADD COLUMN enable_thinking INTEGER');
      }

      // Add index for finding branches
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_parent ON conversations(parent_conversation_id)');
      } catch (err) {
        // Index might already exist
      }
    }
  },
  {
    version: 2,
    description: 'Add compare mode support columns',
    up: (db) => {
      const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
      const existingColumns = new Set(tableInfo.map(col => col.name));

      if (!existingColumns.has('is_compare')) {
        db.exec('ALTER TABLE conversations ADD COLUMN is_compare INTEGER DEFAULT 0');
      }
      if (!existingColumns.has('compare_models')) {
        db.exec('ALTER TABLE conversations ADD COLUMN compare_models TEXT');
      }
    }
  },
  {
    version: 3,
    description: 'Add source column to conversations and backfill Telegram chats',
    up: (db) => {
      const tableInfo = db.prepare("PRAGMA table_info(conversations)").all();
      const existingColumns = new Set(tableInfo.map(col => col.name));

      if (!existingColumns.has('source')) {
        db.exec("ALTER TABLE conversations ADD COLUMN source TEXT NOT NULL DEFAULT 'local'");
      }

      // Backfill: tag existing conversations with titles starting with "Telegram:" as telegram source
      db.prepare("UPDATE conversations SET source = 'telegram' WHERE title LIKE 'Telegram:%'").run();

      // Add index for filtering by source
      try {
        db.exec('CREATE INDEX IF NOT EXISTS idx_conversations_source ON conversations(source, updated_at DESC)');
      } catch (err) {
        // Index might already exist
      }
    }
  },
  {
    version: 4,
    description: 'Add image generation tables for ComfyUI integration',
    up: (db) => {
      db.exec(`
        CREATE TABLE IF NOT EXISTS image_generations (
          id TEXT PRIMARY KEY,
          prompt TEXT NOT NULL,
          negative_prompt TEXT DEFAULT '',
          model TEXT,
          width INTEGER NOT NULL,
          height INTEGER NOT NULL,
          steps INTEGER NOT NULL,
          cfg_scale REAL NOT NULL,
          sampler TEXT,
          scheduler TEXT,
          seed INTEGER,
          batch_count INTEGER DEFAULT 1,
          loras TEXT,
          workflow_json TEXT,
          created_at INTEGER NOT NULL
        )
      `);

      db.exec(`
        CREATE TABLE IF NOT EXISTS generated_images (
          id TEXT PRIMARY KEY,
          generation_id TEXT NOT NULL,
          filename TEXT NOT NULL,
          image_data BLOB,
          width INTEGER,
          height INTEGER,
          position INTEGER DEFAULT 0,
          created_at INTEGER NOT NULL,
          FOREIGN KEY (generation_id) REFERENCES image_generations(id) ON DELETE CASCADE
        )
      `);

      db.exec('CREATE INDEX IF NOT EXISTS idx_generations_created ON image_generations(created_at DESC)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_generated_images_gen ON generated_images(generation_id)');
    }
  },
  {
    version: 5,
    description: 'Record machine, recipe and timings with each image generation',
    up: (db) => {
      const existing = new Set(db.prepare("PRAGMA table_info(image_generations)").all().map((c) => c.name));
      for (const [name, type] of [
        ['machine_id', 'TEXT'],
        ['machine_name', 'TEXT'],
        ['recipe', 'TEXT'],
        ['components_json', 'TEXT'],
        ['total_ms', 'INTEGER'],
        ['generate_ms', 'INTEGER'],
      ]) {
        if (!existing.has(name)) db.exec(`ALTER TABLE image_generations ADD COLUMN ${name} ${type}`);
      }
      // Only what was recorded: the machine id some rows kept in workflow_json.
      // Rows without it stay NULL (shown as "unknown"); nothing is inferred.
      db.exec(`
        UPDATE image_generations
        SET machine_id = json_extract(workflow_json, '$.machine')
        WHERE machine_id IS NULL AND json_valid(workflow_json) AND json_extract(workflow_json, '$.machine') IS NOT NULL
      `);
    }
  },
  {
    version: 6,
    description: 'Think text on messages, per-device tokens, image job ids',
    up: (db) => {
      const msgCols = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
      if (!msgCols.has('thinking')) db.exec('ALTER TABLE messages ADD COLUMN thinking TEXT');
      const genCols = new Set(db.prepare("PRAGMA table_info(image_generations)").all().map((c) => c.name));
      if (!genCols.has('job_id')) db.exec('ALTER TABLE image_generations ADD COLUMN job_id TEXT');
      db.exec('CREATE INDEX IF NOT EXISTS idx_generations_job ON image_generations(job_id)');
      db.exec(`
        CREATE TABLE IF NOT EXISTS devices (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          token_hash TEXT NOT NULL UNIQUE,
          created_at INTEGER NOT NULL,
          last_used_at INTEGER
        )
      `);
    }
  },
  {
    version: 7,
    description: 'Record which machine wrote each assistant message',
    up: (db) => {
      const cols = new Set(db.prepare("PRAGMA table_info(messages)").all().map((c) => c.name));
      // Existing rows stay NULL: which machine wrote them was never recorded.
      if (!cols.has('machine_id')) db.exec('ALTER TABLE messages ADD COLUMN machine_id TEXT');
    }
  }
];

/**
 * Copy the database to `backupDir` (VACUUM INTO: a consistent snapshot, WAL
 * included) before applying `pending` migrations. Skipped for a brand-new
 * database. Throws if the copy fails, so nothing is migrated without one.
 */
function backupBeforeMigrating(db, backupDir, pending) {
  const hasConversations = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversations'").get();
  const hasData =
    db.prepare("SELECT 1 FROM schema_migrations LIMIT 1").get() ||
    (hasConversations && db.prepare("SELECT 1 FROM conversations LIMIT 1").get());
  if (!backupDir || !hasData) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(backupDir, `llmui_pre-migration-${pending.map((m) => m.version).join('-')}_${ts}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  console.log(`Backed up the database to ${file} before migrating`);
  return file;
}

export function runMigrations(db, { backupDir } = {}) {
  // Create migrations table if it doesn't exist
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at INTEGER NOT NULL,
      description TEXT
    )
  `);

  // Get applied migrations
  const applied = new Set(
    db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version)
  );

  const pending = MIGRATIONS.filter((m) => !applied.has(m.version));
  if (pending.length) backupBeforeMigrating(db, backupDir, pending);

  // Apply pending migrations in order
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    console.log(`Applying migration ${migration.version}: ${migration.description}`);

    const applyMigration = db.transaction(() => {
      migration.up(db);
      db.prepare(
        'INSERT INTO schema_migrations (version, applied_at, description) VALUES (?, ?, ?)'
      ).run(migration.version, Date.now(), migration.description);
    });

    try {
      applyMigration();
      console.log(`Migration ${migration.version} applied successfully`);
    } catch (err) {
      console.error(`Migration ${migration.version} failed:`, err.message);
      throw err;
    }
  }
}

export function getMigrationStatus(db) {
  try {
    const applied = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    const pending = MIGRATIONS.filter(m => !applied.find(a => a.version === m.version));
    return { applied, pending, currentVersion: applied.length > 0 ? Math.max(...applied.map(a => a.version)) : 0 };
  } catch {
    return { applied: [], pending: MIGRATIONS, currentVersion: 0 };
  }
}
