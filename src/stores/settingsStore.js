import { create } from "zustand";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants/config.js";
import { loadFromStorage, saveToStorage } from "../utils/storage.js";

export const useSettingsStore = create((set, get) => ({
  ...DEFAULT_SETTINGS,
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

  resetSettings: () => {
    set(DEFAULT_SETTINGS);
    saveToStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  },
}));
