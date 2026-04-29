import express from 'express';
import { nanoid } from 'nanoid';
import { getDb } from '../db/index.js';

const router = express.Router();

// GET /api/conversations - List conversations with pagination
router.get('/', (req, res) => {
  const db = getDb();
  const { page = 1, limit = 50, archived = 'false' } = req.query;
  const offset = (parseInt(page) - 1) * parseInt(limit);
  const isArchived = archived === 'true' ? 1 : 0;

  const conversations = db.prepare(`
    SELECT id, title, model, tags, created_at as createdAt, updated_at as updatedAt, archived,
           parent_conversation_id as parentConversationId, branch_point_message_id as branchPointMessageId,
           temperature, max_tokens as maxTokens, system_prompt as systemPrompt, enable_thinking as enableThinking,
           is_compare as isCompare, compare_models as compareModels,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount,
           (SELECT COUNT(*) FROM conversations c2 WHERE c2.parent_conversation_id = conversations.id) as childBranchCount
    FROM conversations
    WHERE archived = ?
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(isArchived, parseInt(limit), offset);

  const total = db.prepare('SELECT COUNT(*) as count FROM conversations WHERE archived = ?').get(isArchived);

  res.json({
    conversations: conversations.map(c => ({
      ...c,
      tags: JSON.parse(c.tags || '[]'),
      enableThinking: c.enableThinking === 1 ? true : c.enableThinking === 0 ? false : null,
      isCompare: c.isCompare === 1,
      compareModels: c.compareModels ? JSON.parse(c.compareModels) : null
    })),
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total: total.count
    }
  });
});

// POST /api/conversations - Create new conversation
router.post('/', (req, res) => {
  const db = getDb();
  const { model, title = 'New Chat', tags = [], isCompare = false, compareModels = null } = req.body;
  const id = nanoid();
  const now = Date.now();

  db.prepare(`
    INSERT INTO conversations (id, title, model, tags, created_at, updated_at, is_compare, compare_models)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(id, title, model || null, JSON.stringify(tags), now, now, isCompare ? 1 : 0, compareModels ? JSON.stringify(compareModels) : null);

  res.json({
    id,
    title,
    model,
    tags,
    createdAt: now,
    updatedAt: now,
    messageCount: 0,
    archived: 0,
    isCompare,
    compareModels
  });
});

// GET /api/conversations/:id - Get single conversation
router.get('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const conversation = db.prepare(`
    SELECT id, title, model, tags, created_at as createdAt, updated_at as updatedAt, archived,
           parent_conversation_id as parentConversationId, branch_point_message_id as branchPointMessageId,
           temperature, max_tokens as maxTokens, system_prompt as systemPrompt, enable_thinking as enableThinking,
           is_compare as isCompare, compare_models as compareModels,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount,
           (SELECT COUNT(*) FROM conversations c2 WHERE c2.parent_conversation_id = conversations.id) as childBranchCount
    FROM conversations
    WHERE id = ?
  `).get(id);

  if (!conversation) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({
    ...conversation,
    tags: JSON.parse(conversation.tags || '[]'),
    enableThinking: conversation.enableThinking === 1 ? true : conversation.enableThinking === 0 ? false : null,
    isCompare: conversation.isCompare === 1,
    compareModels: conversation.compareModels ? JSON.parse(conversation.compareModels) : null
  });
});

// PATCH /api/conversations/:id - Update conversation (rename, tags, archive, settings)
router.patch('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;
  const { title, tags, model, archived, temperature, max_tokens, system_prompt, enable_thinking } = req.body;

  const updates = [];
  const params = [];

  if (title !== undefined) {
    updates.push('title = ?');
    params.push(title);
  }
  if (tags !== undefined) {
    updates.push('tags = ?');
    params.push(JSON.stringify(tags));
  }
  if (model !== undefined) {
    updates.push('model = ?');
    params.push(model);
  }
  if (archived !== undefined) {
    updates.push('archived = ?');
    params.push(archived ? 1 : 0);
  }
  // Per-conversation settings (null clears to global default)
  if (temperature !== undefined) {
    updates.push('temperature = ?');
    params.push(temperature);
  }
  if (max_tokens !== undefined) {
    updates.push('max_tokens = ?');
    params.push(max_tokens);
  }
  if (system_prompt !== undefined) {
    updates.push('system_prompt = ?');
    params.push(system_prompt);
  }
  if (enable_thinking !== undefined) {
    updates.push('enable_thinking = ?');
    params.push(enable_thinking === null ? null : (enable_thinking ? 1 : 0));
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: 'No fields to update' });
  }

  updates.push('updated_at = ?');
  params.push(Date.now());
  params.push(id);

  const result = db.prepare(`
    UPDATE conversations SET ${updates.join(', ')} WHERE id = ?
  `).run(...params);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({ success: true });
});

// DELETE /api/conversations/:id - Delete conversation
router.delete('/:id', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  // CASCADE will delete messages automatically
  const result = db.prepare('DELETE FROM conversations WHERE id = ?').run(id);

  if (result.changes === 0) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  res.json({ success: true });
});

// POST /api/conversations/:id/branch - Create a branch from a conversation
router.post('/:id/branch', (req, res) => {
  const db = getDb();
  const { id: parentId } = req.params;
  const { branchAtMessageId, editedContent } = req.body;

  if (!branchAtMessageId) {
    return res.status(400).json({ error: 'branchAtMessageId is required' });
  }

  // Get parent conversation
  const parent = db.prepare('SELECT * FROM conversations WHERE id = ?').get(parentId);
  if (!parent) {
    return res.status(404).json({ error: 'Conversation not found' });
  }

  // Get branch point message and its position
  const branchMsg = db.prepare('SELECT * FROM messages WHERE id = ? AND conversation_id = ?')
    .get(branchAtMessageId, parentId);
  if (!branchMsg) {
    return res.status(404).json({ error: 'Message not found in conversation' });
  }

  const newId = nanoid();
  const now = Date.now();

  const createBranch = db.transaction(() => {
    // Create new conversation with branch metadata and inherited settings
    db.prepare(`
      INSERT INTO conversations
      (id, title, model, tags, created_at, updated_at, parent_conversation_id, branch_point_message_id,
       temperature, max_tokens, system_prompt, enable_thinking)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      newId,
      `Branch: ${parent.title}`,
      parent.model,
      parent.tags,
      now, now,
      parentId,
      branchAtMessageId,
      parent.temperature,
      parent.max_tokens,
      parent.system_prompt,
      parent.enable_thinking
    );

    const insertMsg = db.prepare(`
      INSERT INTO messages (id, conversation_id, role, content, model, images, created_at, position, tokens_per_sec, tool_calls)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    if (editedContent) {
      // Copy messages up to branch point (positions 0..branchMsg.position-1)
      const messagesToCopy = db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ? AND position < ?
        ORDER BY position
      `).all(parentId, branchMsg.position);

      for (const msg of messagesToCopy) {
        insertMsg.run(
          nanoid(), newId, msg.role, msg.content, msg.model,
          msg.images, msg.created_at, msg.position, msg.tokens_per_sec, msg.tool_calls
        );
      }

      // Add the edited message at the branch point position
      insertMsg.run(
        nanoid(), newId, 'user', editedContent, null,
        null, now, branchMsg.position, null, null
      );
    } else {
      // Copy messages up to and including branch point (positions 0..branchMsg.position)
      const messagesToCopy = db.prepare(`
        SELECT * FROM messages
        WHERE conversation_id = ? AND position <= ?
        ORDER BY position
      `).all(parentId, branchMsg.position);

      for (const msg of messagesToCopy) {
        insertMsg.run(
          nanoid(), newId, msg.role, msg.content, msg.model,
          msg.images, msg.created_at, msg.position, msg.tokens_per_sec, msg.tool_calls
        );
      }
    }
  });

  createBranch();

  // Return the new branch conversation
  const branch = db.prepare(`
    SELECT id, title, model, tags, created_at as createdAt, updated_at as updatedAt, archived,
           parent_conversation_id as parentConversationId, branch_point_message_id as branchPointMessageId,
           temperature, max_tokens as maxTokens, system_prompt as systemPrompt, enable_thinking as enableThinking,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount
    FROM conversations
    WHERE id = ?
  `).get(newId);

  res.json({
    ...branch,
    tags: JSON.parse(branch.tags || '[]'),
    enableThinking: branch.enableThinking === 1 ? true : branch.enableThinking === 0 ? false : null
  });
});

// GET /api/conversations/:id/branches - Get all branches of a conversation
router.get('/:id/branches', (req, res) => {
  const db = getDb();
  const { id } = req.params;

  const branches = db.prepare(`
    SELECT id, title, branch_point_message_id as branchPointMessageId, created_at as createdAt,
           (SELECT COUNT(*) FROM messages WHERE conversation_id = conversations.id) as messageCount
    FROM conversations
    WHERE parent_conversation_id = ?
    ORDER BY created_at DESC
  `).all(id);

  res.json({ branches });
});

export default router;
