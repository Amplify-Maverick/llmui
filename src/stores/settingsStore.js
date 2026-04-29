import { create } from "zustand";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants/config.js";
import { loadFromStorage, saveToStorage } from "../utils/storage.js";
import { ollamaApi } from "../services/ollamaApi.js";

export const useSettingsStore = create((set, get) => ({
  ...DEFAULT_SETTINGS,
  // Ollama URL is managed server-side; this is just for display/editing in the UI
  ollamaUrl: "http://localhost:11434",
  ollamaUrlLoading: false,
  ollamaUrlError: null,
  isLoading: true,

  loadSettings: async () => {
    const saved = await loadFromStorage(STORAGE_KEYS.settings);
    if (saved) {
      // Filter out legacy ollamaBaseUrl if present
      const { ollamaBaseUrl, ...rest } = saved;
      set({ ...rest, isLoading: false });
    } else {
      set({ isLoading: false });
    }

    // Load Ollama URL from server
    try {
      const url = await ollamaApi.getOllamaUrl();
      set({ ollamaUrl: url });
    } catch (error) {
      console.error("Failed to load Ollama URL from server:", error);
    }
  },

  updateSetting: (key, value) => {
    set({ [key]: value });
    const state = get();
    saveToStorage(STORAGE_KEYS.settings, {
      defaultModel: state.defaultModel,
      systemPrompt: state.systemPrompt,
      temperature: state.temperature,
      maxTokens: state.maxTokens,
      customTags: state.customTags,
      enableThinking: state.enableThinking,
      enableTools: state.enableTools,
      enabledTools: state.enabledTools,
      theme: state.theme,
    });
  },

  updateOllamaUrl: async (url) => {
    set({ ollamaUrlLoading: true, ollamaUrlError: null });
    try {
      await ollamaApi.setOllamaUrl(url);
      set({ ollamaUrl: url, ollamaUrlLoading: false });
    } catch (error) {
      set({ ollamaUrlError: error.message, ollamaUrlLoading: false });
      throw error;
    }
  },

  resetSettings: () => {
    set(DEFAULT_SETTINGS);
    saveToStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  },
}));
