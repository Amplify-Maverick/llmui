import { create } from "zustand";
import { ollamaApi } from "../services/ollamaApi.js";

export const useModelsStore = create((set, get) => ({
  localModels: [],
  runningModels: [],
  modelInfoCache: {},
  isLoading: false,
  error: null,
  pullProgress: null,
  localCapability: { models: [], hardware: null },

  fetchModels: async () => {
    set({ isLoading: true, error: null });
    try {
      const data = await ollamaApi.listModels();
      set({ localModels: data.models || [], isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },

  fetchLocalCapability: async () => {
    try {
      const result = await ollamaApi.getLocalCapability();
      set({ localCapability: result });
      return result;
    } catch (error) {
      set({ error: error.message });
      return null;
    }
  },

  fetchRunningModels: async () => {
    try {
      const data = await ollamaApi.listRunningModels();
      set({ runningModels: data.models || [] });
    } catch (error) {
      console.error("Failed to fetch running models:", error);
    }
  },

  pullModel: async (name) => {
    set({ pullProgress: { model: name, status: "starting", progress: 0 } });

    try {
      for await (const chunk of ollamaApi.pullModel(name)) {
        if (chunk.error) {
          throw new Error(chunk.error);
        }
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
    try {
      await ollamaApi.deleteModel(name);
      await get().fetchModels();
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  unloadModel: async (name) => {
    try {
      await ollamaApi.unloadModel(name);
      await get().fetchRunningModels();
    } catch (error) {
      set({ error: error.message });
      throw error;
    }
  },

  fetchModelInfo: async (modelName) => {
    if (!modelName) return null;
    const { modelInfoCache } = get();
    if (modelInfoCache[modelName]) return modelInfoCache[modelName];

    try {
      const info = await ollamaApi.showModel(modelName);
      // Extract context window from model parameters
      let contextLength = null;

      // Check modelfile parameters for num_ctx
      if (info.parameters) {
        const match = info.parameters.match(/num_ctx\s+(\d+)/);
        if (match) contextLength = parseInt(match[1], 10);
      }

      // Check model_info for context_length keys
      if (!contextLength && info.model_info) {
        for (const [key, value] of Object.entries(info.model_info)) {
          if (key.includes("context_length") && typeof value === "number") {
            contextLength = value;
            break;
          }
        }
      }

      // Default fallback based on common models
      if (!contextLength) contextLength = 4096;

      // Detect tool calling support
      let supportsTools = false;

      // Check template for tool-related markers
      if (info.template) {
        const template = info.template.toLowerCase();
        if (
          template.includes("tool") ||
          template.includes("<|python") ||
          template.includes("function") ||
          template.includes("<tool_call>")
        ) {
          supportsTools = true;
        }
      }

      // Heuristic: known model families that support tools
      if (!supportsTools) {
        const toolFamilies = [
          "llama3", "llama-3", "llama:3",
          "qwen", "qwen2",
          "mistral", "mixtral",
          "command-r", "command",
          "granite",
          "hermes",
          "firefunction",
        ];
        const lowerName = modelName.toLowerCase();
        supportsTools = toolFamilies.some((f) => lowerName.includes(f));
      }

      const modelInfo = {
        name: modelName,
        contextLength,
        supportsTools,
        details: info.details || {},
        rawParameters: info.parameters || "",
      };

      set((state) => ({
        modelInfoCache: { ...state.modelInfoCache, [modelName]: modelInfo },
      }));

      return modelInfo;
    } catch (error) {
      console.error("Failed to fetch model info:", error);
      return { name: modelName, contextLength: 4096, details: {}, rawParameters: "" };
    }
  },

  clearError: () => set({ error: null }),
}));
