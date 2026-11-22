import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModelsStore, modelStatusLabel } from "../../stores/modelsStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { llamaApi, estimateFit, fitsOnGpu, FIT_LABEL } from "../../services/llamaApi.js";
import { formatBytes } from "../../utils/formatters.js";
import { hasMmproj, mmprojAllowance, mmprojAllowanceForFile } from "../../utils/mmproj.js";
import Button from "../shared/Button.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import { useMachinesStore } from "../../stores/machinesStore.js";
import { MachineColumns, MachineColumn, InstallOn } from "./MachineColumns.jsx";
import { useRemoteTextModels } from "./useRemoteTextModels.js";
import { looksLikeLink } from "../../utils/hfLink.js";
import "./TextModelManager.css";

const GiB = 1024 ** 3;
const gib = (b) => `${(b / GiB).toFixed(1)} GiB`;

/**
 * GPU bytes for a model from its memory report (effective if loaded, else
 * measured min), plus the mmproj allowance llama.cpp doesn't report.
 */
function gpuUsage(m) {
  const memory = m.memory;
  const snap = memory?.effective || memory?.min;
  const d = snap?.devices?.find((x) => x.kind !== "host" && x.total);
  if (!d) return null;
  const addOn = mmprojAllowance(m);
  return {
    bytes: (d.model || 0) + (d.context || 0) + (d.compute || 0) + addOn,
    addOn,
    nCtx: snap.n_ctx,
    live: !!memory.effective,
  };
}

function ProgressBar({ dl }) {
  const pct = dl?.total ? Math.min(100, (dl.done / dl.total) * 100) : null;
  return (
    <div className="tmm-progress">
      <div className={`tmm-progress-bar ${pct == null ? "indeterminate" : ""}`}>
        <div style={pct == null ? undefined : { width: `${pct}%` }} />
      </div>
      <span className="tmm-progress-text">
        {pct == null ? "starting…" : `${pct.toFixed(0)}% · ${formatBytes(dl.done)} / ${formatBytes(dl.total)}`}
      </span>
    </div>
  );
}

const CHAT_TAGS = new Set(["text-generation", "image-text-to-text"]);

/** What a pasted link resolved to, and anything that will surprise on install. */
function LinkNote({ link, repo, files }) {
  const quants = files?.quants;
  const notes = [];
  if (quants?.length === 0 && repo.pipelineTag === "text-to-image") {
    notes.push("This looks like an image model: paste the link on the Image tab instead.");
  } else if (repo.pipelineTag && !CHAT_TAGS.has(repo.pipelineTag)) {
    notes.push(`Hugging Face lists this as "${repo.pipelineTag}", not a chat model; llama.cpp may not run it.`);
  }
  if (quants?.length) {
    if (link.quant && !quants.some((q) => q.quant === link.quant)) {
      notes.push(`This repo has no ${link.quant} file. Pick a quant below.`);
    } else if (link.quant) {
      notes.push(`Linked quant ${link.quant} is highlighted below.`);
    } else {
      notes.push("Pick a quant below to download.");
    }
  }
  if (link.revision && link.revision !== "main") {
    notes.push(`The link names revision "${link.revision}", but llama.cpp always downloads the latest version on main.`);
  }
  if (repo.gated) notes.push("This repo is gated: the GPU machine's llama.cpp needs a Hugging Face token with access.");
  return notes.length ? <p className="tmm-hint tmm-link-note">{notes.join(" ")}</p> : null;
}

export default function TextModelManager() {
  const { models, gpu, downloads, refreshModels, setDownload, clearDownload, handleRouterEvent } = useModelsStore();
  const { defaultModel, updateSetting } = useSettingsStore();

  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState({}); // model id → "load" | "unload" | "delete"
  const [actionError, setActionError] = useState(null);
  const [rowErrors, setRowErrors] = useState({}); // model id → last load/unload error
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [removeImageTarget, setRemoveImageTarget] = useState(null);
  const [imageOpt, setImageOpt] = useState({}); // repo → include mmproj on install (overrides the default)

  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [openRepo, setOpenRepo] = useState(null);
  const [linked, setLinked] = useState(null); // { repo, quant, file, revision } when a pasted link was resolved
  const [repoFiles, setRepoFiles] = useState({}); // repo → { quants, hasMmproj } | { error } | "loading"
  const [fitOnly, setFitOnly] = useState(() => {
    try {
      return localStorage.getItem("tmm-fit-only") === "1";
    } catch {
      return false;
    }
  });
  const repoFilesRef = useRef(repoFiles);
  repoFilesRef.current = repoFiles;

  // ── Machines: the selected one (chat goes there) gets every control; the
  // others are listed beside it for install / delete only.
  const machines = useMachinesStore((s) => s.machines);
  const chatId = useMachinesStore((s) => s.effective.chat);
  const otherUpIds = machines.filter((m) => m.id !== chatId && m.status?.llama?.ok === true).map((m) => m.id);
  const { remote, install: installRemote, remove: removeRemote, clearDownload: clearRemoteDownload } =
    useRemoteTextModels(otherUpIds);
  const [remoteDelete, setRemoteDelete] = useState(null); // { machine, model }
  const [remoteBusy, setRemoteBusy] = useState({}); // `${machine}:${model}` → true

  // ── Live updates: router events, plus polling as a fallback ──
  const refreshTimer = useRef(null);
  const scheduleRefresh = useCallback(() => {
    clearTimeout(refreshTimer.current);
    refreshTimer.current = setTimeout(refreshModels, 300);
  }, [refreshModels]);

  useEffect(() => {
    refreshModels();
    const stop = llamaApi.subscribe((ev) => {
      if (handleRouterEvent(ev)) scheduleRefresh();
    }, setConnected);
    const poll = setInterval(() => {
      if (document.visibilityState === "visible") refreshModels();
    }, 5000);
    return () => {
      stop();
      clearInterval(poll);
      clearTimeout(refreshTimer.current);
    };
  }, [refreshModels, handleRouterEvent, scheduleRefresh]);

  // If an event was missed, settle downloads from the model list itself.
  useEffect(() => {
    for (const [id, dl] of Object.entries(downloads)) {
      if (dl.state !== "starting" && dl.state !== "downloading") continue;
      const m = models.find((x) => x.name.toLowerCase() === id.toLowerCase());
      if (m && m.status !== "downloading" && m.status !== "incomplete") setDownload(id, { state: "done" });
    }
  }, [models, downloads, setDownload]);

  // ── Hugging Face search ──
  const searchSeq = useRef(0);
  const search = useCallback(async (q) => {
    const n = ++searchSeq.current; // only the latest search may set results
    setSearching(true);
    setSearchError(null);
    try {
      const { repos, link } = await llamaApi.searchHF(q);
      if (n !== searchSeq.current) return;
      setRepos(repos);
      setLinked(link || null);
      // A pasted link opens its repo straight away, with the linked quant marked.
      if (link) {
        setOpenRepo(link.repo);
        loadFilesRef.current(link.repo);
      }
    } catch (err) {
      if (n !== searchSeq.current) return;
      setSearchError(err.message);
      setLinked(null);
    } finally {
      if (n === searchSeq.current) setSearching(false);
    }
  }, []);

  useEffect(() => {
    search("");
  }, [search]);

  const loadFiles = useCallback(async (repo) => {
    setRepoFiles((s) => ({ ...s, [repo]: "loading" }));
    try {
      const data = await llamaApi.repoFiles(repo);
      setRepoFiles((s) => ({ ...s, [repo]: data }));
    } catch (err) {
      setRepoFiles((s) => ({ ...s, [repo]: { error: err.message } }));
    }
  }, []);

  // Bring the linked quant into view once its repo's files are listed.
  const scrolledFor = useRef(null);
  useEffect(() => {
    if (!linked?.quant || scrolledFor.current === linked) return;
    const el = document.querySelector(".tmm-quant.is-linked");
    if (el) {
      scrolledFor.current = linked;
      el.scrollIntoView({ block: "nearest", behavior: "smooth" });
    }
  }, [linked, repoFiles]);

  const loadFilesRef = useRef(loadFiles);
  loadFilesRef.current = loadFiles;

  const toggleRepo = (repo) => {
    if (openRepo === repo) return setOpenRepo(null);
    setOpenRepo(repo);
    const f = repoFiles[repo];
    if (!f || f.error) loadFiles(repo);
  };

  const toggleFitOnly = (on) => {
    setFitOnly(on);
    try {
      localStorage.setItem("tmm-fit-only", on ? "1" : "0");
    } catch {
      // per-browser convenience only
    }
  };

  // Filtering by fit needs every result's quant sizes: fetch the missing file
  // lists a few at a time.
  useEffect(() => {
    if (!fitOnly) return;
    const pending = repos.map((r) => r.id).filter((id) => !repoFilesRef.current[id]);
    if (!pending.length) return;
    let cancelled = false;
    const worker = async () => {
      while (!cancelled && pending.length) await loadFiles(pending.shift());
    };
    for (let i = 0; i < 6; i++) worker();
    return () => {
      cancelled = true;
    };
  }, [fitOnly, repos, loadFiles]);

  const includeImageFor = (r, files) => !!files?.hasMmproj && (imageOpt[r.id] ?? r.pipelineTag === "image-text-to-text");
  const quantFits = (q, files, includeImage) =>
    fitsOnGpu(estimateFit(q.size, gpu, includeImage ? mmprojAllowanceForFile(files.mmprojSize) : 0));

  // The fit filter never hides what a pasted link pointed at.
  const filterFit = fitOnly && !linked;
  const checking = filterFit ? repos.filter((r) => !repoFiles[r.id] || repoFiles[r.id] === "loading").length : 0;
  const visibleRepos = filterFit
    ? repos.filter((r) => {
        const files = repoFiles[r.id];
        if (!files?.quants) return false;
        const inc = includeImageFor(r, files);
        return files.quants.some((q) => quantFits(q, files, inc));
      })
    : repos;

  // ── Actions ──
  const installedIds = useMemo(() => new Set(models.map((m) => m.name.toLowerCase())), [models]);

  const install = async (id, sidecars) => {
    setActionError(null);
    setDownload(id, { state: "starting", done: 0, total: 0, error: null });
    try {
      await llamaApi.install(id, sidecars);
      scheduleRefresh();
    } catch (err) {
      setDownload(id, { state: "failed", error: err.message });
    }
  };

  const runAction = async (id, action) => {
    setActionError(null);
    setRowErrors(({ [id]: _, ...rest }) => rest);
    setBusy((b) => ({ ...b, [id]: action }));
    try {
      if (action === "delete") {
        await llamaApi.remove(id);
        clearDownload(id);
      } else if (action === "removeImage") {
        await llamaApi.removeSidecar(id, "mmproj");
      } else {
        await llamaApi[action](id);
      }
      await refreshModels();
    } catch (err) {
      if (action === "delete") setActionError(`Delete ${id}: ${err.message}`);
      else if (action === "removeImage") setActionError(`Remove image support from ${id}: ${err.message}`);
      else setRowErrors((e) => ({ ...e, [id]: `${action === "load" ? "Load" : "Unload"} failed: ${err.message}` }));
    } finally {
      setBusy(({ [id]: _, ...rest }) => rest);
    }
  };

  const deleteOnOther = async ({ machine, model }) => {
    const k = `${machine.id}:${model}`;
    setActionError(null);
    setRemoteBusy((b) => ({ ...b, [k]: true }));
    try {
      await removeRemote(machine.id, model);
    } catch (err) {
      setActionError(`Delete ${model} on ${machine.name}: ${err.message}`);
    } finally {
      setRemoteBusy(({ [k]: _, ...rest }) => rest);
    }
  };

  // Installs started here that the router hasn't listed yet.
  const pending = Object.entries(downloads).filter(
    ([id, dl]) => !installedIds.has(id.toLowerCase()) && dl.state !== "done"
  );

  /** Installed list of a machine chat doesn't go to: status, size, Delete. */
  const renderOther = (machine) => {
    if (machine.status?.online === false) return <p className="tmm-empty">{machine.name} is offline.</p>;
    if (machine.status && machine.status.llama?.ok !== true) {
      return <p className="tmm-empty">{machine.name}'s model server is unreachable{machine.status.llama?.error ? `: ${machine.status.llama.error}` : ""}.</p>;
    }
    const r = remote[machine.id];
    if (!r?.loaded) return <p className="tmm-empty">Loading…</p>;
    if (r.error) return <p className="tmm-row-error">{r.error}</p>;
    const ids = new Set(r.models.map((m) => m.id.toLowerCase()));
    const pendingHere = Object.entries(r.downloads).filter(([id, dl]) => !ids.has(id.toLowerCase()) && dl.state !== "done");
    if (r.models.length === 0 && pendingHere.length === 0) {
      return <p className="tmm-empty">No models here yet. Install one from Hugging Face below.</p>;
    }
    return (
      <div className="tmm-list">
        {r.models.map((m) => {
          const dl = r.downloads[Object.keys(r.downloads).find((k) => k.toLowerCase() === m.id.toLowerCase())];
          const downloading = m.status === "downloading" || dl?.state === "downloading" || dl?.state === "starting";
          const b = remoteBusy[`${machine.id}:${m.id}`];
          return (
            <div key={m.id} className={`tmm-row ${m.failed ? "failed" : ""}`}>
              <div className="tmm-row-main">
                <div className="tmm-row-title">
                  <span className="tmm-model-id">{m.id}</span>
                  <span className={`model-status-pill status-${m.failed ? "failed" : m.status}`}>{modelStatusLabel(m)}</span>
                  {m.sidecars?.includes("mmproj") && <span className="tmm-default">images</span>}
                </div>
                <div className="tmm-row-meta">{m.diskSize > 0 && <span>{formatBytes(m.diskSize)} on disk</span>}</div>
                {downloading && <ProgressBar dl={dl} />}
                {dl?.state === "failed" && <div className="tmm-row-error">{dl.error}</div>}
              </div>
              <div className="tmm-row-actions">
                <Button
                  variant="danger"
                  className="btn-sm"
                  disabled={!!b || m.canRemove === false}
                  title={m.canRemove === false ? "This model can't be removed (not from the download cache)" : undefined}
                  onClick={() => setRemoteDelete({ machine, model: m.id })}
                >
                  {b ? "Deleting…" : "Delete"}
                </Button>
              </div>
            </div>
          );
        })}
        {pendingHere.map(([id, dl]) => (
          <div key={id} className="tmm-row">
            <div className="tmm-row-main">
              <div className="tmm-row-title">
                <span className="tmm-model-id">{id}</span>
                <span className={`model-status-pill status-${dl.state === "failed" ? "failed" : "downloading"}`}>
                  {dl.state === "failed" ? "failed" : "downloading…"}
                </span>
              </div>
              {dl.state === "failed" ? <div className="tmm-row-error">{dl.error}</div> : <ProgressBar dl={dl} />}
            </div>
            {dl.state === "failed" && (
              <div className="tmm-row-actions">
                <Button variant="ghost" className="btn-sm" onClick={() => clearRemoteDownload(machine.id, id)}>Dismiss</Button>
              </div>
            )}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="tmm">
      <div className="tmm-gpu">
        <span className={`tmm-dot ${connected ? "on" : ""}`} title={connected ? "Live updates connected" : "Live updates disconnected (polling)"} />
        {gpu ? (
          <span>
            GPU {gpu.name ? <strong>{gpu.name}</strong> : null} · {gib(gpu.total)} total · {gib(gpu.budget)} usable
            ({gib(gpu.margin)} kept free){gpu.source === "assumed" && " · size assumed until a model reports memory"}
          </span>
        ) : (
          <span>GPU info unavailable</span>
        )}
      </div>

      {actionError && (
        <div className="model-manager-error">
          <span>{actionError}</span>
          <button className="model-manager-error-close" onClick={() => setActionError(null)}>×</button>
        </div>
      )}

      {/* ── Installed, one column per machine ── */}
      <section className="tmm-section">
        <h3 className="tmm-section-title">Installed</h3>
        <MachineColumns>
          {machines.map((machine) =>
            machine.id === chatId ? (
              <MachineColumn key={machine.id} machine={machine} selected count={models.length}>
            {models.length === 0 && pending.length === 0 ? (
              <p className="tmm-empty">No models here yet. Install one from Hugging Face below.</p>
            ) : (
              <div className="tmm-list">
                {models.map((m) => {
                  const usage = gpuUsage(m);
                  const vision = hasMmproj(m);
                  const dl = downloads[Object.keys(downloads).find((k) => k.toLowerCase() === m.name.toLowerCase())];
                  const isDownloading = m.status === "downloading" || dl?.state === "downloading" || dl?.state === "starting";
                  const isLoaded = !m.failed && (m.status === "loaded" || m.status === "sleeping" || m.status === "loading");
                  const b = busy[m.name];
                  const rowError = rowErrors[m.name];
                  return (
                    <div key={m.name} className={`tmm-row ${m.failed || rowError ? "failed" : ""}`}>
                      <div className="tmm-row-main">
                        <div className="tmm-row-title">
                          <span className="tmm-model-id">{m.name}</span>
                          <span className={`model-status-pill status-${m.failed ? "failed" : m.status}`}>{modelStatusLabel(m)}</span>
                          {defaultModel === m.name && <span className="tmm-default">chat default</span>}
                          {vision && <span className="tmm-default" title="Has a vision projector (mmproj) sidecar">images</span>}
                        </div>
                        <div className="tmm-row-meta">
                          {m.size > 0 && <span>{formatBytes(m.size)} file</span>}
                          {usage && (
                            <span title={usage.live ? "Currently allocated on the GPU" : "Measured minimum on the GPU"}>
                              {gib(usage.bytes)} on GPU {usage.live ? "(in use)" : "(measured)"}
                            </span>
                          )}
                          {usage?.addOn > 0 && (
                            <span title="llama.cpp's memory report doesn't count the vision projector (mmproj); this allowance is included in the GPU figure">
                              incl. + {gib(usage.addOn)} image add-on
                            </span>
                          )}
                          {usage?.nCtx && <span>ctx {usage.nCtx.toLocaleString()}</span>}
                        </div>
                        {isDownloading && <ProgressBar dl={dl} />}
                        {dl?.state === "failed" && <div className="tmm-row-error">{dl.error}</div>}
                        {m.failed && (
                          <div className="tmm-failure">
                            <strong>
                              llama.cpp failed to load this model
                              {m.exitCode != null && ` (exit code ${m.exitCode})`}.
                            </strong>{" "}
                            It's usually an unsupported architecture or a broken download. The exact error is in the
                            llama-server log on the GPU machine. Delete it, or try loading it again.
                          </div>
                        )}
                        {rowError && <div className="tmm-failure">{rowError}</div>}
                      </div>
                      <div className="tmm-row-actions">
                        {defaultModel !== m.name && !isDownloading && !m.failed && (
                          <Button variant="ghost" className="btn-sm" onClick={() => updateSetting("defaultModel", m.name)}>
                            Use in chat
                          </Button>
                        )}
                        {!isDownloading && (isLoaded && !m.failed ? (
                          <Button variant="secondary" className="btn-sm" disabled={!!b} onClick={() => runAction(m.name, "unload")}>
                            {b === "unload" ? "Unloading…" : "Unload"}
                          </Button>
                        ) : (
                          <Button variant="secondary" className="btn-sm" disabled={!!b} onClick={() => runAction(m.name, "load")}>
                            {b === "load" ? "Loading…" : m.failed || rowError ? "Retry load" : "Load"}
                          </Button>
                        ))}
                        {vision && !isDownloading && (
                          <Button
                            variant="ghost"
                            className="btn-sm"
                            disabled={!!b || isLoaded}
                            title={isLoaded ? "Unload the model first" : "Delete the vision projector (mmproj) and keep the model"}
                            onClick={() => setRemoveImageTarget(m.name)}
                          >
                            {b === "removeImage" ? "Removing…" : "Remove image support"}
                          </Button>
                        )}
                        <Button
                          variant="danger"
                          className="btn-sm"
                          disabled={!!b || m.canRemove === false}
                          title={m.canRemove === false ? "This model can't be removed (not from the download cache)" : undefined}
                          onClick={() => setDeleteTarget(m.name)}
                        >
                          {b === "delete" ? "Deleting…" : "Delete"}
                        </Button>
                      </div>
                    </div>
                  );
                })}
                {pending.map(([id, dl]) => (
                  <div key={id} className="tmm-row">
                    <div className="tmm-row-main">
                      <div className="tmm-row-title">
                        <span className="tmm-model-id">{id}</span>
                        <span className={`model-status-pill status-${dl.state === "failed" ? "failed" : "downloading"}`}>
                          {dl.state === "failed" ? "failed" : "downloading…"}
                        </span>
                      </div>
                      {dl.state === "failed" ? <div className="tmm-row-error">{dl.error}</div> : <ProgressBar dl={dl} />}
                    </div>
                    {dl.state === "failed" && (
                      <div className="tmm-row-actions">
                        <Button variant="ghost" className="btn-sm" onClick={() => clearDownload(id)}>Dismiss</Button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
              </MachineColumn>
            ) : (
              <MachineColumn key={machine.id} machine={machine} count={remote[machine.id]?.models.length}>
                {renderOther(machine)}
              </MachineColumn>
            )
          )}
        </MachineColumns>
      </section>

      {/* ── Hugging Face ── */}
      <section className="tmm-section">
        <h3 className="tmm-section-title">Install from Hugging Face</h3>
        <form
          className="tmm-search"
          onSubmit={(e) => {
            e.preventDefault();
            setOpenRepo(null);
            search(query);
          }}
        >
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search GGUF repos (e.g. qwen3 8b) or paste a Hugging Face link"
          />
          <Button type="submit" disabled={searching}>
            {searching ? (looksLikeLink(query) ? "Opening…" : "Searching…") : looksLikeLink(query) ? "Open link" : "Search"}
          </Button>
        </form>
        <p className="tmm-hint">
          Fit = file size + ~1 GiB for context and compute (+ 1.5× the projector size with image support), against {gpu ? gib(gpu.budget) : "the GPU's"} usable VRAM.
          Larger models can still run with partial CPU offload, but slowly.
        </p>
        <label className="tmm-image-opt">
          <input type="checkbox" checked={fitOnly} onChange={(e) => toggleFitOnly(e.target.checked)} />
          Only show models that fit on my GPU
          {filterFit && repos.length > 0 && (
            <span className="tmm-hint">
              {checking > 0
                ? `(checking file sizes… ${repos.length - checking}/${repos.length})`
                : `(${visibleRepos.length} of ${repos.length} repos have a quant that fits)`}
            </span>
          )}
        </label>
        {searchError && <p className="tmm-row-error">{searchError}</p>}
        {!searching && repos.length === 0 && !searchError && <p className="tmm-empty">No GGUF repos found.</p>}
        {!searching && filterFit && repos.length > 0 && checking === 0 && visibleRepos.length === 0 && (
          <p className="tmm-empty">None of these repos has a quant that fits in {gpu ? gib(gpu.budget) : "the GPU's VRAM"}.</p>
        )}
        <div className="tmm-list">
          {visibleRepos.map((r) => {
            const files = repoFiles[r.id];
            const open = openRepo === r.id;
            const includeImage = includeImageFor(r, files);
            const imageExtra = includeImage ? mmprojAllowanceForFile(files.mmprojSize) : 0;
            return (
              <div key={r.id} className={`tmm-repo ${open ? "open" : ""}`}>
                <button className="tmm-repo-head" onClick={() => toggleRepo(r.id)} aria-expanded={open}>
                  <span className="tmm-chevron">{open ? "▾" : "▸"}</span>
                  <span className="tmm-model-id">{r.id}</span>
                  <span className="tmm-repo-stats">
                    {r.pipelineTag && <span>{r.pipelineTag}</span>}
                    <span>↓ {r.downloads.toLocaleString()}</span>
                    <span>♥ {r.likes.toLocaleString()}</span>
                  </span>
                </button>
                {open && (
                  <div className="tmm-quants">
                    {linked?.repo === r.id && <LinkNote link={linked} repo={r} files={files} />}
                    {files === "loading" && <p className="tmm-empty">Loading files…</p>}
                    {files?.error && <p className="tmm-row-error">{files.error}</p>}
                    {files?.quants?.length === 0 && <p className="tmm-empty">No GGUF quant files found in this repo.</p>}
                    {files?.hasMmproj && (
                      <label className="tmm-image-opt">
                        <input
                          type="checkbox"
                          checked={includeImage}
                          onChange={(e) => setImageOpt((o) => ({ ...o, [r.id]: e.target.checked }))}
                        />
                        Include image support
                        <span className="tmm-hint">
                          (vision projector{files.mmprojSize ? `, ${formatBytes(files.mmprojSize)}` : ""}; adds ≈{gib(mmprojAllowanceForFile(files.mmprojSize))} on the GPU)
                        </span>
                      </label>
                    )}
                    {files?.quants?.filter((q) => !filterFit || quantFits(q, files, includeImage)).map((q) => {
                      const id = `${r.id}:${q.quant}`;
                      const isLinked = linked?.repo === r.id && linked.quant === q.quant;
                      const fit = estimateFit(q.size, gpu, imageExtra);
                      const sidecars = files.hasMmproj && includeImage ? ["mmproj"] : [];
                      return (
                        <div key={q.quant} className={`tmm-quant ${isLinked ? "is-linked" : ""}`}>
                          <span className="tmm-quant-tag">{q.quant}</span>
                          <span className="tmm-quant-size">
                            {formatBytes(q.size)}
                            {q.files.length > 1 && ` · ${q.files.length} parts`}
                          </span>
                          <span
                            className={`tmm-fit fit-${fit.level}`}
                            title={`Needs ≈${gib(fit.need)} of ${gib(fit.budget)} usable VRAM${fit.extra ? ` (incl. ${gib(fit.extra)} image add-on)` : ""}${fit.level === "offload" ? `; the rest runs from system RAM (${gib(gpu.ramFree)} free), slowly` : ""}`}
                          >
                            {FIT_LABEL[fit.level]}
                          </span>
                          <span className="tmm-quant-action mcol-installs">
                            {machines.map((machine) => {
                              const here = machine.id === chatId;
                              const r = remote[machine.id];
                              const dl = here
                                ? downloads[id]
                                : r?.downloads[Object.keys(r.downloads).find((k) => k.toLowerCase() === id.toLowerCase())];
                              const installed = here
                                ? installedIds.has(id.toLowerCase())
                                : !!r?.models.some((m) => m.id.toLowerCase() === id.toLowerCase());
                              const active = !!dl && (dl.state === "starting" || dl.state === "downloading");
                              const up = here || (machine.status?.llama?.ok === true && r?.loaded && !r.error);
                              return (
                                <InstallOn
                                  key={machine.id}
                                  machine={machine}
                                  many={machines.length > 1}
                                  installed={installed}
                                  active={active}
                                  progress={!here || machines.length === 1 ? <ProgressBar dl={dl} /> : null}
                                  failed={dl?.state === "failed"}
                                  disabled={!up}
                                  title={up ? undefined : `${machine.name}'s model server is unreachable`}
                                  variant={fitsOnGpu(fit) ? "primary" : "ghost"}
                                  onInstall={() => (here ? install(id, sidecars) : installRemote(machine.id, id, sidecars))}
                                />
                              );
                            })}
                          </span>
                          {machines.map((machine) => {
                            const r = remote[machine.id];
                            const dl = machine.id === chatId ? downloads[id] : r?.downloads[id];
                            return dl?.state === "failed" ? (
                              <span key={machine.id} className="tmm-row-error tmm-quant-error">
                                {machines.length > 1 && `${machine.name}: `}{dl.error}
                              </span>
                            ) : null;
                          })}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      <ConfirmModal
        isOpen={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={() => {
          runAction(deleteTarget, "delete");
          setDeleteTarget(null);
        }}
        title="Delete model"
        message={`Remove ${deleteTarget} from ${machines.find((m) => m.id === chatId)?.name || "the server"}'s model cache? It will need to be downloaded again to use it.`}
        confirmText="Delete"
      />

      <ConfirmModal
        isOpen={!!remoteDelete}
        onClose={() => setRemoteDelete(null)}
        onConfirm={() => {
          deleteOnOther(remoteDelete);
          setRemoteDelete(null);
        }}
        title={`Delete model on ${remoteDelete?.machine.name}`}
        message={`Remove ${remoteDelete?.model} from ${remoteDelete?.machine.name}'s model cache? It will need to be downloaded again to use it there.`}
        confirmText="Delete"
      />

      <ConfirmModal
        isOpen={!!removeImageTarget}
        onClose={() => setRemoveImageTarget(null)}
        onConfirm={() => {
          runAction(removeImageTarget, "removeImage");
          setRemoveImageTarget(null);
        }}
        title="Remove image support"
        message={`Delete the vision projector (mmproj) of ${removeImageTarget}? The model stays installed but can no longer read images.`}
        confirmText="Remove"
      />
    </div>
  );
}
