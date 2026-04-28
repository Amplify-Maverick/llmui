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

  setStreaming: (isStreaming, content = "") => {
    set({ isStreaming, streamingContent: content });
  },

  appendStreamContent: (chunk) => {
    set((state) => ({
      streamingContent: state.streamingContent + chunk,
    }));
  },

  finalizeStream: (extras = {}) => {
    const { streamingContent, messages } = get();
    if (messages.length > 0) {
      const lastMessage = messages[messages.length - 1];
      if (lastMessage.role === "assistant") {
        get().updateMessage(lastMessage.id, streamingContent, extras);
      }
    }
    set({ isStreaming: false, streamingContent: "" });
    get().saveConversations();
  },
}));
