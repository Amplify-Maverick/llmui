import { useCallback, useEffect, useRef, useState } from "react";
import { imageApi } from "../../services/imageApi.js";

export const ACTIVE_JOB = new Set(["queued", "downloading", "verifying"]);
const JOB_POLL_MS = 1000;

/** The id sd-server / the helper give a downloaded file: "category/safe_name". */
export const installedId = (f) => `${f.category}/${f.name.replace(/[^A-Za-z0-9._+-]/g, "_")}`;

/**
 * Image model files on the machines images do NOT go to (Models page
 * columns): { [machineId]: { data, job, error, loaded } }, plus install /
 * cancel / delete aimed at one of them. Each machine's files and download job
 * are read once; the job is re-read every JOB_POLL_MS only while a download
 * runs there (as on the selected machine), and the files again when it ends.
 */
export function useRemoteImageModels(machineIds) {
  const key = machineIds.join(",");
  const [remote, setRemote] = useState({});
  const timers = useRef({});
  const jobs = useRef({}); // id → last job seen

  const patch = useCallback((id, p) => {
    setRemote((r) => ({ ...r, [id]: { data: null, job: null, error: null, loaded: false, ...r[id], ...p } }));
  }, []);

  const loadFiles = useCallback(
    async (id) => {
      try {
        patch(id, { data: await imageApi.models(id), error: null, loaded: true });
      } catch (err) {
        patch(id, { error: err.message, loaded: true });
      }
    },
    [patch]
  );

  const pollJob = useCallback(
    async (id) => {
      clearTimeout(timers.current[id]);
      try {
        const { job } = await imageApi.currentInstall(id);
        const prev = jobs.current[id];
        jobs.current[id] = job;
        patch(id, { job });
        // Just finished: re-read the files so it shows as installed.
        if (prev && ACTIVE_JOB.has(prev.state) && job?.id === prev.id && !ACTIVE_JOB.has(job.state)) loadFiles(id);
        if (job && ACTIVE_JOB.has(job.state)) timers.current[id] = setTimeout(() => pollJob(id), JOB_POLL_MS);
      } catch {
        // helper unreachable: the column shows the files' helper error
      }
    },
    [loadFiles, patch]
  );

  useEffect(() => {
    const ids = key ? key.split(",") : [];
    setRemote((r) => Object.fromEntries(Object.entries(r).filter(([id]) => ids.includes(id))));
    ids.forEach((id) => {
      loadFiles(id);
      pollJob(id);
    });
    const t = timers.current;
    return () => ids.forEach((id) => clearTimeout(t[id]));
  }, [key, loadFiles, pollJob]);

  /** Throws on failure (the caller shows it). */
  const install = useCallback(
    async (id, body) => {
      const job = await imageApi.install(body, id);
      jobs.current[id] = job;
      patch(id, { job, dismissed: null });
      pollJob(id);
    },
    [patch, pollJob]
  );

  const cancel = useCallback(
    async (id, jobId) => {
      try {
        await imageApi.cancelInstall(jobId, id);
      } finally {
        pollJob(id);
      }
    },
    [pollJob]
  );

  /** Throws on failure (the caller shows it). */
  const remove = useCallback(
    async (id, f) => {
      await imageApi.deleteFile(f.category, f.name, id);
      await loadFiles(id);
    },
    [loadFiles]
  );

  const dismissJob = useCallback((id, jobId) => patch(id, { dismissed: jobId }), [patch]);

  return { remote, install, cancel, remove, dismissJob, reload: loadFiles };
}
