import { create } from "zustand";
import { ollamaApi } from "../services/ollamaApi.js";
import { useSettingsStore } from "./settingsStore.js";

const syncApiUrl = () => {
  const { ollamaBaseUrl } = useSettingsStore.getState();
  ollamaApi.setBaseUrl(ollamaBaseUrl);
};

export const useModelsStore = create((set, get) => ({
  localModels: [],
  runningModels: [],
  isLoading: false,
  error: null,
  pullProgress: null,

  fetchModels: async () => {
    syncApiUrl();
    set({ isLoading: true, error: null });
    try {
      const data = await ollamaApi.listModels();
      set({ localModels: data.models || [], isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },

  fetchRunningModels: async () => {
    syncApiUrl();
    try {
      const data = await ollamaApi.listRunningModels();
      set({ runningModels: data.models || [] });
    } catch (error) {
      console.error("Failed to fetch running models:", error);
    }
  },

  pullModel: async (name) => {
    syncApiUrl();
    set({ pullProgress: { model: name, status: "starting", progress: 0 } });

    try {
      for await (const chunk of ollamaApi.pullModel(name)) {
        if (chunk.status) {
          const progress = chunk.completed && chunk.total
            ? Math.round((chunk.completed / chunk.total) * 100)
            : 0;
          set({
            pullProgress: {
              model: name,
              status: chunk.status,
              progress,
              completed: chunk.completed,
              total: chunk.total,
            },
          });
        }
      }
      set({ pullProgress: null });
      await get().fetchModels();
    } catch (error) {
      set({ pullProgress: null, error: error.message });
      throw error;
    }
  },

  deleteModel: async (name) => {
    syncApiUrl();
    try {
      await ollamaApi.deleteModel(name);
      await get().fetchModels();
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  clearError: () => set({ error: null }),
}));
