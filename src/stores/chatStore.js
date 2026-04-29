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

// Strip messages from a conversation object, keep only sidebar metadata
function toMeta(conv) {
  const { messages, ...meta } = conv;
  return { ...meta, messageCount: messages?.length ?? meta.messageCount ?? 0 };
}

export const useChatStore = create((set, get) => ({
  conversations: [], // metadata only — no .messages on these objects
  activeConversationId: null,
  messages: [], // messages for the active conversation
  isStreaming: false,
  streamingContent: "",
  streamingTokenCount: 0,
  streamingStartTime: null,
  streamingToolCalls: [], // {id, name, arguments, status: 'calling'|'completed', result?, error?}
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
    debouncedSaveToStorage(
      STORAGE_KEYS.convMessages(activeConversationId),
      messages
    );
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
  createConversation: (model) => {
    const id = nanoid();
    const meta = {
      id,
      title: "New Chat",
      model,
      tags: [],
      messageCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((state) => ({
      conversations: [meta, ...state.conversations],
      activeConversationId: id,
      messages: [],
    }));
    get()._saveIndex();
    saveToStorage(STORAGE_KEYS.convMessages(id), []);
    saveToStorage(STORAGE_KEYS.activeConversation, id);
    return id;
  },

  updateConversationModel: (model) => {
    set((state) => {
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, model, updatedAt: Date.now() }
          : c
      );
      return { conversations };
    });
    get()._saveIndex();
  },

  renameConversation: (id, title) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    }));
    get()._saveIndex();
  },

  updateConversationTags: (id, tags) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, tags, updatedAt: Date.now() } : c
      ),
    }));
    get()._saveIndex();
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

    // Immediately update the active ID; clear messages while loading
    set({ activeConversationId: id, messages: [] });
    saveToStorage(STORAGE_KEYS.activeConversation, id);

    // Load messages for the target conversation
    const msgs = await loadFromStorage(STORAGE_KEYS.convMessages(id));
    // Guard against rapid switching — only apply if still on this conversation
    if (get().activeConversationId === id) {
      set({ messages: msgs || [] });
    }
  },

  deleteConversation: async (id) => {
    // Cancel any pending debounced save for the doomed conversation
    cancelDebouncedSave(STORAGE_KEYS.convMessages(id));

    const wasActive = get().activeConversationId === id;

    set((state) => {
      const newConversations = state.conversations.filter((c) => c.id !== id);
      const newActiveId = wasActive
        ? newConversations[0]?.id || null
        : state.activeConversationId;
      return {
        conversations: newConversations,
        activeConversationId: newActiveId,
        messages: wasActive ? [] : state.messages,
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
  // Messages
  // ================================================================
  addMessage: (message) => {
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
    get()._saveCurrentConversation();
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
  removeLastAssistantMessage: () => {
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
    get()._saveCurrentConversation();
  },

  // ================================================================
  // Streaming
  // ================================================================
  setStreaming: (isStreaming, content = "") => {
    set({
      isStreaming,
      streamingContent: content,
      streamingTokenCount: 0,
      streamingStartTime: isStreaming ? Date.now() : null,
    });
  },

  appendStreamContent: (chunk) => {
    set((state) => ({
      streamingContent: state.streamingContent + chunk,
      streamingTokenCount: state.streamingTokenCount + 1,
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

  finalizeStream: (extras = {}) => {
    const {
      streamingContent,
      messages,
      streamingTokenCount,
      streamingStartTime,
      streamingToolCalls,
    } = get();

    // Calculate tokens per second
    let tokensPerSec = null;
    if (streamingStartTime && streamingTokenCount > 0) {
      const elapsedSeconds = (Date.now() - streamingStartTime) / 1000;
      if (elapsedSeconds > 0) {
        tokensPerSec = streamingTokenCount / elapsedSeconds;
      }
    }

    // Include tool calls if any were made
    const finalExtras = { ...extras, tokensPerSec };
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
