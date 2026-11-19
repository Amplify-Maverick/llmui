import { create } from "zustand";
import { openaiApi } from "../services/openaiApi.js";

// Known model families that support tool calling (name-based heuristic).
const TOOL_FAMILIES = [
  "llama3", "llama-3", "llama:3",
  "qwen", "qwen2",
  "mistral", "mixtral",
  "command-r", "command",
  "granite",
  "hermes",
  "firefunction",
  "gpt-oss",
  "glm",
];

function nameSuggestsToolSupport(modelName) {
  const lowerName = modelName.toLowerCase();
  return TOOL_FAMILIES.some((f) => lowerName.includes(f));
}

export const MODEL_STATUS_LABEL = {
  loaded: "loaded",
  loading: "loading…",
  unloaded: "not loaded",
  sleeping: "sleeping",
  downloading: "downloading…",
  incomplete: "incomplete download",
  unknown: "status unknown",
};

export function modelStatusLabel(m) {
  if (m?.failed) return "failed to load";
  return MODEL_STATUS_LABEL[m?.status] || m?.status || "";
}

export const useModelsStore = create((set, get) => ({
  // Models known to the llama.cpp router (the only model source):
  // [{ name, model, provider: "openai", status, failed, memory, size, contextLength }]
  models: [],
  // True once a model list has been fetched successfully at least once, so the
  // UI can tell "model isn't served" apart from "list not loaded yet / server down".
  modelsLoaded: false,
  modelInfoCache: {},
  isLoading: false,
  error: null,

  fetchModels: async () => {
    set({ isLoading: true, error: null });
    try {
      const models = await openaiApi.listModels();
      set({ models, modelsLoaded: true, isLoading: false });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },

  // Background refresh (status polling): no loading flag, keeps the last list on failure.
  refreshModels: async () => {
    try {
      const models = await openaiApi.listModels();
      set({ models, modelsLoaded: true, error: null });
    } catch (error) {
      set({ error: error.message });
    }
  },

  isModelAvailable: (name) => get().models.some((m) => m.name === name),

  fetchModelInfo: async (modelName) => {
    if (!modelName) return null;
    const { modelInfoCache, models } = get();
    if (modelInfoCache[modelName]) return modelInfoCache[modelName];

    const model = models.find((m) => m.name === modelName);
    // Not served (e.g. an old Ollama model name) — return a default without
    // caching so it resolves properly if the model shows up later.
    if (!model) {
      return { name: modelName, contextLength: 4096, supportsTools: false, details: {}, rawParameters: "" };
    }

    const modelInfo = {
      name: modelName,
      contextLength: model.contextLength || 4096,
      supportsTools: nameSuggestsToolSupport(modelName),
      details: { provider: "openai" },
      rawParameters: "",
    };
    set((state) => ({
      modelInfoCache: { ...state.modelInfoCache, [modelName]: modelInfo },
    }));
    return modelInfo;
  },

  clearError: () => set({ error: null }),
}));
