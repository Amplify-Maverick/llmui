import { create } from "zustand";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants/config.js";
import { loadFromStorage, saveToStorage } from "../utils/storage.js";

export const useSettingsStore = create((set, get) => ({
  ...DEFAULT_SETTINGS,
  isLoading: true,

  loadSettings: async () => {
    const saved = await loadFromStorage(STORAGE_KEYS.settings);
    if (saved) {
      set({ ...saved, isLoading: false });
    } else {
      set({ isLoading: false });
    }
  },

  updateSetting: (key, value) => {
    set({ [key]: value });
    const state = get();
    saveToStorage(STORAGE_KEYS.settings, {
      ollamaBaseUrl: state.ollamaBaseUrl,
      defaultModel: state.defaultModel,
      systemPrompt: state.systemPrompt,
      temperature: state.temperature,
      maxTokens: state.maxTokens,
      customTags: state.customTags,
      enableThinking: state.enableThinking,
    });
  },

  resetSettings: () => {
    set(DEFAULT_SETTINGS);
    saveToStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  },
}));
