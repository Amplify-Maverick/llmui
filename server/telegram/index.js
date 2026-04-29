/**
 * Telegram Bot Integration for LLMUI
 *
 * This module provides a Telegram bot interface to local Ollama models.
 * Conversations are stored in SQLite with source='telegram'.
 *
 * MANUAL TEST PLAN:
 * 1. Set up a bot via @BotFather on Telegram
 * 2. Create ~/.llmui/telegram.json with:
 *    { "enabled": true, "bot_token": "YOUR_TOKEN", "allowed_user_ids": [], "default_model": "llama3.2" }
 * 3. Start the server and message the bot - it should reply with your user ID
 * 4. Add your user ID to allowed_user_ids and restart
 * 5. Test commands: /help, /models, /new, /system, /temp, /info
 * 6. Test chat: send a message, verify streaming response updates
 * 7. Test long responses: ask for a long story, verify message splitting
 * 8. Test code blocks: ask for code, verify HTML rendering
 * 9. Test /stop: start a long response, send /stop, verify abort
 * 10. Test /regen: verify last response regeneration
 * 11. Test Ctrl+C: verify clean shutdown with no zombie polling
 */

import TelegramBot from 'node-telegram-bot-api';
import fs from 'fs';
import fsp from 'fs/promises';
import path from 'path';
import os from 'os';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';
import {
  streamChat,
  streamPull,
  isModelInstalled,
  getInstalledModels,
  isOllamaReachable
} from '../ollama/chat.js';
import {
  markdownToTelegramHtml,
  splitMessage,
  sendFormattedMessage,
  editFormattedMessage
} from './markdown.js';

const STORAGE_DIR = path.join(os.homedir(), '.llmui');
const CONFIG_FILE = path.join(STORAGE_DIR, 'telegram.json');
const OLLAMA_CONFIG_FILE = path.join(STORAGE_DIR, 'ollama_config.json');

// Default configuration
const DEFAULT_CONFIG = {
  enabled: false,
  bot_token: '',
  allowed_user_ids: [],
  default_model: '',
  system_prompt: '',
  command_prefix: '/'
};

// Bot state
let bot = null;
let config = { ...DEFAULT_CONFIG };
let configWatcher = null;
let configDebounceTimer = null;
let ollamaUrl = 'http://localhost:11434';

// Track active streams per user (for abort functionality)
const activeStreams = new Map(); // telegram_chat_id -> AbortController

// Track concurrent operations per user
const userOperations = new Map(); // telegram_chat_id -> Set of operation types

/**
 * Load configuration from file
 */
async function loadConfig() {
  try {
    const data = await fsp.readFile(CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    config = { ...DEFAULT_CONFIG, ...parsed };
    return true;
  } catch (err) {
    if (err.code === 'ENOENT') {
      // Create default config file
      await saveDefaultConfig();
      return false;
    }
    console.error('[Telegram] Error loading config:', err.message);
    return false;
  }
}

/**
 * Save default configuration file with secure permissions
 */
async function saveDefaultConfig() {
  try {
    await fsp.mkdir(STORAGE_DIR, { recursive: true });
    await fsp.writeFile(
      CONFIG_FILE,
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      { mode: 0o600 }
    );
    console.log('[Telegram] Created default config at', CONFIG_FILE);
  } catch (err) {
    console.error('[Telegram] Error saving default config:', err.message);
  }
}

/**
 * Load Ollama URL from config
 */
async function loadOllamaUrl() {
  try {
    const data = await fsp.readFile(OLLAMA_CONFIG_FILE, 'utf-8');
    const parsed = JSON.parse(data);
    if (parsed.ollamaUrl) {
      ollamaUrl = parsed.ollamaUrl;
    }
  } catch {
    // Use default
  }
}

/**
 * Check if a user is authorized
 */
function isAuthorized(userId) {
  return config.allowed_user_ids.includes(userId);
}

/**
 * Check if we're in bootstrap mode (enabled but no allowed users)
 */
function isBootstrapMode() {
  return config.enabled &&
         config.bot_token &&
         config.allowed_user_ids.length === 0;
}

/**
 * Get or create a conversation for a Telegram user
 */
function getOrCreateConversation(telegramChatId, telegramUserId, telegramUsername) {
  const db = getDb();

  // Check for active conversation
  const active = db.prepare(`
    SELECT conversation_id FROM telegram_active_conversation WHERE telegram_chat_id = ?
  `).get(telegramChatId);

  if (active) {
    // Verify the conversation still exists
    const conv = db.prepare('SELECT id FROM conversations WHERE id = ?').get(active.conversation_id);
    if (conv) {
      return active.conversation_id;
    }
    // Active conversation was deleted, remove the reference
    db.prepare('DELETE FROM telegram_active_conversation WHERE telegram_chat_id = ?').run(telegramChatId);
  }

  // Create new conversation
  const id = nanoid();
  const now = Date.now();
  const title = telegramUsername ? `Telegram: @${telegramUsername}` : `Telegram: ${telegramUserId}`;
  const sourceMetadata = JSON.stringify({
    telegram_user_id: telegramUserId,
    telegram_chat_id: telegramChatId,
    telegram_username: telegramUsername || null
  });

  db.prepare(`
    INSERT INTO conversations (id, title, model, tags, created_at, updated_at, source, source_metadata)
    VALUES (?, ?, ?, '[]', ?, ?, 'telegram', ?)
  `).run(id, title, config.default_model || null, now, now, sourceMetadata);

  // Set as active
  db.prepare(`
    INSERT OR REPLACE INTO telegram_active_conversation (telegram_chat_id, conversation_id)
    VALUES (?, ?)
  `).run(telegramChatId, id);

  console.log(`[Telegram] Created conversation ${id} for user ${telegramUserId}`);
  return id;
}

/**
 * Get conversation details
 */
function getConversation(conversationId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, title, model, temperature, system_prompt as systemPrompt, source_metadata as sourceMetadata
    FROM conversations WHERE id = ?
  `).get(conversationId);
}

/**
 * Get messages for a conversation
 */
function getMessages(conversationId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, role, content, model, created_at as createdAt
    FROM messages
    WHERE conversation_id = ?
    ORDER BY position ASC
  `).all(conversationId);
}

/**
 * Add a message to a conversation
 */
function addMessage(conversationId, role, content, model = null, tokensPerSec = null) {
  const db = getDb();
  const id = nanoid();
  const now = Date.now();

  // Get next position
  const last = db.prepare(`
    SELECT MAX(position) as maxPos FROM messages WHERE conversation_id = ?
  `).get(conversationId);
  const position = (last?.maxPos ?? -1) + 1;

  db.prepare(`
    INSERT INTO messages (id, conversation_id, role, content, model, created_at, position, tokens_per_sec)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, conversationId, role, content, model, now, position, tokensPerSec);

  // Update conversation timestamp
  db.prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(now, conversationId);

  return id;
}

/**
 * Delete the last N message pairs from a conversation
 */
function deleteLastMessages(conversationId, pairCount) {
  const db = getDb();

  // A pair is user + assistant, so delete 2 * pairCount messages
  const messagesToDelete = pairCount * 2;

  const messages = db.prepare(`
    SELECT id FROM messages
    WHERE conversation_id = ?
    ORDER BY position DESC
    LIMIT ?
  `).all(conversationId, messagesToDelete);

  for (const msg of messages) {
    db.prepare('DELETE FROM messages WHERE id = ?').run(msg.id);
  }

  return messages.length;
}

/**
 * Get the last assistant message
 */
function getLastAssistantMessage(conversationId) {
  const db = getDb();
  return db.prepare(`
    SELECT id, content, position FROM messages
    WHERE conversation_id = ? AND role = 'assistant'
    ORDER BY position DESC
    LIMIT 1
  `).get(conversationId);
}

/**
 * Delete a specific message
 */
function deleteMessage(messageId) {
  const db = getDb();
  db.prepare('DELETE FROM messages WHERE id = ?').run(messageId);
}

/**
 * Update conversation model
 */
function updateConversationModel(conversationId, model) {
  const db = getDb();
  db.prepare('UPDATE conversations SET model = ?, updated_at = ? WHERE id = ?')
    .run(model, Date.now(), conversationId);
}

/**
 * Update conversation settings
 */
function updateConversationSettings(conversationId, settings) {
  const db = getDb();
  const updates = [];
  const params = [];

  if (settings.temperature !== undefined) {
    updates.push('temperature = ?');
    params.push(settings.temperature);
  }
  if (settings.system_prompt !== undefined) {
    updates.push('system_prompt = ?');
    params.push(settings.system_prompt);
  }

  if (updates.length > 0) {
    updates.push('updated_at = ?');
    params.push(Date.now());
    params.push(conversationId);
    db.prepare(`UPDATE conversations SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  }
}

/**
 * Get user's recent Telegram conversations
 */
function getUserConversations(telegramChatId, limit = 10) {
  const db = getDb();
  return db.prepare(`
    SELECT c.id, c.title, c.model, c.updated_at as updatedAt,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = c.id) as messageCount
    FROM conversations c
    WHERE c.source = 'telegram'
      AND json_extract(c.source_metadata, '$.telegram_chat_id') = ?
    ORDER BY c.updated_at DESC
    LIMIT ?
  `).all(telegramChatId, limit);
}

/**
 * Switch active conversation
 */
function setActiveConversation(telegramChatId, conversationId) {
  const db = getDb();
  db.prepare(`
    INSERT OR REPLACE INTO telegram_active_conversation (telegram_chat_id, conversation_id)
    VALUES (?, ?)
  `).run(telegramChatId, conversationId);
}

/**
 * Create throttled message editor
 * Edits at most once every 1500ms, plus one final edit on completion
 */
function createThrottledEditor(bot, chatId, messageId) {
  let lastContent = '...';
  let lastEditTime = 0;
  let pendingContent = null;
  let pendingTimer = null;

  const doEdit = async (content) => {
    if (content === lastContent) return;
    try {
      await editFormattedMessage(bot, markdownToTelegramHtml(content), {
        chat_id: chatId,
        message_id: messageId
      });
      lastContent = content;
      lastEditTime = Date.now();
    } catch (err) {
      if (!err.message?.includes('message is not modified')) {
        console.error('[Telegram] Edit error:', err.message);
      }
    }
  };

  return {
    update: (content) => {
      const now = Date.now();
      const timeSinceLastEdit = now - lastEditTime;

      if (timeSinceLastEdit >= 1500) {
        // Can edit immediately
        if (pendingTimer) {
          clearTimeout(pendingTimer);
          pendingTimer = null;
        }
        doEdit(content);
      } else {
        // Schedule edit
        pendingContent = content;
        if (!pendingTimer) {
          pendingTimer = setTimeout(() => {
            pendingTimer = null;
            if (pendingContent) {
              doEdit(pendingContent);
              pendingContent = null;
            }
          }, 1500 - timeSinceLastEdit);
        }
      }
    },
    finalize: async (content) => {
      if (pendingTimer) {
        clearTimeout(pendingTimer);
        pendingTimer = null;
      }
      await doEdit(content);
    }
  };
}

/**
 * Handle a chat message (non-command)
 */
async function handleChatMessage(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;
  const userMessage = msg.text;

  // Check for concurrent stream
  const existingController = activeStreams.get(chatId);
  if (existingController) {
    // Abort the existing stream
    existingController.abort();
    activeStreams.delete(chatId);
    console.log(`[Telegram] Aborted previous stream for chat ${chatId}`);
  }

  // Get or create conversation
  const conversationId = getOrCreateConversation(chatId, userId, username);
  const conversation = getConversation(conversationId);

  // Check model
  const model = conversation.model || config.default_model;
  if (!model) {
    await bot.sendMessage(chatId, 'No model configured. Use /model <name> to set one, or /models to see available models.');
    return;
  }

  // Check if model is installed
  const installed = await isModelInstalled(ollamaUrl, model);
  if (!installed) {
    await bot.sendMessage(chatId,
      `Model "${model}" is not installed. Use /models to see available models or /pull ${model} to install it.`
    );
    return;
  }

  // Check Ollama reachability
  const reachable = await isOllamaReachable(ollamaUrl);
  if (!reachable) {
    await bot.sendMessage(chatId, 'Ollama is unreachable. Check the server is running.');
    return;
  }

  // Store user message
  addMessage(conversationId, 'user', userMessage);

  // Send placeholder
  const placeholder = await bot.sendMessage(chatId, '...');
  const editor = createThrottledEditor(bot, chatId, placeholder.message_id);

  // Build messages array
  const dbMessages = getMessages(conversationId);
  const systemPrompt = conversation.systemPrompt || config.system_prompt;
  const ollamaMessages = [];

  if (systemPrompt) {
    ollamaMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const m of dbMessages) {
    ollamaMessages.push({ role: m.role, content: m.content });
  }

  // Create abort controller
  const abortController = new AbortController();
  activeStreams.set(chatId, abortController);

  let fullContent = '';
  let meta = {};

  try {
    await streamChat({
      ollamaUrl,
      model,
      messages: ollamaMessages,
      modelOptions: {
        temperature: conversation.temperature ?? undefined
      },
      signal: abortController.signal,
      onToken: (token) => {
        fullContent += token;
        editor.update(fullContent);
      },
      onComplete: (content, m) => {
        fullContent = content;
        meta = m;
      },
      onError: async (err) => {
        console.error('[Telegram] Stream error:', err.message);
        await editor.finalize(`Error: ${err.message}`);
      }
    });
  } finally {
    activeStreams.delete(chatId);
  }

  // Finalize the message
  if (fullContent) {
    // Handle message length limit
    const chunks = splitMessage(fullContent);

    // Update the original placeholder with the first chunk
    await editor.finalize(chunks[0]);

    // Send additional chunks as new messages
    for (let i = 1; i < chunks.length; i++) {
      await sendFormattedMessage(bot, chatId, markdownToTelegramHtml(chunks[i]));
    }

    // Store the full response in DB (as single message regardless of chunks)
    addMessage(conversationId, 'assistant', fullContent, model, meta.tokensPerSec);
  }
}

/**
 * Handle /help command
 */
async function handleHelp(msg) {
  const prefix = config.command_prefix;
  const helpText = `
<b>LLMUI Telegram Bot</b>

<b>Chat Commands:</b>
${prefix}help - Show this help message
${prefix}model [name] - Show or switch model
${prefix}models - List available models
${prefix}pull &lt;name&gt; - Download a model
${prefix}new [model] - Start new conversation
${prefix}system &lt;prompt&gt; - Set system prompt
${prefix}temp &lt;0.0-2.0&gt; - Set temperature
${prefix}stop - Stop current response
${prefix}info - Show conversation info
${prefix}regen - Regenerate last response
${prefix}forget &lt;n&gt; - Delete last n message pairs
${prefix}list - List your conversations
${prefix}switch &lt;id&gt; - Switch conversation

Just send a message to chat with the AI.
  `.trim();

  await sendFormattedMessage(bot, msg.chat.id, helpText);
}

/**
 * Handle /model and /models commands
 */
async function handleModel(msg, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  // Get installed models
  const models = await getInstalledModels(ollamaUrl);

  if (models.length === 0) {
    await bot.sendMessage(chatId, 'No models installed. Use /pull <name> to download one.');
    return;
  }

  if (!args) {
    // Show current model and list
    const conversationId = getOrCreateConversation(chatId, userId, username);
    const conversation = getConversation(conversationId);
    const currentModel = conversation.model || config.default_model || 'not set';

    let text = `<b>Current model:</b> ${currentModel}\n\n<b>Available models:</b>\n`;
    for (const m of models) {
      const marker = m.name === currentModel ? ' ✓' : '';
      text += `• ${m.name}${marker}\n`;
    }

    await sendFormattedMessage(bot, chatId, text);
    return;
  }

  // Switch model
  const newModel = args.trim();

  // Check if model is installed
  const installed = await isModelInstalled(ollamaUrl, newModel);
  if (!installed) {
    await bot.sendMessage(chatId,
      `Model "${newModel}" is not installed. Use /pull ${newModel} to download it.`
    );
    return;
  }

  const conversationId = getOrCreateConversation(chatId, userId, username);
  updateConversationModel(conversationId, newModel);

  await bot.sendMessage(chatId, `Switched to ${newModel} for this conversation.`);
  console.log(`[Telegram] User ${userId} switched model to ${newModel}`);
}

/**
 * Handle /pull command
 */
async function handlePull(msg, args) {
  const chatId = msg.chat.id;

  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /pull <model_name>\nExample: /pull llama3.2');
    return;
  }

  const modelName = args.trim();

  // Check for concurrent pull
  const ops = userOperations.get(chatId) || new Set();
  if (ops.has('pull')) {
    await bot.sendMessage(chatId, 'A pull is already in progress. Wait for it to complete.');
    return;
  }
  ops.add('pull');
  userOperations.set(chatId, ops);

  const statusMsg = await bot.sendMessage(chatId, `Pulling ${modelName}...`);
  const editor = createThrottledEditor(bot, chatId, statusMsg.message_id);

  try {
    await streamPull({
      ollamaUrl,
      name: modelName,
      onProgress: (status, completed, total) => {
        let text = `Pulling ${modelName}...\n${status}`;
        if (completed && total) {
          const percent = Math.round((completed / total) * 100);
          const completedMB = (completed / 1e6).toFixed(1);
          const totalMB = (total / 1e6).toFixed(1);
          text = `Pulling ${modelName}: ${percent}% (${completedMB}MB / ${totalMB}MB)`;
        }
        editor.update(text);
      },
      onComplete: async () => {
        await editor.finalize(`✓ Successfully pulled ${modelName}`);
        await bot.sendMessage(chatId, `Would you like to switch to ${modelName}? Use /model ${modelName}`);
      },
      onError: async (err) => {
        await editor.finalize(`Error pulling ${modelName}: ${err.message}`);
      }
    });
  } finally {
    ops.delete('pull');
    if (ops.size === 0) userOperations.delete(chatId);
  }

  console.log(`[Telegram] User ${msg.from.id} pulled model ${modelName}`);
}

/**
 * Handle /new command
 */
async function handleNew(msg, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  // Get current conversation to inherit model if not specified
  let model = args?.trim() || null;

  if (!model) {
    const active = getDb().prepare(`
      SELECT conversation_id FROM telegram_active_conversation WHERE telegram_chat_id = ?
    `).get(chatId);

    if (active) {
      const conv = getConversation(active.conversation_id);
      model = conv?.model || config.default_model;
    } else {
      model = config.default_model;
    }
  }

  // Create new conversation
  const id = nanoid();
  const now = Date.now();
  const title = username ? `Telegram: @${username}` : `Telegram: ${userId}`;
  const sourceMetadata = JSON.stringify({
    telegram_user_id: userId,
    telegram_chat_id: chatId,
    telegram_username: username || null
  });

  getDb().prepare(`
    INSERT INTO conversations (id, title, model, tags, created_at, updated_at, source, source_metadata)
    VALUES (?, ?, ?, '[]', ?, ?, 'telegram', ?)
  `).run(id, title, model, now, now, sourceMetadata);

  // Set as active
  setActiveConversation(chatId, id);

  await bot.sendMessage(chatId, `Started new conversation. Model: ${model || 'not set'}`);
  console.log(`[Telegram] User ${userId} started new conversation ${id}`);
}

/**
 * Handle /system command
 */
async function handleSystem(msg, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  const conversationId = getOrCreateConversation(chatId, userId, username);

  if (!args || args.trim() === '') {
    // Clear system prompt
    updateConversationSettings(conversationId, { system_prompt: null });
    await bot.sendMessage(chatId, 'System prompt cleared for this conversation.');
  } else {
    updateConversationSettings(conversationId, { system_prompt: args.trim() });
    await bot.sendMessage(chatId, 'System prompt updated for this conversation.');
  }

  console.log(`[Telegram] User ${userId} updated system prompt`);
}

/**
 * Handle /temp command
 */
async function handleTemp(msg, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /temp <0.0-2.0>\nExample: /temp 0.7');
    return;
  }

  const temp = parseFloat(args.trim());
  if (isNaN(temp) || temp < 0 || temp > 2) {
    await bot.sendMessage(chatId, 'Temperature must be between 0.0 and 2.0');
    return;
  }

  const conversationId = getOrCreateConversation(chatId, userId, username);
  updateConversationSettings(conversationId, { temperature: temp });

  await bot.sendMessage(chatId, `Temperature set to ${temp} for this conversation.`);
  console.log(`[Telegram] User ${userId} set temperature to ${temp}`);
}

/**
 * Handle /stop command
 */
async function handleStop(msg) {
  const chatId = msg.chat.id;

  const controller = activeStreams.get(chatId);
  if (controller) {
    controller.abort();
    activeStreams.delete(chatId);
    await bot.sendMessage(chatId, 'Response stopped.');
  } else {
    await bot.sendMessage(chatId, 'No response in progress.');
  }
}

/**
 * Handle /info command
 */
async function handleInfo(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  const conversationId = getOrCreateConversation(chatId, userId, username);
  const conversation = getConversation(conversationId);
  const messages = getMessages(conversationId);

  // Get GPU info
  let gpuStatus = 'Unknown';
  try {
    const { execFile } = await import('child_process');
    const { promisify } = await import('util');
    const execFileAsync = promisify(execFile);
    const { stdout } = await execFileAsync('nvidia-smi', ['--query-gpu=name,memory.used,memory.total', '--format=csv,noheader,nounits'], { timeout: 3000 });
    gpuStatus = stdout.trim().replace(',', ' - ').replace(',', '/') + ' MiB';
  } catch {
    gpuStatus = 'nvidia-smi not available';
  }

  let systemPrompt = conversation.systemPrompt || config.system_prompt || 'None';
  if (systemPrompt.length > 200) {
    systemPrompt = systemPrompt.slice(0, 200) + '...';
  }

  const info = `
<b>Conversation Info</b>

<b>ID:</b> <code>${conversationId.slice(0, 8)}</code>
<b>Model:</b> ${conversation.model || 'not set'}
<b>Messages:</b> ${messages.length}
<b>Temperature:</b> ${conversation.temperature ?? 'default'}
<b>System Prompt:</b> ${systemPrompt}

<b>Server Info</b>
<b>Ollama URL:</b> ${ollamaUrl}
<b>GPU:</b> ${gpuStatus}
  `.trim();

  await sendFormattedMessage(bot, chatId, info);
}

/**
 * Handle /regen command
 */
async function handleRegen(msg) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  const conversationId = getOrCreateConversation(chatId, userId, username);
  const lastAssistant = getLastAssistantMessage(conversationId);

  if (!lastAssistant) {
    await bot.sendMessage(chatId, 'No assistant message to regenerate.');
    return;
  }

  // Delete the last assistant message
  deleteMessage(lastAssistant.id);

  // Get conversation and messages
  const conversation = getConversation(conversationId);
  const dbMessages = getMessages(conversationId);

  if (dbMessages.length === 0) {
    await bot.sendMessage(chatId, 'No messages in conversation.');
    return;
  }

  const model = conversation.model || config.default_model;
  if (!model) {
    await bot.sendMessage(chatId, 'No model configured.');
    return;
  }

  // Send placeholder and regenerate
  const placeholder = await bot.sendMessage(chatId, '...');
  const editor = createThrottledEditor(bot, chatId, placeholder.message_id);

  const systemPrompt = conversation.systemPrompt || config.system_prompt;
  const ollamaMessages = [];

  if (systemPrompt) {
    ollamaMessages.push({ role: 'system', content: systemPrompt });
  }

  for (const m of dbMessages) {
    ollamaMessages.push({ role: m.role, content: m.content });
  }

  const abortController = new AbortController();
  activeStreams.set(chatId, abortController);

  let fullContent = '';
  let meta = {};

  try {
    await streamChat({
      ollamaUrl,
      model,
      messages: ollamaMessages,
      modelOptions: { temperature: conversation.temperature ?? undefined },
      signal: abortController.signal,
      onToken: (token) => {
        fullContent += token;
        editor.update(fullContent);
      },
      onComplete: (content, m) => {
        fullContent = content;
        meta = m;
      },
      onError: async (err) => {
        await editor.finalize(`Error: ${err.message}`);
      }
    });
  } finally {
    activeStreams.delete(chatId);
  }

  if (fullContent) {
    const chunks = splitMessage(fullContent);
    await editor.finalize(chunks[0]);

    for (let i = 1; i < chunks.length; i++) {
      await sendFormattedMessage(bot, chatId, markdownToTelegramHtml(chunks[i]));
    }

    addMessage(conversationId, 'assistant', fullContent, model, meta.tokensPerSec);
  }

  console.log(`[Telegram] User ${userId} regenerated response`);
}

/**
 * Handle /forget command
 */
async function handleForget(msg, args) {
  const chatId = msg.chat.id;
  const userId = msg.from.id;
  const username = msg.from.username;

  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /forget <n>\nDeletes the last n message pairs (user + assistant).');
    return;
  }

  const n = parseInt(args.trim());
  if (isNaN(n) || n < 1) {
    await bot.sendMessage(chatId, 'Please provide a positive number.');
    return;
  }

  if (n > 5) {
    // For safety, we'd ideally ask for confirmation here
    // For simplicity, just warn and proceed
    await bot.sendMessage(chatId, `Warning: Deleting ${n} message pairs...`);
  }

  const conversationId = getOrCreateConversation(chatId, userId, username);
  const deleted = deleteLastMessages(conversationId, n);

  await bot.sendMessage(chatId, `Deleted ${deleted} messages from conversation.`);
  console.log(`[Telegram] User ${userId} forgot ${n} message pairs`);
}

/**
 * Handle /list command
 */
async function handleList(msg) {
  const chatId = msg.chat.id;

  const conversations = getUserConversations(chatId, 10);

  if (conversations.length === 0) {
    await bot.sendMessage(chatId, 'No conversations found. Send a message to start one.');
    return;
  }

  // Get active conversation
  const active = getDb().prepare(`
    SELECT conversation_id FROM telegram_active_conversation WHERE telegram_chat_id = ?
  `).get(chatId);

  let text = '<b>Your Conversations</b>\n\n';
  for (const c of conversations) {
    const shortId = c.id.slice(0, 8);
    const date = new Date(c.updatedAt).toLocaleDateString();
    const marker = active?.conversation_id === c.id ? ' ✓' : '';
    text += `<code>${shortId}</code> - ${c.model || 'no model'} (${c.messageCount} msgs, ${date})${marker}\n`;
  }
  text += '\nUse /switch <id> to change conversation.';

  await sendFormattedMessage(bot, chatId, text);
}

/**
 * Handle /switch command
 */
async function handleSwitch(msg, args) {
  const chatId = msg.chat.id;

  if (!args) {
    await bot.sendMessage(chatId, 'Usage: /switch <id>\nUse /list to see your conversations.');
    return;
  }

  const shortId = args.trim().toLowerCase();

  // Find conversation matching the short ID
  const conversations = getUserConversations(chatId, 100);
  const match = conversations.find(c => c.id.toLowerCase().startsWith(shortId));

  if (!match) {
    await bot.sendMessage(chatId, `No conversation found with ID starting with "${shortId}".`);
    return;
  }

  setActiveConversation(chatId, match.id);
  await bot.sendMessage(chatId, `Switched to conversation ${match.id.slice(0, 8)}. Model: ${match.model || 'not set'}`);
  console.log(`[Telegram] User ${msg.from.id} switched to conversation ${match.id}`);
}

/**
 * Process incoming message
 */
async function processMessage(msg) {
  // Ignore non-text messages
  if (!msg.text) return;

  // Ignore group chats
  if (msg.chat.type !== 'private') {
    await bot.sendMessage(msg.chat.id, 'This bot only operates in direct messages.');
    return;
  }

  const userId = msg.from.id;
  const username = msg.from.username;
  const text = msg.text.trim();

  // Bootstrap mode - help user get their ID
  if (isBootstrapMode()) {
    await bot.sendMessage(msg.chat.id,
      `Your Telegram user ID is <code>${userId}</code>.\n\n` +
      `Add this to <code>allowed_user_ids</code> in <code>~/.llmui/telegram.json</code> and restart the server to enable the bot.`,
      { parse_mode: 'HTML' }
    );
    console.log(`[Telegram] Bootstrap: User ${userId} (@${username}) requested ID`);
    return;
  }

  // Authorization check
  if (!isAuthorized(userId)) {
    console.log(`[Telegram] Rejected message from user ${userId} (@${username}): not in allowlist`);
    return;
  }

  // Check for commands
  if (text.startsWith(config.command_prefix)) {
    const withoutPrefix = text.slice(config.command_prefix.length);
    const parts = withoutPrefix.split(/\s+/);
    const command = parts[0].toLowerCase();
    const args = parts.slice(1).join(' ');

    try {
      switch (command) {
        case 'help':
          await handleHelp(msg);
          break;
        case 'model':
        case 'models':
          await handleModel(msg, command === 'models' ? null : args);
          break;
        case 'pull':
          await handlePull(msg, args);
          break;
        case 'new':
          await handleNew(msg, args);
          break;
        case 'system':
          await handleSystem(msg, args);
          break;
        case 'temp':
          await handleTemp(msg, args);
          break;
        case 'stop':
          await handleStop(msg);
          break;
        case 'info':
          await handleInfo(msg);
          break;
        case 'regen':
          await handleRegen(msg);
          break;
        case 'forget':
          await handleForget(msg, args);
          break;
        case 'list':
          await handleList(msg);
          break;
        case 'switch':
          await handleSwitch(msg, args);
          break;
        default:
          await bot.sendMessage(msg.chat.id, `Unknown command. Use ${config.command_prefix}help for available commands.`);
      }
    } catch (err) {
      console.error(`[Telegram] Command error:`, err);
      await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
    }
    return;
  }

  // Handle as chat message
  try {
    await handleChatMessage(msg);
  } catch (err) {
    console.error('[Telegram] Chat error:', err);
    await bot.sendMessage(msg.chat.id, `Error: ${err.message}`);
  }
}

/**
 * Start the Telegram bot
 */
export async function startTelegramBot() {
  await loadConfig();
  await loadOllamaUrl();

  if (!config.enabled) {
    console.log('[Telegram] Bot is disabled in config');
    return false;
  }

  if (!config.bot_token) {
    console.log('[Telegram] No bot token configured');
    return false;
  }

  try {
    // Delete any existing webhook before starting polling
    const tempBot = new TelegramBot(config.bot_token);
    await tempBot.deleteWebHook();

    // Start polling
    bot = new TelegramBot(config.bot_token, {
      polling: {
        interval: 1000,
        autoStart: true,
        params: {
          timeout: 30
        }
      }
    });

    // Handle polling errors
    bot.on('polling_error', (err) => {
      if (err.message.includes('terminated by other getUpdates')) {
        console.error('[Telegram] Another instance is polling this bot. Stopping...');
        stopTelegramBot();
      } else {
        console.error('[Telegram] Polling error:', err.message);
      }
    });

    // Handle messages
    bot.on('message', processMessage);

    // Get bot info
    const me = await bot.getMe();
    const userCount = config.allowed_user_ids.length;

    console.log(`[Telegram] Bot started, username: @${me.username}, allowed users: ${userCount}`);

    // Watch config file for changes
    try {
      configWatcher = fs.watch(CONFIG_FILE, (eventType) => {
        if (eventType === 'change') {
          // Debounce
          if (configDebounceTimer) clearTimeout(configDebounceTimer);
          configDebounceTimer = setTimeout(async () => {
            console.log('[Telegram] Config changed, reloading...');
            await stopTelegramBot();
            await startTelegramBot();
          }, 1000);
        }
      });
    } catch (err) {
      console.warn('[Telegram] Could not watch config file:', err.message);
    }

    return true;
  } catch (err) {
    console.error('[Telegram] Failed to start bot:', err.message);
    return false;
  }
}

/**
 * Stop the Telegram bot
 */
export async function stopTelegramBot() {
  if (configDebounceTimer) {
    clearTimeout(configDebounceTimer);
    configDebounceTimer = null;
  }

  if (configWatcher) {
    configWatcher.close();
    configWatcher = null;
  }

  // Abort all active streams
  for (const [chatId, controller] of activeStreams) {
    controller.abort();
  }
  activeStreams.clear();

  if (bot) {
    try {
      await bot.stopPolling();
    } catch (err) {
      // Ignore errors during shutdown
    }
    bot = null;
    console.log('[Telegram] Bot stopped');
  }
}

/**
 * Check if bot is running
 */
export function isBotRunning() {
  return bot !== null;
}
