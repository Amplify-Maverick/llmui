import { useEffect, useState } from "react";
import { fetchGpuStats } from "../services/gpuApi.js";

export const GPU_POLL_MS = 2000;
const GPU_RETRY_MS = 10000; // after an error (helper not installed, machine off)

const EMPTY = { gpus: [], error: null, timestamp: null, loading: true };

/**
 * Live GPU stats of one machine. Polls every GPU_POLL_MS while the component
 * is mounted and the browser tab is visible; stops while hidden. Slows to
 * GPU_RETRY_MS while the machine's helper can't be reached.
 */
export function useGpuStats(machineId) {
  const [state, setState] = useState(EMPTY);

  useEffect(() => {
    if (!machineId) return undefined;
    let stopped = false;
    let timer = null;
    let inflight = false;
    setState(EMPTY);

    const visible = () => document.visibilityState === "visible";
    const schedule = (ms) => {
      if (!stopped && !timer && !inflight && visible()) timer = setTimeout(tick, ms);
    };
    async function tick() {
      timer = null;
      if (stopped || !visible()) return;
      inflight = true;
      const data = await fetchGpuStats(machineId);
      inflight = false;
      if (stopped) return;
      if (data.ok) {
        setState({
          gpus: data.gpus || [],
          error: data.gpus?.length ? null : data.error || "No GPU reported",
          timestamp: data.timestamp,
          loading: false,
        });
      } else {
        setState({ gpus: [], error: data.error, timestamp: null, loading: false });
      }
      schedule(data.ok ? GPU_POLL_MS : GPU_RETRY_MS);
    }
    const onVisibility = () => {
      if (visible()) schedule(0);
      else {
        clearTimeout(timer);
        timer = null;
      }
    };

    tick();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [machineId]);

  return state;
}

/** Display helpers: null-safe. */
export const fmt = (v, unit = "", digits = 0) => (v == null ? "—" : `${Number(v).toFixed(digits)}${unit}`);
export const vramPct = (g) => (g.memoryUsed != null && g.memoryTotal ? (g.memoryUsed / g.memoryTotal) * 100 : null);
