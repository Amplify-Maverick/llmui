import { create } from "zustand";
import { comfyApi } from "../services/comfyApi.js";

export const useImageStore = create((set, get) => ({
  // Connection
  isConnected: false,
  connectionError: null,

  // Available models/options from ComfyUI
  checkpoints: [],
  loras: [],
  samplers: [],
  schedulers: [],

  // Generation state
  isGenerating: false,
  progress: 0,
  progressStep: 0,
  progressTotalSteps: 0,
  currentGenerationId: null,
  currentImages: [], // { id, generationId }
  error: null,

  // Generation parameters
  params: {
    prompt: "",
    negativePrompt: "",
    checkpoint: "",
    width: 512,
    height: 512,
    steps: 20,
    cfgScale: 7,
    sampler: "euler",
    scheduler: "normal",
    seed: -1,
    batchCount: 1,
  },

  // History (DB-backed)
  generations: [],
  generationsTotal: 0,
  generationsPage: 1,
  selectedGeneration: null,
  isLoadingHistory: false,

  // Abort handle
  _abortHandle: null,

  // ── Actions ──────────────────────────────────────────────────────────

  checkConnection: async () => {
    try {
      const ok = await comfyApi.checkConnection();
      set({ isConnected: ok, connectionError: ok ? null : "ComfyUI not reachable" });
      return ok;
    } catch (err) {
      set({ isConnected: false, connectionError: err.message });
      return false;
    }
  },

  fetchCheckpoints: async () => {
    try {
      const models = await comfyApi.listCheckpoints();
      set((state) => {
        const update = { checkpoints: models };
        // Auto-select first checkpoint if none selected
        if (!state.params.checkpoint && models.length > 0) {
          update.params = { ...state.params, checkpoint: models[0] };
        }
        return update;
      });
    } catch (err) {
      console.error("Failed to fetch checkpoints:", err);
    }
  },

  fetchLoras: async () => {
    try {
      const models = await comfyApi.listLoras();
      set({ loras: models });
    } catch (err) {
      console.error("Failed to fetch LoRAs:", err);
    }
  },

  fetchSamplers: async () => {
    try {
      const data = await comfyApi.listSamplers();
      set({ samplers: data.samplers || [], schedulers: data.schedulers || [] });
    } catch (err) {
      console.error("Failed to fetch samplers:", err);
    }
  },

  fetchAll: async () => {
    const { checkConnection, fetchCheckpoints, fetchLoras, fetchSamplers } = get();
    const ok = await checkConnection();
    if (ok) {
      await Promise.all([fetchCheckpoints(), fetchLoras(), fetchSamplers()]);
    }
  },

  updateParam: (key, value) => {
    set((state) => ({
      params: { ...state.params, [key]: value },
    }));
  },

  updateParams: (updates) => {
    set((state) => ({
      params: { ...state.params, ...updates },
    }));
  },

  // ── Generate ─────────────────────────────────────────────────────────

  generate: async () => {
    const { params, isGenerating } = get();
    if (isGenerating) return;
    if (!params.prompt.trim()) {
      set({ error: "Prompt is required" });
      return;
    }
    if (!params.checkpoint) {
      set({ error: "No checkpoint model selected" });
      return;
    }

    set({
      isGenerating: true,
      progress: 0,
      progressStep: 0,
      progressTotalSteps: 0,
      currentGenerationId: null,
      currentImages: [],
      error: null,
    });

    try {
      const handle = await comfyApi.txt2img(params, (event) => {
        switch (event.type) {
          case "queued":
            // Generation queued
            break;
          case "progress":
            set({
              progress: event.value,
              progressStep: event.step,
              progressTotalSteps: event.totalSteps,
            });
            break;
          case "complete":
            set({
              isGenerating: false,
              progress: 1,
              currentGenerationId: event.generationId,
              currentImages: event.imageIds.map((id) => ({
                id,
                generationId: event.generationId,
              })),
              _abortHandle: null,
            });
            // Refresh history
            get().loadHistory();
            break;
          case "error":
            set({
              isGenerating: false,
              error: event.error,
              progress: 0,
              _abortHandle: null,
            });
            break;
        }
      });

      set({ _abortHandle: handle });
    } catch (err) {
      set({
        isGenerating: false,
        error: err.message,
        progress: 0,
      });
    }
  },

  cancelGeneration: () => {
    const { _abortHandle } = get();
    if (_abortHandle) {
      _abortHandle.abort();
      set({
        isGenerating: false,
        progress: 0,
        _abortHandle: null,
      });
    }
  },

  // ── History ──────────────────────────────────────────────────────────

  loadHistory: async (page = 1) => {
    set({ isLoadingHistory: true });
    try {
      const data = await comfyApi.listGenerations(page, 20);
      set({
        generations: data.generations || [],
        generationsTotal: data.total || 0,
        generationsPage: page,
        isLoadingHistory: false,
      });
    } catch (err) {
      console.error("Failed to load history:", err);
      set({ isLoadingHistory: false });
    }
  },

  selectGeneration: async (id) => {
    if (!id) {
      set({ selectedGeneration: null, currentImages: [], currentGenerationId: null });
      return;
    }
    try {
      const gen = await comfyApi.getGeneration(id);
      set({
        selectedGeneration: gen,
        currentGenerationId: id,
        currentImages: (gen.images || []).map((img) => ({
          id: img.id,
          generationId: id,
        })),
        // Load the params from the selected generation for easy re-use
        params: {
          prompt: gen.prompt || "",
          negativePrompt: gen.negative_prompt || "",
          checkpoint: gen.model || "",
          width: gen.width || 512,
          height: gen.height || 512,
          steps: gen.steps || 20,
          cfgScale: gen.cfg_scale || 7,
          sampler: gen.sampler || "euler",
          scheduler: gen.scheduler || "normal",
          seed: gen.seed ?? -1,
          batchCount: gen.batch_count || 1,
        },
      });
    } catch (err) {
      console.error("Failed to select generation:", err);
    }
  },

  deleteGeneration: async (id) => {
    try {
      await comfyApi.deleteGeneration(id);
      const { currentGenerationId } = get();
      if (currentGenerationId === id) {
        set({ currentGenerationId: null, currentImages: [], selectedGeneration: null });
      }
      await get().loadHistory(get().generationsPage);
    } catch (err) {
      console.error("Failed to delete generation:", err);
    }
  },

  getImageUrl: (generationId, imageId) => {
    return comfyApi.getImageUrl(generationId, imageId);
  },

  clearError: () => set({ error: null }),
}));
