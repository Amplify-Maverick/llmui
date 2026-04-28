export const TABS = {
  chat: { key: "chat", label: "Chat", color: "#6ee7b7" },
  models: { key: "models", label: "Models", color: "#60a5fa" },
  stats: { key: "stats", label: "System", color: "#fcd34d" },
  settings: { key: "settings", label: "Settings", color: "#c4b5fd" },
};

export const DEFAULT_SETTINGS = {
  defaultModel: "",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  customTags: [],
  enableThinking: false,
};

export const STORAGE_KEYS = {
  settings: "llmui_settings",
  conversations: "llmui_conversations", // legacy — kept for migration detection
  convIndex: "llmui_conv_index",
  convMessages: (id) => `llmui_conv_${id}`,
  activeConversation: "llmui_active_conversation",
};
