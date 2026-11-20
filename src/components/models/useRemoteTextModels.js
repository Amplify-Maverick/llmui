import { useCallback, useEffect, useRef, useState } from "react";
import { llamaApi, parseProgress } from "../../services/llamaApi.js";

const ACTIVE = new Set(["starting", "downloading"]);
const POLL_MS = 5000;

/**
 * Text models on the machines chat does NOT go to (Models page columns):
 * { [machineId]: { models, downloads, error, loaded } }, plus install / delete
 * aimed at one of them. Each listed machine's list is fetched once and then
 * kept current from its router events; its list is re-read every POLL_MS only
 * while a download runs there (events are the main channel, as on the
 * selected machine).
 */
export function useRemoteTextModels(machineIds) {
  const key = machineIds.join(",");
  const [remote, setRemote] = useState({});
  const timers = useRef({});

  const patch = useCallback((id, fn) => {
    setRemote((r) => {
      const cur = r[id] || { models: [], downloads: {}, error: null, loaded: false };
      return { ...r, [id]: { ...cur, ...fn(cur) } };
    });
  }, []);

  const setDownload = useCallback(
    (id, model, p) => patch(id, (cur) => ({ downloads: { ...cur.downloads, [model]: { ...cur.downloads[model], ...p } } })),
    [patch]
  );

  const refresh = useCallback(
    async (id) => {
      try {
        const { models } = await llamaApi.list(id);
        patch(id, (cur) => {
          // Settle downloads the list shows as finished (a missed event).
          const downloads = { ...cur.downloads };
          for (const [mid, dl] of Object.entries(downloads)) {
            if (!ACTIVE.has(dl.state)) continue;
            const m = models.find((x) => x.id.toLowerCase() === mid.toLowerCase());
            if (m && m.status !== "downloading" && m.status !== "incomplete") downloads[mid] = { ...dl, state: "done" };
          }
          return { models, downloads, error: null, loaded: true };
        });
      } catch (err) {
        patch(id, () => ({ error: err.message, loaded: true }));
      }
    },
    [patch]
  );

  const scheduleRefresh = useCallback(
    (id) => {
      clearTimeout(timers.current[id]);
      timers.current[id] = setTimeout(() => refresh(id), 300);
    },
    [refresh]
  );

  // Fetch + subscribe per machine; forget machines that left the list.
  useEffect(() => {
    const ids = key ? key.split(",") : [];
    setRemote((r) => Object.fromEntries(Object.entries(r).filter(([id]) => ids.includes(id))));
    const stops = ids.map((id) => {
      refresh(id);
      return llamaApi.subscribe(
        (ev) => {
          setRemote((r) => {
            const cur = r[id];
            if (!cur || !ev.model) return r;
            const k = Object.keys(cur.downloads).find((x) => x.toLowerCase() === ev.model.toLowerCase()) || ev.model;
            let dl = null;
            if (ev.type === "download_progress") dl = { state: "downloading", ...(parseProgress(ev.data) || {}) };
            else if (ev.type === "download_finished") dl = { state: "done" };
            else if (ev.type === "download_failed")
              dl = { state: "failed", error: ev.data?.stopped ? "Download stopped" : ev.data?.error || ev.data?.message || "Download failed" };
            if (!dl) return r;
            return { ...r, [id]: { ...cur, downloads: { ...cur.downloads, [k]: { ...cur.downloads[k], ...dl } } } };
          });
          if (ev.type !== "download_progress") scheduleRefresh(id);
        },
        () => {},
        id
      );
    });
    const t = timers.current;
    return () => {
      stops.forEach((stop) => stop());
      ids.forEach((id) => clearTimeout(t[id]));
    };
  }, [key, refresh, scheduleRefresh]);

  // While a download runs on a machine, re-read its list (progress fallback).
  const activeKey = Object.entries(remote)
    .filter(([, r]) => Object.values(r.downloads).some((d) => ACTIVE.has(d.state)) || r.models.some((m) => m.status === "downloading"))
    .map(([id]) => id)
    .join(",");
  useEffect(() => {
    if (!activeKey) return undefined;
    const ids = activeKey.split(",");
    const iv = setInterval(() => {
      if (document.visibilityState === "visible") ids.forEach((id) => refresh(id));
    }, POLL_MS);
    return () => clearInterval(iv);
  }, [activeKey, refresh]);

  const install = useCallback(
    async (id, model, sidecars) => {
      setDownload(id, model, { state: "starting", done: 0, total: 0, error: null });
      try {
        await llamaApi.install(model, sidecars, id);
        scheduleRefresh(id);
      } catch (err) {
        setDownload(id, model, { state: "failed", error: err.message });
      }
    },
    [setDownload, scheduleRefresh]
  );

  /** Throws on failure (the caller shows it). */
  const remove = useCallback(
    async (id, model) => {
      await llamaApi.remove(model, id);
      patch(id, (cur) => {
        const { [model]: _, ...downloads } = cur.downloads;
        return { downloads };
      });
      await refresh(id);
    },
    [patch, refresh]
  );

  const clearDownload = useCallback(
    (id, model) =>
      patch(id, (cur) => {
        const { [model]: _, ...downloads } = cur.downloads;
        return { downloads };
      }),
    [patch]
  );

  return { remote, install, remove, clearDownload };
}
