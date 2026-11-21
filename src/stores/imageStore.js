import { create } from "zustand";
import { imageApi } from "../services/imageApi.js";

const toInterrupted = (job) => ({ id: job.id, params: job.params, machine: job.machine });

// Interrupted jobs the user dismissed (per browser), so a reload doesn't bring them back.
const DISMISSED_KEY = "llmui_dismissed_interrupted_jobs";
function isDismissed(id) {
  try {
    return JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]").includes(id);
  } catch {
    return false;
  }
}
function dismiss(id) {
  if (!id) return;
  try {
    const ids = JSON.parse(localStorage.getItem(DISMISSED_KEY) || "[]");
    localStorage.setItem(DISMISSED_KEY, JSON.stringify([id, ...ids].slice(0, 20)));
  } catch {
    // storage unavailable: it just shows again after a reload
  }
}

export const useImageStore = create((set, get) => ({
  // Connection
  isConnected: false,
  connectionError: null,

  serverUrl: null,

  // Available models/options from sd-server
  checkpoints: [],
  modelDefaults: {}, // checkpoint id → { width, height, steps, cfgScale, sampler } from its recipe
  samplers: [],
  schedulers: [],

  // Generation state
  isGenerating: false,
  progress: 0,
  progressStep: 0,
  progressTotalSteps: 0,
  stage: null, // freeing_gpu | loading_model | queued | sampling | vae_decode | ...
  stageMessage: "",
  lastTimings: null, // { totalMs, generateMs } of the last finished job
  currentGenerationId: null,
  currentImages: [], // { id, generationId }
  error: null,
  // A job the server restart cut off: { id, params, machine } (Retry runs it
  // again with the same settings), or null.
  interruptedJob: null,

  // Generation parameters
  params: {
    prompt: "",
    negativePrompt: "",
    checkpoint: "",
    width: 512,
    height: 512,
    steps: 20,
    cfgScale: 7,
    sampler: "euler_a",
    scheduler: "",
    seed: -1,
    batchCount: 1,
  },

  // History (DB-backed)
  generations: [],
  generationsTotal: 0,
  generationsPage: 1,
  selectedGeneration: null,
  isLoadingHistory: false,

  // The job being watched (it runs on the server whether or not it's watched)
  _jobId: null,
  _watch: null,
  _defaultsApplied: false,

  // ── Actions ──────────────────────────────────────────────────────────

  checkConnection: async () => {
    const status = await imageApi.status();
    set({
      isConnected: !!status.ok,
      serverUrl: status.url || null,
      connectionError: status.ok ? null : status.error || "sd-server not reachable",
    });
    return !!status.ok;
  },

  fetchOptions: async () => {
    try {
      const opts = await imageApi.options();
      set((state) => {
        const update = {
          checkpoints: opts.checkpoints || [],
          modelDefaults: opts.modelDefaults || {},
          samplers: opts.samplers || [],
          schedulers: opts.schedulers || [],
        };
        // First load: take the defaults from the machine's sd config.
        if (!state._defaultsApplied && opts.defaults) {
          update.params = { ...state.params, ...opts.defaults, checkpoint: opts.defaults.checkpoint || "" };
          update._defaultsApplied = true;
        } else if (!update.checkpoints.includes(state.params.checkpoint)) {
          // None picked yet, the picked one was deleted / lost its setup, or
          // requests now go to a machine that doesn't have it. Never keep a
          // model this machine can't load: no model means Generate is off.
          const pick = opts.defaults?.checkpoint && update.checkpoints.includes(opts.defaults.checkpoint)
            ? opts.defaults.checkpoint
            : update.checkpoints[0] || "";
          update.params = { ...state.params, checkpoint: pick, ...(update.modelDefaults[pick] || {}) };
        }
        return update;
      });
    } catch (err) {
      console.error("Failed to fetch image options:", err);
      set({ connectionError: err.message });
    }
  },

  fetchAll: async () => {
    const { checkConnection, fetchOptions } = get();
    if (await checkConnection()) await fetchOptions();
  },

  updateParam: (key, value) => {
    set((state) => ({
      // Switching model also switches to its recipe's size/steps/CFG/sampler.
      params: key === "checkpoint" && state.modelDefaults[value]
        ? { ...state.params, ...state.modelDefaults[value], checkpoint: value }
        : { ...state.params, [key]: value },
    }));
  },

  updateParams: (updates) => {
    set((state) => ({
      params: { ...state.params, ...updates },
    }));
  },

  // ── Generate ─────────────────────────────────────────────────────────

  generate: async () => {
    const { params, isGenerating, checkpoints } = get();
    if (isGenerating) return;
    // Never start a job for a model this machine doesn't have (it would make
    // sd-server try to load a missing file).
    if (!checkpoints.includes(params.checkpoint)) {
      set({ error: checkpoints.length ? "Select a model" : "No image models on this machine; install one under Models → Image" });
      return;
    }
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
      stage: "starting",
      stageMessage: "Starting…",
      currentGenerationId: null,
      currentImages: [],
      selectedGeneration: null,
      error: null,
      interruptedJob: null,
    });

    try {
      const handle = await imageApi.txt2img(params, get()._onJobEvent);
      set({ _jobId: handle.jobId, _watch: handle });
    } catch (err) {
      set({
        isGenerating: false,
        error: err.message,
        progress: 0,
        stage: null,
      });
    }
  },

  /** One event of the job being watched (docs/api.md §8.3). */
  _onJobEvent: (event) => {
    switch (event.type) {
      case "job":
        set({ _jobId: event.jobId });
        break;
      case "stage":
        set({ stage: event.stage, stageMessage: event.message || "" });
        break;
      case "progress":
        set((state) => ({
          stage: event.stage,
          stageMessage: "",
          progress: event.value ?? state.progress,
          progressStep: event.step,
          progressTotalSteps: event.totalSteps,
        }));
        break;
      case "complete":
        set({
          isGenerating: false,
          progress: 1,
          stage: null,
          lastTimings: event.timings ? { ...event.timings, generationId: event.generationId } : null,
          currentGenerationId: event.generationId,
          currentImages: event.imageIds.map((id) => ({ id, generationId: event.generationId })),
          _jobId: null,
          _watch: null,
        });
        // Show its seed/steps/size without overwriting the form (seed stays -1).
        imageApi.getGeneration(event.generationId)
          .then((gen) => set({ selectedGeneration: gen }))
          .catch(() => {});
        get().loadHistory();
        break;
      case "interrupted": {
        // The server restarted mid-job. Offer the same settings again.
        const jobId = get()._jobId;
        set({ isGenerating: false, progress: 0, stage: null, _jobId: null, _watch: null });
        get()._showInterrupted(jobId);
        break;
      }
      case "error":
      case "cancelled":
        set({
          isGenerating: false,
          error: event.type === "error" ? event.error : null,
          progress: 0,
          stage: null,
          _jobId: null,
          _watch: null,
        });
        break;
    }
  },

  /**
   * A job still running on the server (started before a reload, or from
   * another device): show it and follow it to the end.
   */
  resumeJob: async () => {
    if (get().isGenerating) return;
    let jobs;
    try {
      ({ jobs } = await imageApi.listJobs());
    } catch {
      return;
    }
    const job = jobs?.find((j) => j.status === "running");
    if (!job) {
      // The newest job was cut off by a server restart: show it with Retry.
      if (jobs?.[0]?.status === "interrupted" && !isDismissed(jobs[0].id)) set({ interruptedJob: toInterrupted(jobs[0]) });
      return;
    }
    if (get().isGenerating) return;
    set({
      isGenerating: true,
      progress: job.progress?.value ?? 0,
      progressStep: job.progress?.step ?? 0,
      progressTotalSteps: job.progress?.totalSteps ?? 0,
      stage: job.stage || "starting",
      stageMessage: job.message || "",
      currentGenerationId: null,
      currentImages: [],
      error: null,
      _jobId: job.id,
    });
    set({ _watch: imageApi.watchJob(job.id, get()._onJobEvent, job.seq) });
  },

  /** Fetch an interrupted job's settings and show it with Retry. */
  _showInterrupted: async (jobId) => {
    if (!jobId) return;
    try {
      const job = await imageApi.getJob(jobId);
      if (job?.status === "interrupted") set({ interruptedJob: toInterrupted(job) });
    } catch {
      set({ error: "The server restarted while generating; the image was lost" });
    }
  },

  /** Run an interrupted job again with the same settings (same seed too). */
  retryInterrupted: () => {
    const job = get().interruptedJob;
    if (!job?.params || get().isGenerating) return;
    dismiss(job.id);
    const p = job.params;
    set((state) => ({
      interruptedJob: null,
      params: {
        ...state.params,
        prompt: p.prompt ?? state.params.prompt,
        negativePrompt: p.negativePrompt ?? "",
        checkpoint: p.checkpoint ?? state.params.checkpoint,
        width: p.width, height: p.height, steps: p.steps, cfgScale: p.cfgScale,
        sampler: p.sampler, scheduler: p.scheduler || "", seed: p.seed ?? -1, batchCount: p.batchCount ?? 1,
      },
    }));
    get().generate();
  },

  dismissInterrupted: () => {
    dismiss(get().interruptedJob?.id);
    set({ interruptedJob: null });
  },

  // Stop the job on the server; its stream then ends with "cancelled".
  cancelGeneration: async () => {
    const { _jobId, _watch } = get();
    if (!_jobId) return;
    set({ stage: "cancelling", stageMessage: "Cancelling…" });
    try {
      await imageApi.cancelJob(_jobId);
    } catch (err) {
      _watch?.detach();
      set({ isGenerating: false, progress: 0, stage: null, error: err.message, _jobId: null, _watch: null });
    }
  },

  // ── History ──────────────────────────────────────────────────────────

  loadHistory: async (page = 1) => {
    set({ isLoadingHistory: true });
    try {
      const data = await imageApi.listGenerations(page, 20);
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
      const gen = await imageApi.getGeneration(id);
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
          sampler: gen.sampler || "euler_a",
          scheduler: gen.scheduler || "",
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
      await imageApi.deleteGeneration(id);
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
    return imageApi.getImageUrl(generationId, imageId);
  },

  clearError: () => set({ error: null }),
}));
