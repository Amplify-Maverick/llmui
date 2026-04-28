import { create } from "zustand";
import { nanoid } from "nanoid";
import { STORAGE_KEYS } from "../constants/config.js";
import { loadFromStorage, saveToStorage } from "../utils/storage.js";

export const useChatStore = create((set, get) => ({
  conversations: [],
  activeConversationId: null,
  messages: [],
  isStreaming: false,
  streamingContent: "",
  streamingTokenCount: 0,
  streamingStartTime: null,

  loadConversations: () => {
    const saved = loadFromStorage(STORAGE_KEYS.conversations);
    const activeId = loadFromStorage(STORAGE_KEYS.activeConversation);
    if (saved) {
      set({ conversations: saved });
      if (activeId && saved.find((c) => c.id === activeId)) {
        get().setActiveConversation(activeId);
      }
    }
  },

  saveConversations: () => {
    const { conversations } = get();
    saveToStorage(STORAGE_KEYS.conversations, conversations);
  },

  createConversation: (model) => {
    const id = nanoid();
    const conversation = {
      id,
      title: "New Chat",
      messages: [],
      model,
      tags: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    set((state) => ({
      conversations: [conversation, ...state.conversations],
      activeConversationId: id,
      messages: [],
    }));
    get().saveConversations();
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
    get().saveConversations();
  },

  renameConversation: (id, title) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, title, updatedAt: Date.now() } : c
      ),
    }));
    get().saveConversations();
  },

  updateConversationTags: (id, tags) => {
    set((state) => ({
      conversations: state.conversations.map((c) =>
        c.id === id ? { ...c, tags, updatedAt: Date.now() } : c
      ),
    }));
    get().saveConversations();
  },

  setActiveConversation: (id) => {
    const { conversations } = get();
    const conversation = conversations.find((c) => c.id === id);
    if (conversation) {
      set({
        activeConversationId: id,
        messages: conversation.messages || [],
      });
      saveToStorage(STORAGE_KEYS.activeConversation, id);
    }
  },

  deleteConversation: (id) => {
    set((state) => {
      const newConversations = state.conversations.filter((c) => c.id !== id);
      const newActiveId =
        state.activeConversationId === id
          ? newConversations[0]?.id || null
          : state.activeConversationId;
      return {
        conversations: newConversations,
        activeConversationId: newActiveId,
        messages:
          newActiveId === state.activeConversationId
            ? state.messages
            : newConversations.find((c) => c.id === newActiveId)?.messages || [],
      };
    });
    get().saveConversations();
  },

  addMessage: (message) => {
    const id = nanoid();
    const newMessage = { id, ...message, timestamp: Date.now() };

    set((state) => {
      const newMessages = [...state.messages, newMessage];
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? {
              ...c,
              messages: newMessages,
              title:
                c.title === "New Chat" && message.role === "user"
                  ? message.content.slice(0, 30) + (message.content.length > 30 ? "..." : "")
                  : c.title,
              updatedAt: Date.now(),
            }
          : c
      );
      return { messages: newMessages, conversations };
    });
    get().saveConversations();
    return id;
  },

  updateMessage: (id, content, extras = {}) => {
    set((state) => {
      const newMessages = state.messages.map((m) =>
        m.id === id ? { ...m, content, ...extras } : m
      );
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, messages: newMessages, updatedAt: Date.now() }
          : c
      );
      return { messages: newMessages, conversations };
    });
  },

  deleteMessage: (id) => {
    set((state) => {
      const newMessages = state.messages.filter((m) => m.id !== id);
      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, messages: newMessages, updatedAt: Date.now() }
          : c
      );
      return { messages: newMessages, conversations };
    });
    get().saveConversations();
  },

  // Edit a user message and remove all subsequent messages (for regeneration)
  editMessageAndTruncate: (id, newContent) => {
    set((state) => {
      const messageIndex = state.messages.findIndex((m) => m.id === id);
      if (messageIndex === -1) return state;

      const editedMessage = { ...state.messages[messageIndex], content: newContent };
      const newMessages = [...state.messages.slice(0, messageIndex), editedMessage];

      const conversations = state.conversations.map((c) =>
        c.id === state.activeConversationId
          ? { ...c, messages: newMessages, updatedAt: Date.now() }
          : c
      );
      return { messages: newMessages, conversations };
    });
    get().saveConversations();
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
            ? { ...c, messages: newMessages, updatedAt: Date.now() }
            : c
        );
        return { messages: newMessages, conversations };
      }
      return state;
    });
    get().saveConversations();
  },

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

  finalizeStream: (extras = {}) => {
    const { streamingContent, messages, streamingTokenCount, streamingStartTime } = get();

    // Calculate tokens per second
    let tokensPerSec = null;
    if (streamingStartTime && streamingTokenCount > 0) {
      const elapsedSeconds = (Date.now() - streamingStartTime) / 1000;
      if (elapsedSeconds > 0) {
        tokensPerSec = streamingTokenCount / elapsedSeconds;
      }
    }

    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === "assistant") {
        get().updateMessage(lastMessage.id, streamingContent, { ...extras, tokensPerSec });
      }
    }
    set({
      isStreaming: false,
      streamingContent: "",
      streamingTokenCount: 0,
      streamingStartTime: null,
    });
    get().saveConversations();
  },

  // Export conversation as JSON or Markdown
  exportConversation: (id, format = "json") => {
    const { conversations } = get();
    const conversation = conversations.find((c) => c.id === id);
    if (!conversation) return null;

    if (format === "json") {
      return JSON.stringify(conversation, null, 2);
    }

    if (format === "markdown") {
      let md = `# ${conversation.title}\n\n`;
      md += `**Model:** ${conversation.model || "Unknown"}\n`;
      md += `**Created:** ${new Date(conversation.createdAt).toLocaleString()}\n`;
      md += `**Tags:** ${conversation.tags?.join(", ") || "None"}\n\n`;
      md += `---\n\n`;

      for (const msg of conversation.messages) {
        const role = msg.role === "user" ? "**You**" : "**Assistant**";
        md += `${role}\n\n${msg.content}\n\n---\n\n`;
      }

      return md;
    }

    return null;
  },
}));
