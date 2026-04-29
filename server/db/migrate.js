import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import { getDb, STORAGE_DIR, isDatabaseEmpty } from './index.js';

const LEGACY_FILES = {
  convIndex: 'llmui_conv_index.json',
  conversations: 'llmui_conversations.json',
  settings: 'llmui_settings.json',
  activeConversation: 'llmui_active_conversation.json'
};

// Helper to safely read and parse JSON file
async function readJsonFile(filePath) {
  try {
    const data = await fsp.readFile(filePath, 'utf-8');
    const parsed = JSON.parse(data);
    return parsed.data !== undefined ? parsed.data : parsed;
  } catch (err) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// List all llmui_conv_*.json files (message files)
async function listConversationMessageFiles() {
  try {
    const files = await fsp.readdir(STORAGE_DIR);
    return files.filter(f =>
      f.startsWith('llmui_conv_') &&
      f.endsWith('.json') &&
      f !== LEGACY_FILES.convIndex
    );
  } catch {
    return [];
  }
}

export async function checkAndMigrate(options = { dryRun: false }) {
  const log = [];
  const logMsg = (msg) => {
    log.push(msg);
    console.log(`[Migration] ${msg}`);
  };

  // Initialize DB (creates tables if needed)
  const db = getDb();

  // Check if DB already has data
  if (!isDatabaseEmpty()) {
    logMsg('Database already contains data, skipping migration');
    return { migrated: false, log };
  }

  // Check for JSON files
  const indexPath = path.join(STORAGE_DIR, LEGACY_FILES.convIndex);
  const legacyPath = path.join(STORAGE_DIR, LEGACY_FILES.conversations);

  let index = null;
  let legacyConversations = null;

  // Try new split format first (llmui_conv_index.json)
  index = await readJsonFile(indexPath);
  if (index && Array.isArray(index) && index.length > 0) {
    logMsg(`Found ${index.length} conversations in split-format index`);
  }

  // Fall back to legacy single-blob format (llmui_conversations.json)
  if (!index) {
    legacyConversations = await readJsonFile(legacyPath);
    if (legacyConversations && Array.isArray(legacyConversations) && legacyConversations.length > 0) {
      logMsg(`Found ${legacyConversations.length} conversations in legacy format`);
      // Build index from legacy data
      index = legacyConversations.map(c => ({
        id: c.id,
        title: c.title || 'New Chat',
        model: c.model,
        tags: c.tags || [],
        messageCount: c.messages?.length || 0,
        createdAt: c.createdAt || Date.now(),
        updatedAt: c.updatedAt || Date.now()
      }));
    }
  }

  // No data to migrate
  if (!index || index.length === 0) {
    // Check if there are any orphaned message files
    const msgFiles = await listConversationMessageFiles();
    if (msgFiles.length === 0) {
      logMsg('No conversations found to migrate');
      return { migrated: false, log };
    }
    logMsg(`Found ${msgFiles.length} orphaned message files without index`);
    // Build index from message files
    index = [];
    for (const file of msgFiles) {
      const match = file.match(/^llmui_conv_(.+)\.json$/);
      if (match) {
        const id = match[1];
        const messages = await readJsonFile(path.join(STORAGE_DIR, file));
        index.push({
          id,
          title: messages?.[0]?.content?.slice(0, 30) || 'Recovered Chat',
          model: null,
          tags: [],
          messageCount: messages?.length || 0,
          createdAt: messages?.[0]?.timestamp || Date.now(),
          updatedAt: messages?.[messages?.length - 1]?.timestamp || Date.now()
        });
      }
    }
  }

  if (options.dryRun) {
    logMsg('[DRY RUN] Would migrate the following:');
    for (const conv of index) {
      logMsg(`  - ${conv.id}: "${conv.title}" (${conv.messageCount} messages)`);
    }

    const settingsPath = path.join(STORAGE_DIR, LEGACY_FILES.settings);
    if (fs.existsSync(settingsPath)) {
      logMsg('  - Settings file');
    }

    const activePath = path.join(STORAGE_DIR, LEGACY_FILES.activeConversation);
    if (fs.existsSync(activePath)) {
      logMsg('  - Active conversation setting');
    }

    return { migrated: false, dryRun: true, log };
  }

  // Prepare statements
  const insertConv = db.prepare(`
    INSERT INTO conversations (id, title, model, tags, created_at, updated_at, archived)
    VALUES (@id, @title, @model, @tags, @createdAt, @updatedAt, 0)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls)
    VALUES (@id, @conversationId, @role, @content, @model, @images, @createdAt, @position, @tokensPerSec, @toolCalls)
  `);

  const insertSetting = db.prepare(`
    INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)
  `);

  // Load all message data before starting transaction
  const messagesMap = new Map();
  for (const convMeta of index) {
    let messages = null;

    // Check if messages are inline (legacy format)
    if (legacyConversations) {
      const legacyConv = legacyConversations.find(c => c.id === convMeta.id);
      if (legacyConv?.messages) {
        messages = legacyConv.messages;
      }
    }

    // Otherwise load from individual file
    if (!messages) {
      const msgPath = path.join(STORAGE_DIR, `llmui_conv_${convMeta.id}.json`);
      messages = await readJsonFile(msgPath);
    }

    messagesMap.set(convMeta.id, messages || []);
  }

  // Run synchronous transaction
  const migrateAll = db.transaction(() => {
    for (const convMeta of index) {
      // Insert conversation
      insertConv.run({
        id: convMeta.id,
        title: convMeta.title || 'New Chat',
        model: convMeta.model || null,
        tags: JSON.stringify(convMeta.tags || []),
        createdAt: convMeta.createdAt || Date.now(),
        updatedAt: convMeta.updatedAt || Date.now()
      });

      // Insert messages
      const messages = messagesMap.get(convMeta.id) || [];
      for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        insertMsg.run({
          id: msg.id,
          conversationId: convMeta.id,
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

      logMsg(`Migrated: ${convMeta.id} - "${convMeta.title}" (${messages.length} messages)`);
    }
  });

  migrateAll();

  // Migrate settings
  const settingsPath = path.join(STORAGE_DIR, LEGACY_FILES.settings);
  const settings = await readJsonFile(settingsPath);
  if (settings) {
    insertSetting.run('llmui_settings', JSON.stringify(settings));
    logMsg('Migrated settings');
  }

  // Migrate active conversation
  const activePath = path.join(STORAGE_DIR, LEGACY_FILES.activeConversation);
  const activeId = await readJsonFile(activePath);
  if (activeId) {
    insertSetting.run('llmui_active_conversation', JSON.stringify(activeId));
    logMsg(`Migrated active conversation: ${activeId}`);
  }

  // Move JSON files to backup folder
  const timestamp = Date.now();
  const backupDir = path.join(STORAGE_DIR, `legacy_backup_${timestamp}`);
  await fsp.mkdir(backupDir, { recursive: true });

  const allFiles = await fsp.readdir(STORAGE_DIR);
  for (const file of allFiles) {
    if (file.endsWith('.json')) {
      const src = path.join(STORAGE_DIR, file);
      const dest = path.join(backupDir, file);
      await fsp.rename(src, dest);
      logMsg(`Backed up: ${file}`);
    }
  }

  logMsg(`Migration complete! Backup created at: ${backupDir}`);
  return { migrated: true, backupDir, log };
}
