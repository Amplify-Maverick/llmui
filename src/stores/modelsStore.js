import { create } from "zustand";
import { llamaApi, parseProgress } from "../services/llamaApi.js";

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

function mapModel(m) {
  return {
    name: m.id,
    model: m.id,
    provider: "openai",
    status: m.status,
    failed: m.failed,
    exitCode: m.exitCode,
    canRemove: m.canRemove,
    memory: m.memory,
    size: m.size || 0,
    contextLength: m.contextLength || null,
    sidecars: m.sidecars || [],
    mmprojFileSize: m.mmprojFileSize ?? null,
  };
}

/** Refresh cached modelInfo.contextLength from a fresh router list. */
function syncContext(cache, models) {
  let next = cache;
  for (const m of models) {
    const info = cache[m.name];
    if (info && m.contextLength && info.contextLength !== m.contextLength) {
      if (next === cache) next = { ...cache };
      next[m.name] = { ...info, contextLength: m.contextLength };
    }
  }
  return next;
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

  // GPU as reported by the router: { name, total, margin, budget, source }
  gpu: null,
  // In-flight/finished installs keyed by model id:
  // { state: "starting" | "downloading" | "done" | "failed", done, total, error }
  downloads: {},

  fetchModels: async () => {
    set({ isLoading: true, error: null });
    try {
      const { models, gpu } = await llamaApi.list();
      const mapped = models.map(mapModel);
      set({ models: mapped, gpu, modelsLoaded: true, isLoading: false, modelInfoCache: syncContext(get().modelInfoCache, mapped) });
    } catch (error) {
      set({ error: error.message, isLoading: false });
    }
  },

  // Background refresh (status polling): no loading flag, keeps the last list on failure.
  refreshModels: async () => {
    try {
      const { models, gpu } = await llamaApi.list();
      const mapped = models.map(mapModel);
      set({ models: mapped, gpu, modelsLoaded: true, error: null, modelInfoCache: syncContext(get().modelInfoCache, mapped) });
    } catch (error) {
      set({ error: error.message });
    }
  },

  setDownload: (model, patch) =>
    set((state) => ({
      downloads: { ...state.downloads, [model]: { ...state.downloads[model], ...patch } },
    })),

  clearDownload: (model) =>
    set((state) => {
      const { [model]: _, ...rest } = state.downloads;
      return { downloads: rest };
    }),

  /** Apply one router event ({ type, model, data }) from /api/llama/events. */
  handleRouterEvent: (ev) => {
    const { setDownload, downloads } = get();
    // Router ids may differ in case from what we sent; reuse our key.
    const key = ev.model && (Object.keys(downloads).find((k) => k.toLowerCase() === ev.model.toLowerCase()) || ev.model);
    switch (ev.type) {
      case "download_progress": {
        const p = parseProgress(ev.data);
        setDownload(key, { state: "downloading", ...(p || {}) });
        return false;
      }
      case "download_finished":
        setDownload(key, { state: "done" });
        return true;
      case "download_failed":
        setDownload(key, {
          state: "failed",
          error: ev.data?.stopped ? "Download stopped" : ev.data?.error || ev.data?.message || "Download failed",
        });
        return true;
      default:
        // model_status, model_memory, model_remove, models_reload → refetch list
        return true;
    }
  },

  isModelAvailable: (name) => get().models.some((m) => m.name === name),

  fetchModelInfo: async (modelName) => {
    if (!modelName) return null;
    const { modelInfoCache, models } = get();
    if (modelInfoCache[modelName]) return modelInfoCache[modelName];

    const model = models.find((m) => m.name === modelName);
    // Not served (e.g. an old Ollama model name): unknown context, not cached
    // so it resolves properly if the model shows up later.
    if (!model) {
      return { name: modelName, contextLength: null, supportsTools: false, details: {}, rawParameters: "" };
    }

    // Runtime context from the router (n_ctx). If the list doesn't have it
    // and the model is loaded, ask its /props (never for unloaded models,
    // which that request would autoload).
    let contextLength = model.contextLength;
    if (!contextLength && model.status === "loaded") {
      contextLength = await llamaApi.props(modelName).then((p) => p.contextLength, () => null);
    }

    const modelInfo = {
      name: modelName,
      contextLength: contextLength || null,
      supportsTools: nameSuggestsToolSupport(modelName),
      details: { provider: "openai" },
      rawParameters: "",
    };
    // Only cache once the context is known; until then, retry next time.
    if (modelInfo.contextLength) {
      set((state) => ({
        modelInfoCache: { ...state.modelInfoCache, [modelName]: modelInfo },
      }));
    }
    return modelInfo;
  },

  clearError: () => set({ error: null }),
}));
