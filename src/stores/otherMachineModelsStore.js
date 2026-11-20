import { useEffect, useMemo } from "react";
import { create } from "zustand";
import { useMachinesStore } from "./machinesStore.js";
import { llamaApi } from "../services/llamaApi.js";
import { imageApi } from "../services/imageApi.js";

const FRESH_MS = 30000;
const SERVICE = { chat: "llama", image: "sd" };

/**
 * Models on the machines requests do NOT go to, for greyed entries in the Chat
 * and Image pickers. Read-only listings (?machine=<id>), fetched when a picker
 * mounts or the machine changes and reused for FRESH_MS; never polled.
 */
export const useOtherMachineModelsStore = create((set, get) => ({
  // kind ("chat" | "image") → machine id → { names: [...], at }
  byKind: { chat: {}, image: {} },
  _inflight: {},

  /** Refresh the lists for every other machine whose service is up. */
  fetchOthers: async (kind, machines, effectiveId) => {
    const now = Date.now();
    const targets = machines.filter(
      (m) => m.id !== effectiveId && m.status?.[SERVICE[kind]]?.ok === true
    );
    const known = new Set(targets.map((m) => m.id));
    // Drop machines that are now the effective one or went down.
    set((s) => ({
      byKind: {
        ...s.byKind,
        [kind]: Object.fromEntries(Object.entries(s.byKind[kind]).filter(([id]) => known.has(id))),
      },
    }));
    await Promise.all(
      targets.map(async (m) => {
        const key = `${kind}:${m.id}`;
        const hit = get().byKind[kind][m.id];
        if ((hit && now - hit.at < FRESH_MS) || get()._inflight[key]) return;
        set((s) => ({ _inflight: { ...s._inflight, [key]: true } }));
        try {
          const names =
            kind === "chat"
              ? (await llamaApi.list(m.id, { sizes: false })).models.map((x) => x.id)
              : (await imageApi.options(m.id)).checkpoints || [];
          set((s) => ({ byKind: { ...s.byKind, [kind]: { ...s.byKind[kind], [m.id]: { names, at: Date.now() } } } }));
        } catch {
          // unreachable: no greyed entries for it
        } finally {
          set((s) => {
            const { [key]: _, ...rest } = s._inflight;
            return { _inflight: rest };
          });
        }
      })
    );
  },
}));

/**
 * [{ machine, names }] for the other machines, minus names the current machine
 * also has (those are selectable already).
 */
export function othersFor(byKind, kind, machines, available) {
  const have = new Set(available);
  return Object.entries(byKind[kind] || {})
    .map(([id, { names }]) => ({
      machine: machines.find((m) => m.id === id),
      names: names.filter((n) => !have.has(n)),
    }))
    .filter((g) => g.machine && g.names.length);
}

/**
 * Greyed picker groups for `kind`: [{ machine, names }]. Fetches when the
 * component mounts, when requests move to another machine, and when a
 * machine's service comes up or goes down (all from the existing machines poll).
 */
export function useOtherMachineModels(kind, available) {
  const machines = useMachinesStore((s) => s.machines);
  const effectiveId = useMachinesStore((s) => s.effective[kind]);
  const byKind = useOtherMachineModelsStore((s) => s.byKind);
  const fetchOthers = useOtherMachineModelsStore((s) => s.fetchOthers);
  const upKey = machines.map((m) => `${m.id}:${m.status?.[SERVICE[kind]]?.ok === true}`).join(",");

  useEffect(() => {
    if (effectiveId) fetchOthers(kind, useMachinesStore.getState().machines, effectiveId);
  }, [kind, effectiveId, upKey, fetchOthers]);

  return useMemo(() => othersFor(byKind, kind, machines, available), [byKind, kind, machines, available]);
}
