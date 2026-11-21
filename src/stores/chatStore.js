import { create } from "zustand";
import { nanoid } from "nanoid";
import { STORAGE_KEYS } from "../constants/config.js";
import {
  loadFromStorage,
  saveToStorage,
  removeFromStorage,
  debouncedSaveToStorage,
  cancelDebouncedSave,
  flushDebouncedSave,
} from "../utils/storage.js";
import { authHeaders } from "../services/auth.js";
import { streamSpeeds } from "../utils/streamSpeed.js";

const API_BASE = "/api";

// Strip messages from a conversation object, keep only sidebar metadata
function toMeta(conv) {
  const { messages, ...meta } = conv;
  return { ...meta, messageCount: messages?.length ?? meta.messageCount ?? 0 };
}

// Streaming fields when nothing is streaming.
const idleStream = {
  isStreaming: false,
  streamingContent: "",
  streamingThinking: "",
  streamingTokenCount: 0,
  streamingStartTime: null,
  streamingFirstTokenTime: null,
  streamingToolCalls: [],
  streamOwner: null,
  activeRunId: null,
};

export const useChatStore = create((set, get) => ({
  conversations: [], // metadata only — no .messages on these objects
  activeConversationId: null,
  messages: [], // messages for the active conversation
  isStreaming: false,
  streamingContent: "",
  streamingTokenCount: 0,
  streamingStartTime: null,
  // When the first generated token (content or thinking) arrived: the
  // fallback tok/s is measured from here, excluding load + prompt time.
  streamingFirstTokenTime: null,
  streamingToolCalls: [], // {id, name, arguments, status: 'calling'|'completed', result?, error?}
  streamingThinking: "",
  // The conversation the current stream belongs to (switching away detaches
  // from it; the server-side run carries on) and its server run id.
  streamOwner: null,
  activeRunId: null,
  isLoading: true,

  // ================================================================
  // Persistence helpers (debounced ~500ms)
  // ================================================================
  _saveIndex: () => {
    const { conversations } = get();
    debouncedSaveToStorage(STORAGE_KEYS.convIndex, conversations);
  },

  _saveActiveMessages: () => {
    const { activeConversationId, messages } = get();
    if (!activeConversationId) return;
    // Local-only bubbles (a send's error text) are never stored.
    debouncedSaveToStorage(
      STORAGE_KEYS.convMessages(activeConversationId),
      messages.filter((m) => !m.localOnly)
    );
  },

  // The index save is a no-op (the list is derived from the conversations
  // table), so metadata edits must PATCH the conversation itself.
  _patchConversation: async (id, fields) => {
    try {
      const response = await fetch(`${API_BASE}/conversations/${id}`, {
        method: "PATCH",
        headers: await authHeaders(),
        body: JSON.stringify(fields),
      });
      if (!response.ok) console.error(`Failed to update conversation ${id}`);
    } catch (err) {
      console.error("Error updating conversation:", err);
    }
  },

  _saveCurrentConversation: () => {
    get()._saveIndex();
    get()._saveActiveMessages();
  },

  // ================================================================
  // Load (with automatic migration from legacy blob)
  // ================================================================
  loadConversations: async () => {
    // Try new split format first
    let index = await loadFromStorage(STORAGE_KEYS.convIndex);

    if (!index) {
      // Check for legacy single-blob format and migrate
      const legacy = await loadFromStorage(STORAGE_KEYS.conversations);
      if (legacy && Array.isArray(legacy) && legacy.length > 0) {
        console.log(
          `[LLMUI] Migrating ${legacy.length} conversations to split storage…`
        );
        // Write each conversation's messages to its own key
        await Promise.all(
          legacy.map((conv) =>
            saveToStorage(
              STORAGE_KEYS.convMessages(conv.id),
              conv.messages || []
            )
          )
        );
        // Build and persist the metadata index
        index = legacy.map(toMeta);
        await saveToStorage(STORAGE_KEYS.convIndex, index);
        // Remove the legacy blob
        await removeFromStorage(STORAGE_KEYS.conversations);
        console.log("[LLMUI] Migration complete.");
      }
    }

    if (index && Array.isArray(index)) {
      set({ conversations: index, isLoading: false });

      // Restore the active conversation
      const activeId = await loadFromStorage(STORAGE_KEYS.activeConversation);
      if (activeId && index.find((c) => c.id === activeId)) {
        const msgs = await loadFromStorage(
          STORAGE_KEYS.convMessages(activeId)
        );
        set({ activeConversationId: activeId, messages: msgs || [] });
      }
    } else {
      set({ isLoading: false });
    }
  },

  // ================================================================
  // Conversation CRUD
  // ================================================================
  createConversation: async (model, options = {}) => {
    try {
      // Create conversation on the server
      const response = await fetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          model,
          title: options.title || 'New Chat',
          isCompare: options.isCompare || false,
          compareModels: options.compareModels || null
        })
      });

      if (!response.ok) {
        console.error('Failed to create conversation');
        return null;
      }

      const meta = await response.json();

      set((state) => ({
        conversations: [meta, ...state.conversations],
        activeConversationId: meta.id,
        messages: [],
      }));

      saveToStorage(STORAGE_KEYS.activeConversation, meta.id);
      return meta.id;
    } catch (err) {
      console.error('Error creating conversation:', err);
      return null;
    }
  },

  // Save a compare session as a conversation
  saveCompareConversation: async (userPrompt, responses, models) => {
    try {
      // Create conversation on the server
      const response = await fetch(`${API_BASE}/conversations`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify({
          model: models.join(', '),
          title: userPrompt.slice(0, 30) + (userPrompt.length > 30 ? '...' : ''),
          isCompare: true,
          compareModels: models
        })
      });

      if (!response.ok) {
        console.error('Failed to create compare conversation');
        return null;
      }

      const meta = await response.json();

      // Build messages array: user prompt + all model responses
      const messages = [
        { role: 'user', content: userPrompt, timestamp: Date.now() }
      ];

      // Add each model's response
      for (const [model, streamState] of responses) {
        if (streamState?.content) {
          // Calculate duration and tokensPerSec from stream state
          const duration = streamState.startTime && streamState.endTime
            ? (streamState.endTime - streamState.startTime) / 1000
            : null;
          // Measured by llama.cpp (or from the first token), set by useCompareStreams
          const tokensPerSec = streamState.tokensPerSec || null;
          messages.push({
            role: 'assistant',
            content: streamState.content,
            model,
            timestamp: Date.now(),
            duration,
            tokensPerSec,
            ...(streamState.promptPerSec ? { promptPerSec: streamState.promptPerSec } : {})
          });
        }
      }

      // Save messages to local storage
      await saveToStorage(STORAGE_KEYS.convMessages(meta.id), messages);

      // Update local state
      set((state) => ({
        conversations: [{ ...meta, messageCount: messages.length }, ...state.conversations],
        activeConversationId: meta.id,
        messages,
      }));

      saveToStorage(STORAGE_KEYS.activeConversation, meta.id);
      return meta.id;
    } catch (err) {
      console.error('Error saving compare conversation:', err);
      return null;
    }
  },

  updateConversationModel: (model) => {
    const { conversations: current, activeConversationId: activeId } = get();
    if (current.find((c) => c.id === activeId)?.model === model) return;
    set((state) => {
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, model, updatedAt: Date.now() }
          : c
      );
      return { conversations };
    });
    if (activeId) get()._patchConversation(activeId, { model });
  },

  renameConversation: (id, title) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    }));
    get()._patchConversation(id, { title });
  },

  updateConversationTags: (id, tags) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, tags, updatedAt: Date.now() } : c
      ),
    }));
    get()._patchConversation(id, { tags });
  },

  // Update per-conversation settings
  updateConversationSettings: async (settings) => {
    const { activeConversationId, conversations } = get();
    if (!activeConversationId) return;

    // Update local state
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, ...settings, updatedAt: Date.now() }
          : c
      ),
    }));

    // Persist to server
    try {
      const response = await fetch(`${API_BASE}/conversations/${activeConversationId}`, {
        method: 'PATCH',
        headers: await authHeaders(),
        body: JSON.stringify(settings),
      });
      if (!response.ok) {
        console.error('Failed to update conversation settings');
      }
    } catch (err) {
      console.error('Error updating conversation settings:', err);
    }
  },

  // Get settings for active conversation (null values mean use global)
  getActiveConversationSettings: () => {
    const { conversations, activeConversationId } = get();
    const conv = conversations.find((c) => c.id === activeConversationId);
    if (!conv) return null;
    return {
      temperature: conv.temperature ?? null,
      maxTokens: conv.maxTokens ?? null,
      systemPrompt: conv.systemPrompt ?? null,
      enableThinking: conv.enableThinking ?? null,
      enabledTools: conv.enabledTools ?? null,
    };
  },

  setActiveConversation: async (id) => {
    const { conversations, activeConversationId } = get();
    if (id === activeConversationId) return;
    if (!conversations.find((c) => c.id === id)) return;

    // Flush any pending debounced saves for the conversation we're leaving
    if (activeConversationId) {
      flushDebouncedSave(STORAGE_KEYS.convMessages(activeConversationId));
      flushDebouncedSave(STORAGE_KEYS.convIndex);
    }

    // Load messages BEFORE switching to avoid flash of empty state
    const msgs = await loadFromStorage(STORAGE_KEYS.convMessages(id));

    // Guard against rapid switching — only apply if we haven't started another switch
    if (get().activeConversationId === activeConversationId) {
      // Leaving a chat mid-reply only stops watching it; the server keeps
      // generating and the chat picks the run up again when reopened.
      set({ activeConversationId: id, messages: msgs || [], ...idleStream });
      saveToStorage(STORAGE_KEYS.activeConversation, id);
    }
  },

  deleteConversation: async (id) => {
    // Cancel any pending debounced save for the doomed conversation
    cancelDebouncedSave(STORAGE_KEYS.convMessages(id));

    const wasActive = get().activeConversationId === id;
    const deletedConv = get().conversations.find((c) => c.id === id);
    const parentId = deletedConv?.parentConversationId;

    set((state) => {
      let newConversations = state.conversations.filter((c) => c.id !== id);

      // If the deleted conversation was a branch, decrement the parent's childBranchCount
      if (parentId) {
        newConversations = newConversations.map((c) =>
          c.id === parentId
            ? { ...c, childBranchCount: Math.max(0, (c.childBranchCount || 1) - 1) }
            : c
        );
      }

      const newActiveId = wasActive
        ? newConversations[0]?.id || null
        : state.activeConversationId;
      return {
        conversations: newConversations,
        activeConversationId: newActiveId,
        messages: wasActive ? [] : state.messages,
        ...(wasActive ? idleStream : {}),
      };
    });

    // Immediate (non-debounced) saves — deletion is destructive
    removeFromStorage(STORAGE_KEYS.convMessages(id));
    cancelDebouncedSave(STORAGE_KEYS.convIndex);
    await saveToStorage(STORAGE_KEYS.convIndex, get().conversations);

    // If we switched to a new active conversation, load its messages
    const { activeConversationId } = get();
    if (wasActive && activeConversationId) {
      const msgs = await loadFromStorage(
        STORAGE_KEYS.convMessages(activeConversationId)
      );
      if (get().activeConversationId === activeConversationId) {
        set({ messages: msgs || [] });
      }
      saveToStorage(STORAGE_KEYS.activeConversation, activeConversationId);
    }
  },

  // ================================================================
  // Branching
  // ================================================================
  createBranch: async (messageId, editedContent = null) => {
    const { activeConversationId } = get();
    if (!activeConversationId) return null;

    try {
      // Flush any pending debounced saves to ensure messages are on the server
      await flushDebouncedSave(STORAGE_KEYS.convMessages(activeConversationId));
      await flushDebouncedSave(STORAGE_KEYS.convIndex);

      const body = { branchAtMessageId: messageId };
      if (editedContent !== null) {
        body.editedContent = editedContent;
      }

      const response = await fetch(`${API_BASE}/conversations/${activeConversationId}/branch`, {
        method: 'POST',
        headers: await authHeaders(),
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const err = await response.json();
        console.error('Failed to create branch:', err.error);
        return null;
      }

      const branch = await response.json();
      const parentId = activeConversationId;

      // Add branch to conversations list, increment parent's childBranchCount, and switch to it
      set((state) => ({
        conversations: [branch, ...state.conversations].map((c) =>
          c.id === parentId
            ? { ...c, childBranchCount: (c.childBranchCount || 0) + 1 }
            : c
        ),
        activeConversationId: branch.id,
        messages: [], // Will be loaded
      }));

      // Load messages for the new branch
      const msgs = await loadFromStorage(STORAGE_KEYS.convMessages(branch.id));
      if (get().activeConversationId === branch.id) {
        set({ messages: msgs || [] });
      }

      saveToStorage(STORAGE_KEYS.activeConversation, branch.id);
      get()._saveIndex();

      return branch.id;
    } catch (err) {
      console.error('Error creating branch:', err);
      return null;
    }
  },

  loadBranches: async (conversationId) => {
    try {
      const response = await fetch(`${API_BASE}/conversations/${conversationId}/branches`, {
        headers: await authHeaders()
      });
      if (!response.ok) return [];
      const data = await response.json();
      return data.branches || [];
    } catch (err) {
      console.error('Error loading branches:', err);
      return [];
    }
  },

  // Get branch info for a message (how many branches originate from it)
  getBranchCountForMessage: (messageId) => {
    const { conversations } = get();
    return conversations.filter(c => c.branchPointMessageId === messageId).length;
  },

  // ================================================================
  // Messages
  // ================================================================
  // `save: false` shows it without storing (the server stores sends itself).
  addMessage: (message, { save = true } = {}) => {
    const id = nanoid();
    const newMessage = { id, ...message, timestamp: Date.now() };

    set((state) => {
      const newMessages = [...state.messages, newMessage];
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? {
              ...c,
              title:
                c.title === "New Chat" && message.role === "user"
                  ? message.content.slice(0, 30) +
                    (message.content.length > 30 ? "..." : "")
                  : c.title,
              messageCount: newMessages.length,
              updatedAt: Date.now(),
            }
          : c
      );
      return { messages: newMessages, conversations };
    });
    if (save) get()._saveCurrentConversation();
    return id;
  },

  updateMessage: (id, content, extras = {}) => {
    set((state) => {
      const newMessages = state.messages.map((m) =>
        m.id === id ? { ...m, content, ...extras } : m
      );
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, updatedAt: Date.now() }
          : c
      );
      return { messages: newMessages, conversations };
    });
    // No save here — called rapidly during streaming.
    // finalizeStream triggers the save after the stream completes.
  },

  deleteMessage: (id) => {
    set((state) => {
      const newMessages = state.messages.filter((m) => m.id !== id);
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, messageCount: newMessages.length, updatedAt: Date.now() }
          : c
      );
      return { messages: newMessages, conversations };
    });
    get()._saveCurrentConversation();
  },

  // Edit a user message and remove all subsequent messages (for regeneration)
  editMessageAndTruncate: (id, newContent) => {
    set((state) => {
      const messageIndex = state.messages.findIndex((m) => m.id === id);
      if (messageIndex === -1) return state;

      const editedMessage = {
        ...state.messages[messageIndex],
        content: newContent,
      };
      const newMessages = [
        ...state.messages.slice(0, messageIndex),
        editedMessage,
      ];

      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, messageCount: newMessages.length, updatedAt: Date.now() }
          : c
      );
      return { messages: newMessages, conversations };
    });
    get()._saveCurrentConversation();
  },

  // Get the last user message for regeneration
  getLastUserMessage: () => {
    const { messages } = get();
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "user") {
        return messages[i];
      }
    }
    return null;
  },

  // Remove last assistant message for regeneration
  removeLastAssistantMessage: ({ save = true } = {}) => {
    set((state) => {
      const lastIndex = state.messages.length - 1;
      if (lastIndex >= 0 && state.messages[lastIndex].role === "assistant") {
        const newMessages = state.messages.slice(0, lastIndex);
        const conversations = state.conversations.map((c) =>
          c.id === state.activeConversationId
            ? { ...c, messageCount: newMessages.length, updatedAt: Date.now() }
            : c
        );
        return { messages: newMessages, conversations };
      }
      return state;
    });
    if (save) get()._saveCurrentConversation();
  },

  // ================================================================
  // Streaming
  // ================================================================
  setStreaming: (isStreaming, content = "", owner = null) => {
    set({
      isStreaming,
      streamingContent: content,
      streamingThinking: "",
      streamingToolCalls: [],
      streamingTokenCount: 0,
      streamingStartTime: isStreaming ? Date.now() : null,
      streamingFirstTokenTime: null,
      streamOwner: isStreaming ? owner : null,
      activeRunId: null,
    });
  },

  setActiveRunId: (activeRunId) => set({ activeRunId }),

  appendStreamThinking: (chunk) => {
    set((state) => ({
      streamingThinking: state.streamingThinking + chunk,
      streamingTokenCount: state.streamingTokenCount + 1,
      streamingFirstTokenTime: state.streamingFirstTokenTime ?? Date.now(),
    }));
  },

  /**
   * A server-side run ended (or a send failed): show the stored messages.
   * `messageId` is the stored reply, which also gets this session's
   * `extras` (duration, prompt speed: shown, not stored). `error` adds a
   * local-only bubble with the error text.
   */
  finishRun: async ({ conversationId, messageId = null, extras = {}, error = null }) => {
    const msgs = await loadFromStorage(STORAGE_KEYS.convMessages(conversationId));
    if (get().activeConversationId !== conversationId) return;
    const messages = (msgs || get().messages.filter((m) => !(m.role === "assistant" && !m.content))).map((m) =>
      m.id === messageId ? { ...m, ...extras, tokensPerSec: m.tokensPerSec ?? extras.tokensPerSec ?? null } : m
    );
    if (error) {
      messages.push({ id: nanoid(), role: "assistant", content: `Error: ${error}`, localOnly: true, timestamp: Date.now() });
    }
    set((state) => ({
      messages,
      conversations: state.conversations.map((c) =>
        c.id === conversationId ? { ...c, messageCount: messages.filter((m) => !m.localOnly).length, updatedAt: Date.now() } : c
      ),
      ...idleStream,
    }));
  },

  appendStreamContent: (chunk) => {
    set((state) => ({
      streamingContent: state.streamingContent + chunk,
      streamingTokenCount: state.streamingTokenCount + 1,
      streamingFirstTokenTime: state.streamingFirstTokenTime ?? Date.now(),
    }));
  },

  // A generated token that isn't shown as content (e.g. thinking): counts
  // toward the fallback tok/s.
  noteStreamToken: () => {
    set((state) => ({
      streamingTokenCount: state.streamingTokenCount + 1,
      streamingFirstTokenTime: state.streamingFirstTokenTime ?? Date.now(),
    }));
  },

  appendToolCall: (toolCall) => {
    set((state) => ({
      streamingToolCalls: [
        ...state.streamingToolCalls,
        { ...toolCall, status: "calling" },
      ],
    }));
  },

  completeToolCall: (id, result, error) => {
    set((state) => ({
      streamingToolCalls: state.streamingToolCalls.map((tc) =>
        tc.id === id ? { ...tc, status: "completed", result, error } : tc
      ),
    }));
  },

  clearToolCalls: () => {
    set({ streamingToolCalls: [] });
  },

  finalizeStream: ({ timings, ...extras } = {}) => {
    const {
      streamingContent,
      messages,
      streamingTokenCount,
      streamingFirstTokenTime,
      streamingToolCalls,
    } = get();

    const { tokensPerSec, promptPerSec } = streamSpeeds(timings, streamingTokenCount, streamingFirstTokenTime);

    // Include tool calls if any were made
    const finalExtras = { ...extras, tokensPerSec };
    if (promptPerSec) finalExtras.promptPerSec = promptPerSec;
    if (streamingToolCalls.length > 0) {
      finalExtras.toolCalls = streamingToolCalls;
    }

    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === "assistant") {
        get().updateMessage(lastMessage.id, streamingContent, finalExtras);
      }
    }
    set({
      isStreaming: false,
      streamingContent: "",
      streamingTokenCount: 0,
      streamingStartTime: null,
      streamingFirstTokenTime: null,
      streamingToolCalls: [],
    });
    get()._saveCurrentConversation();
  },

  // ================================================================
  // Export — loads messages on demand for non-active conversations
  // ================================================================
  exportConversation: async (id, format = "json") => {
    const {
      conversations,
      activeConversationId,
      messages: activeMessages,
    } = get();
    const conversation = conversations.find((c) => c.id === id);
    if (!conversation) return null;

    // Use in-memory messages if this is the active conversation,
    // otherwise load from storage on demand
    const msgs =
      id === activeConversationId
        ? activeMessages
        : (await loadFromStorage(STORAGE_KEYS.convMessages(id))) || [];

    const fullConv = { ...conversation, messages: msgs };

    if (format === "json") {
      return JSON.stringify(fullConv, null, 2);
    }

    if (format === "markdown") {
      let md = `# ${fullConv.title}\n\n`;
      md += `**Model:** ${fullConv.model || "Unknown"}\n`;
      md += `**Created:** ${new Date(fullConv.createdAt).toLocaleString()}\n`;
      md += `**Tags:** ${fullConv.tags?.join(", ") || "None"}\n\n`;
      md += `---\n\n`;

      for (const msg of fullConv.messages) {
        const role = msg.role === "user" ? "**You**" : "**Assistant**";
        md += `${role}\n\n${msg.content}\n\n---\n\n`;
      }

      return md;
    }

    return null;
  },
}));
