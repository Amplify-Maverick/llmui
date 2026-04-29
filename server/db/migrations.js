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
  }
];

export function runMigrations(db) {
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
