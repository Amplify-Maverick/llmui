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
  enableTools: false,
  enabledTools: ["web_search", "get_current_time"],
};

// Available tools for the UI
export const AVAILABLE_TOOLS = [
  { name: "web_search", displayName: "Web Search", description: "Search the web using DuckDuckGo" },
  { name: "fetch_url", displayName: "Fetch URL", description: "Fetch content from a URL" },
  { name: "get_current_time", displayName: "Current Time", description: "Get the current date and time" },
  { name: "calculator", displayName: "Calculator", description: "Evaluate mathematical expressions" },
  { name: "file_read", displayName: "File Read", description: "Read files from the tool sandbox" },
];

export const STORAGE_KEYS = {
  settings: "llmui_settings",
  conversations: "llmui_conversations", // legacy — kept for migration detection
  convIndex: "llmui_conv_index",
  convMessages: (id) => `llmui_conv_${id}`,
  activeConversation: "llmui_active_conversation",
};
