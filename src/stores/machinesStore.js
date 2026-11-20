import { create } from "zustand";
import { machinesApi } from "../services/machinesApi.js";
import { setPinnedMachines, setOnMachineChanged } from "../services/machinePin.js";
import { useModelsStore } from "./modelsStore.js";
import { useImageStore } from "./imageStore.js";

export const MACHINE_POLL_MS = 10000;

/**
 * Compute machines and where chat / images go (server/backends.js).
 * The server is the source of truth (it routes the requests); this store
 * mirrors GET /api/machines, polled while the page is visible.
 */
export const useMachinesStore = create((set, get) => ({
  machines: [], // [{ id, name, gpuLabel, isDefault, status: { online, llama, sd, fetch, checkedAt } | null }]
  selected: null,
  defaultId: "jellyfin",
  effective: { chat: null, image: null }, // where requests go right now
  fallback: { chat: null, image: null }, // { from, reason } when the selected machine is down
  loaded: false,
  error: null,
  switching: null, // id being selected

  machine: (id) => get().machines.find((m) => m.id === id) || null,

  _apply(data) {
    const prev = get().effective;
    setPinnedMachines(data.effective);
    set({
      machines: data.machines,
      selected: data.selected,
      defaultId: data.defaultId,
      effective: data.effective,
      fallback: data.fallback,
      loaded: true,
      error: null,
    });
    // Requests now go somewhere else: reload what the pages show. Nothing is
    // loaded or unloaded on either machine.
    if (prev.chat && prev.chat !== data.effective.chat) {
      useModelsStore.setState({ models: [], modelsLoaded: false, downloads: {}, modelInfoCache: {}, gpu: null });
      useModelsStore.getState().fetchModels();
    }
    if (prev.image && prev.image !== data.effective.image) {
      useImageStore.getState().fetchAll();
    }
  },

  fetch: async () => {
    try {
      get()._apply(await machinesApi.status());
    } catch (err) {
      set({ error: err.message });
    }
  },

  select: async (id) => {
    if (get().switching) return;
    set({ switching: id, error: null });
    try {
      get()._apply(await machinesApi.select(id));
    } catch (err) {
      set({ error: err.message });
    } finally {
      set({ switching: null });
    }
  },

  /** Poll every MACHINE_POLL_MS while the tab is visible. Returns a stop function. */
  startPolling: () => {
    let timer = null;
    const tick = () => {
      if (document.visibilityState === "visible") get().fetch();
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") get().fetch();
    };
    get().fetch();
    timer = setInterval(tick, MACHINE_POLL_MS);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  },
}));

setOnMachineChanged(() => useMachinesStore.getState().fetch());

/** One line describing a fallback, or null. */
export function fallbackNotice({ fallback, machines }) {
  const { chat, image } = fallback || {};
  if (!chat && !image) return null;
  const name = (id) => machines.find((m) => m.id === id)?.name || id;
  const from = name((chat || image).from);
  const to = name(machines.find((m) => m.isDefault)?.id);
  if (chat && image) return `${from} is unreachable, so chat and images are running on ${to}.`;
  if (chat) return `${from}'s model server is unreachable, so chat is running on ${to}.`;
  return `${from}'s sd-server is unreachable, so images are running on ${to}.`;
}
