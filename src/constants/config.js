export const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export const TABS = {
  chat: { key: "chat", label: "Chat", color: "#6ee7b7" },
  models: { key: "models", label: "Models", color: "#60a5fa" },
  stats: { key: "stats", label: "System", color: "#fcd34d" },
  settings: { key: "settings", label: "Settings", color: "#c4b5fd" },
};

export const DEFAULT_SETTINGS = {
  ollamaBaseUrl: DEFAULT_OLLAMA_URL,
  defaultModel: "",
  systemPrompt: "",
  temperature: 0.7,
  maxTokens: 2048,
  customTags: [],
};

export const STORAGE_KEYS = {
  settings: "llmui_settings",
  conversations: "llmui_conversations",
  activeConversation: "llmui_active_conversation",
};
