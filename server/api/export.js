import express from 'express';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';

const router = express.Router();

// Helper to convert DB conversation to export format
function formatConversation(conv, messages, branches = []) {
  return {
    id: conv.id,
    title: conv.title,
    model: conv.model,
    tags: JSON.parse(conv.tags || '[]'),
    createdAt: conv.created_at || conv.createdAt,
    updatedAt: conv.updated_at || conv.updatedAt,
    settings: {
      temperature: conv.temperature,
      maxTokens: conv.max_tokens,
      systemPrompt: conv.system_prompt,
      enableThinking: conv.enable_thinking === 1 ? true : conv.enable_thinking === 0 ? false : null,
    },
    parentConversationId: conv.parent_conversation_id || conv.parentConversationId || null,
    branchPointMessageId: conv.branch_point_message_id || conv.branchPointMessageId || null,
    messages: messages.map(m => ({
      id: m.id,
      role: m.role,
      content: m.content,
      model: m.model,
      timestamp: m.created_at,
      position: m.position,
      tokensPerSec: m.tokens_per_sec,
      images: m.images ? JSON.parse(m.images) : undefined,
      toolCalls: m.tool_calls ? JSON.parse(m.tool_calls) : undefined,
    })),
    branches: branches.map(b => ({
      id: b.id,
      title: b.title,
      branchPointMessageId: b.branch_point_message_id,
      messageCount: b.messageCount,
    })),
  };
}

// Generate YAML frontmatter for markdown export
function generateYamlFrontmatter(conv) {
  const lines = ['---'];
  lines.push(`title: "${conv.title.replace(/"/g, '\\"')}"`);
  if (conv.model) lines.push(`model: "${conv.model}"`);
  lines.push(`created: ${new Date(conv.createdAt).toISOString()}`);
  lines.push(`updated: ${new Date(conv.updatedAt).toISOString()}`);

  if (conv.tags && conv.tags.length > 0) {
    lines.push(`tags: [${conv.tags.map(t => `"${t}"`).join(', ')}]`);
  }

  // Settings (only include non-null values)
  const settings = conv.settings;
  const settingsLines = [];
  if (settings.temperature !== null) settingsLines.push(`  temperature: ${settings.temperature}`);
  if (settings.maxTokens !== null) settingsLines.push(`  maxTokens: ${settings.maxTokens}`);
  if (settings.systemPrompt !== null) settingsLines.push(`  systemPrompt: "${settings.systemPrompt.replace(/"/g, '\\"').replace(/\n/g, '\\n')}"`);
  if (settings.enableThinking !== null) settingsLines.push(`  enableThinking: ${settings.enableThinking}`);

  if (settingsLines.length > 0) {
    lines.push('settings:');
    lines.push(...settingsLines);
  }

  // Branches
  if (conv.branches && conv.branches.length > 0) {
    lines.push('branches:');
    for (const branch of conv.branches) {
      lines.push(`  - id: "${branch.id}"`);
      lines.push(`    title: "${branch.title.replace(/"/g, '\\"')}"`);
      lines.push(`    messageCount: ${branch.messageCount}`);
    }
  }

  lines.push('---');
  return lines.join('\n');
}

// Generate markdown content from conversation
function generateMarkdown(conv) {
  let md = generateYamlFrontmatter(conv);
  md += '\n\n';

  for (const msg of conv.messages) {
    const role = msg.role === 'user' ? 'You' : msg.role === 'assistant' ? 'Assistant' : msg.role;
    md += `## ${role}\n\n`;
    md += `${msg.content}\n\n`;
    md += '---\n\n';
  }

  return md;
}

// GET /api/export/conversations/:id - Export single conversation
router.get('/conversations/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { format = 'json' } = req.query;

  const conversation = db.prepare(`
    SELECT * FROM conversations WHERE id = ?
  `).get(id);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  const messages = db.prepare(`
    SELECT * FROM messages WHERE conversation_id = ? ORDER BY position
  `).all(id);

  const branches = db.prepare(`
    SELECT id, title, branch_point_message_id,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount
    FROM conversations WHERE parent_conversation_id = ?
  `).all(id);

  const conv = formatConversation(conversation, messages, branches);

  if (format === 'markdown') {
    const md = generateMarkdown(conv);
    const filename = `${conv.title.replace(/[^a-z0-9]/gi, '_')}.md`;
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.send(md);
  }

  // JSON format
  const jsonExport = {
    version: '1.0',
    exportedAt: new Date().toISOString(),
    conversations: [conv],
  };

  const filename = `${conv.title.replace(/[^a-z0-9]/gi, '_')}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.json(jsonExport);
});

// POST /api/export/bulk - Export multiple conversations
router.post('/bulk', (req, res) => {
  const db = getDb();
  const { ids, format = 'json' } = req.body;

  if (!ids || !Array.isArray(ids) || ids.length === 0) {
    return res.status(400).json({ error: 'ids array is required' });
  }

  const conversations = [];

  for (const id of ids) {
    const conversation = db.prepare('SELECT * FROM conversations WHERE id = ?').get(id);
    if (!conversation) continue;

    const messages = db.prepare(`
      SELECT * FROM messages WHERE conversation_id = ? ORDER BY position
    `).all(id);

    const branches = db.prepare(`
      SELECT id, title, branch_point_message_id,
             (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount
      FROM conversations WHERE parent_conversation_id = ?
    `).all(id);

    conversations.push(formatConversation(conversation, messages, branches));
  }

  if (format === 'json') {
    const jsonExport = {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      conversations,
    };
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="llmui_export.json"');
    return res.json(jsonExport);
  }

  // For markdown, return an array of { filename, content }
  const files = conversations.map(conv => ({
    filename: `${conv.title.replace(/[^a-z0-9]/gi, '_')}.md`,
    content: generateMarkdown(conv),
  }));

  res.json({ files });
});

// POST /api/import - Import conversations from JSON export
router.post('/import', (req, res) => {
  const db = getDb();
  const { conversations } = req.body;

  if (!conversations || !Array.isArray(conversations)) {
    return res.status(400).json({ error: 'conversations array is required' });
  }

  const results = { imported: 0, skipped: 0, errors: [] };

  const insertConv = db.prepare(`
    INSERT INTO conversations
    (id, title, model, tags, created_at, updated_at, temperature, max_tokens, system_prompt, enable_thinking)
    VALUES (@id, @title, @model, @tags, @createdAt, @updatedAt, @temperature, @maxTokens, @systemPrompt, @enableThinking)
  `);

  const insertMsg = db.prepare(`
    INSERT INTO messages
    (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls)
    VALUES (@id, @conversationId, @role, @content, @model, @images, @createdAt, @position, @tokensPerSec, @toolCalls)
  `);

  const importAll = db.transaction(() => {
    for (const conv of conversations) {
      try {
        // Generate new ID to avoid conflicts
        const newConvId = nanoid();
        const now = Date.now();

        insertConv.run({
          id: newConvId,
          title: conv.title || 'Imported Chat',
          model: conv.model || null,
          tags: JSON.stringify(conv.tags || []),
          createdAt: conv.createdAt || now,
          updatedAt: conv.updatedAt || now,
          temperature: conv.settings?.temperature ?? null,
          maxTokens: conv.settings?.maxTokens ?? null,
          systemPrompt: conv.settings?.systemPrompt ?? null,
          enableThinking: conv.settings?.enableThinking === true ? 1 : conv.settings?.enableThinking === false ? 0 : null,
        });

        // Import messages
        const messages = conv.messages || [];
        for (let i = 0; i < messages.length; i++) {
          const msg = messages[i];
          insertMsg.run({
            id: nanoid(),
            conversationId: newConvId,
            role: msg.role,
            content: msg.content || '',
            model: msg.model || null,
            images: msg.images ? JSON.stringify(msg.images) : null,
            createdAt: msg.timestamp || now,
            position: i,
            tokensPerSec: msg.tokensPerSec || null,
            toolCalls: msg.toolCalls ? JSON.stringify(msg.toolCalls) : null,
          });
        }

        results.imported++;
      } catch (err) {
        results.errors.push({ title: conv.title, error: err.message });
      }
    }
  });

  importAll();
  res.json(results);
});

export default router;
