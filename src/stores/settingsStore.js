import { create } from "zustand";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants/config.js";
import { loadFromStorage, saveToStorage } from "../utils/storage.js";
import { ollamaApi } from "../services/ollamaApi.js";

export const useSettingsStore = create((set, get) => ({
  ...DEFAULT_SETTINGS,
  // Ollama URL is managed server-side; this is just for display/editing in the UI
  ollamaUrl: "http://localhost:11434",
  remoteOllamaUrl: null,
  activeTarget: null, // 'local' | 'remote' | null (manual)
  ollamaUrlLoading: false,
  ollamaUrlError: null,
  serverSwitching: false,
  serverSwitchError: null,
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

    // Load Ollama config from server
    try {
      const config = await ollamaApi.getConfig();
      set({ ollamaUrl: config.ollamaUrl, remoteOllamaUrl: config.remoteOllamaUrl || null, activeTarget: config.activeTarget || null });
    } catch (error) {
      console.error("Failed to load Ollama config from server:", error);
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
      const result = await ollamaApi.setOllamaUrl(url);
      set({ ollamaUrl: url, activeTarget: result.activeTarget || null, ollamaUrlLoading: false });
    } catch (error) {
      set({ ollamaUrlError: error.message, ollamaUrlLoading: false });
      throw error;
    }
  },

  updateRemoteOllamaUrl: async (url) => {
    set({ ollamaUrlLoading: true, ollamaUrlError: null });
    try {
      const result = await ollamaApi.setRemoteOllamaUrl(url || null);
      set({ remoteOllamaUrl: url || null, ollamaUrlLoading: false });
      return result;
    } catch (error) {
      set({ ollamaUrlError: error.message, ollamaUrlLoading: false });
      throw error;
    }
  },

  switchServer: async (target) => {
    set({ serverSwitching: true, serverSwitchError: null });
    try {
      const result = await ollamaApi.switchServer(target);
      set({ ollamaUrl: result.ollamaUrl, activeTarget: result.activeTarget, serverSwitching: false });
      return result;
    } catch (error) {
      set({ serverSwitchError: error.message, serverSwitching: false });
      throw error;
    }
  },

  resetSettings: () => {
    set(DEFAULT_SETTINGS);
    saveToStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  },
}));
