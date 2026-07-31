import { create } from "zustand";
import { DEFAULT_SETTINGS, STORAGE_KEYS } from "../constants/config.js";
import { MODE_TAGS } from "../constants/modeTags.js";
import { loadFromStorage, saveToStorage } from "../utils/storage.js";
import { ollamaApi } from "../services/ollamaApi.js";
import { comfyApi } from "../services/comfyApi.js";

export const useSettingsStore = create((set, get) => ({
  ...DEFAULT_SETTINGS,
  // Ollama URL is managed server-side; this is just for display/editing in the UI
  ollamaUrl: "http://localhost:11434",
  remoteOllamaUrl: null,
  activeTarget: null, // 'local' | 'remote' | null (manual)
  remoteStatus: { configured: false, online: null, checkedAt: null, latencyMs: null, error: null },
  ollamaUrlLoading: false,
  ollamaUrlError: null,
  serverSwitching: false,
  serverSwitchError: null,
  // ComfyUI URL is also managed server-side
  comfyuiUrl: "http://localhost:8188",
  comfyuiUrlLoading: false,
  comfyuiUrlError: null,
  // ComfyUI models path for downloading models
  comfyModelsPath: "",
  comfyModelsPathLoading: false,
  comfyModelsPathError: null,
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
      set({
        ollamaUrl: config.ollamaUrl,
        remoteOllamaUrl: config.remoteOllamaUrl || null,
        activeTarget: config.activeTarget || null,
        remoteStatus: config.remoteStatus || get().remoteStatus,
      });
    } catch (error) {
      console.error("Failed to load Ollama config from server:", error);
    }

    get().ensureModeTags();
  },

  // Seed the Mini Mode / GPU Mode conversation tags if they aren't already
  // in the user's tag list (e.g. first run, or an install predating this feature).
  ensureModeTags: () => {
    const { customTags = [] } = get();
    const missing = MODE_TAGS.filter((mt) => !customTags.some((t) => t.id === mt.id));
    if (missing.length > 0) {
      get().updateSetting("customTags", [...customTags, ...missing]);
    }
  },

  fetchRemoteStatus: async () => {
    try {
      const status = await ollamaApi.getRemoteStatus();
      set({ remoteStatus: status });
    } catch {
      // keep last known status on a transient client-side fetch failure
    }

    // Load ComfyUI URL from server
    try {
      const url = await comfyApi.getConfig();
      set({ comfyuiUrl: url });
    } catch (error) {
      console.error("Failed to load ComfyUI URL from server:", error);
    }

    // Load ComfyUI models path from server
    try {
      const modelsPath = await comfyApi.getModelsPath();
      set({ comfyModelsPath: modelsPath });
    } catch (error) {
      console.error("Failed to load ComfyUI models path from server:", error);
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

  updateComfyuiUrl: async (url) => {
    set({ comfyuiUrlLoading: true, comfyuiUrlError: null });
    try {
      await comfyApi.setConfig(url);
      set({ comfyuiUrl: url, comfyuiUrlLoading: false });
    } catch (error) {
      set({ comfyuiUrlError: error.message, comfyuiUrlLoading: false });
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

  updateComfyModelsPath: async (path) => {
    set({ comfyModelsPathLoading: true, comfyModelsPathError: null });
    try {
      await comfyApi.setModelsPath(path);
      set({ comfyModelsPath: path, comfyModelsPathLoading: false });
    } catch (error) {
      set({ comfyModelsPathError: error.message, comfyModelsPathLoading: false });
      throw error;
    }
  },

  resetSettings: () => {
    set(DEFAULT_SETTINGS);
    saveToStorage(STORAGE_KEYS.settings, DEFAULT_SETTINGS);
  },
}));
