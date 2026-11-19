import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useModelsStore, modelStatusLabel } from "../../stores/modelsStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { llamaApi, estimateFit, FIT_LABEL } from "../../services/llamaApi.js";
import { formatBytes } from "../../utils/formatters.js";
import Button from "../shared/Button.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import "./TextModelManager.css";

const GiB = 1024 ** 3;
const gib = (b) => `${(b / GiB).toFixed(1)} GiB`;

/** GPU bytes for a model from its memory report: effective if loaded, else measured min. */
function gpuUsage(memory) {
  const snap = memory?.effective || memory?.min;
  const d = snap?.devices?.find((x) => x.kind !== "host" && x.total);
  if (!d) return null;
  return { bytes: (d.model || 0) + (d.context || 0) + (d.compute || 0), nCtx: snap.n_ctx, live: !!memory.effective };
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

export default function TextModelManager() {
  const { models, gpu, downloads, refreshModels, setDownload, clearDownload, handleRouterEvent } = useModelsStore();
  const { defaultModel, updateSetting } = useSettingsStore();

  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState({}); // model id → "load" | "unload" | "delete"
  const [actionError, setActionError] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);

  const [query, setQuery] = useState("");
  const [repos, setRepos] = useState([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [openRepo, setOpenRepo] = useState(null);
  const [repoFiles, setRepoFiles] = useState({}); // repo → { quants, hasMmproj } | { error } | "loading"

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
  const search = useCallback(async (q) => {
    setSearching(true);
    setSearchError(null);
    try {
      const { repos } = await llamaApi.searchHF(q);
      setRepos(repos);
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  useEffect(() => {
    search("");
  }, [search]);

  const toggleRepo = async (repo) => {
    if (openRepo === repo) return setOpenRepo(null);
    setOpenRepo(repo);
    if (repoFiles[repo] && repoFiles[repo] !== "loading" && !repoFiles[repo].error) return;
    setRepoFiles((s) => ({ ...s, [repo]: "loading" }));
    try {
      const data = await llamaApi.repoFiles(repo);
      setRepoFiles((s) => ({ ...s, [repo]: data }));
    } catch (err) {
      setRepoFiles((s) => ({ ...s, [repo]: { error: err.message } }));
    }
  };

  // ── Actions ──
  const installedIds = useMemo(() => new Set(models.map((m) => m.name.toLowerCase())), [models]);

  const install = async (id) => {
    setActionError(null);
    setDownload(id, { state: "starting", done: 0, total: 0, error: null });
    try {
      await llamaApi.install(id);
      scheduleRefresh();
    } catch (err) {
      setDownload(id, { state: "failed", error: err.message });
    }
  };

  const runAction = async (id, action) => {
    setActionError(null);
    setBusy((b) => ({ ...b, [id]: action }));
    try {
      if (action === "delete") {
        await llamaApi.remove(id);
        clearDownload(id);
      } else {
        await llamaApi[action](id);
      }
      await refreshModels();
    } catch (err) {
      setActionError(`${action} ${id}: ${err.message}`);
    } finally {
      setBusy(({ [id]: _, ...rest }) => rest);
    }
  };

  // Installs started here that the router hasn't listed yet.
  const pending = Object.entries(downloads).filter(
    ([id, dl]) => !installedIds.has(id.toLowerCase()) && dl.state !== "done"
  );

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

      {/* ── Installed ── */}
      <section className="tmm-section">
        <h3 className="tmm-section-title">
          Installed <span className="image-models-count">{models.length}</span>
        </h3>
        {models.length === 0 && pending.length === 0 ? (
          <p className="tmm-empty">No models on the server yet. Install one from Hugging Face below.</p>
        ) : (
          <div className="tmm-list">
            {models.map((m) => {
              const usage = gpuUsage(m.memory);
              const dl = downloads[Object.keys(downloads).find((k) => k.toLowerCase() === m.name.toLowerCase())];
              const isDownloading = m.status === "downloading" || dl?.state === "downloading" || dl?.state === "starting";
              const isLoaded = m.status === "loaded" || m.status === "sleeping" || m.status === "loading";
              const b = busy[m.name];
              return (
                <div key={m.name} className="tmm-row">
                  <div className="tmm-row-main">
                    <div className="tmm-row-title">
                      <span className="tmm-model-id">{m.name}</span>
                      <span className={`model-status-pill status-${m.failed ? "failed" : m.status}`}>{modelStatusLabel(m)}</span>
                      {defaultModel === m.name && <span className="tmm-default">chat default</span>}
                    </div>
                    <div className="tmm-row-meta">
                      {m.size > 0 && <span>{formatBytes(m.size)} file</span>}
                      {usage && (
                        <span title={usage.live ? "Currently allocated on the GPU" : "Measured minimum on the GPU"}>
                          {gib(usage.bytes)} on GPU {usage.live ? "(in use)" : "(measured)"}
                        </span>
                      )}
                      {usage?.nCtx && <span>ctx {usage.nCtx.toLocaleString()}</span>}
                    </div>
                    {isDownloading && <ProgressBar dl={dl} />}
                    {dl?.state === "failed" && <div className="tmm-row-error">{dl.error}</div>}
                  </div>
                  <div className="tmm-row-actions">
                    {defaultModel !== m.name && !isDownloading && (
                      <Button variant="ghost" className="btn-sm" onClick={() => updateSetting("defaultModel", m.name)}>
                        Use in chat
                      </Button>
                    )}
                    {!isDownloading && (isLoaded ? (
                      <Button variant="secondary" className="btn-sm" disabled={!!b} onClick={() => runAction(m.name, "unload")}>
                        {b === "unload" ? "Unloading…" : "Unload"}
                      </Button>
                    ) : (
                      <Button variant="secondary" className="btn-sm" disabled={!!b} onClick={() => runAction(m.name, "load")}>
                        {b === "load" ? "Loading…" : "Load"}
                      </Button>
                    ))}
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
            placeholder="Search GGUF repos, e.g. qwen3 8b"
          />
          <Button type="submit" disabled={searching}>{searching ? "Searching…" : "Search"}</Button>
        </form>
        <p className="tmm-hint">
          Fit = file size + ~1 GiB for context and compute, against {gpu ? gib(gpu.budget) : "the GPU's"} usable VRAM.
          Larger models can still run with partial CPU offload, but slowly.
        </p>
        {searchError && <p className="tmm-row-error">{searchError}</p>}
        {!searching && repos.length === 0 && !searchError && <p className="tmm-empty">No GGUF repos found.</p>}
        <div className="tmm-list">
          {repos.map((r) => {
            const files = repoFiles[r.id];
            const open = openRepo === r.id;
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
                    {files === "loading" && <p className="tmm-empty">Loading files…</p>}
                    {files?.error && <p className="tmm-row-error">{files.error}</p>}
                    {files?.quants?.length === 0 && <p className="tmm-empty">No GGUF quant files found in this repo.</p>}
                    {files?.hasMmproj && (
                      <p className="tmm-hint">Includes a vision projector (mmproj), downloaded alongside the model.</p>
                    )}
                    {files?.quants?.map((q) => {
                      const id = `${r.id}:${q.quant}`;
                      const fit = estimateFit(q.size, gpu);
                      const dl = downloads[id];
                      const installed = installedIds.has(id.toLowerCase());
                      const active = dl && (dl.state === "starting" || dl.state === "downloading");
                      return (
                        <div key={q.quant} className="tmm-quant">
                          <span className="tmm-quant-tag">{q.quant}</span>
                          <span className="tmm-quant-size">
                            {formatBytes(q.size)}
                            {q.files.length > 1 && ` · ${q.files.length} parts`}
                          </span>
                          <span
                            className={`tmm-fit fit-${fit.level}`}
                            title={`Needs ≈${gib(fit.need)} of ${gib(fit.budget)} usable`}
                          >
                            {FIT_LABEL[fit.level]}
                          </span>
                          <span className="tmm-quant-action">
                            {installed && !active ? (
                              <span className="tmm-installed">Installed</span>
                            ) : active ? (
                              <ProgressBar dl={dl} />
                            ) : (
                              <Button variant={fit.level === "nofit" ? "ghost" : "primary"} className="btn-sm" onClick={() => install(id)}>
                                {dl?.state === "failed" ? "Retry" : "Install"}
                              </Button>
                            )}
                          </span>
                          {dl?.state === "failed" && <span className="tmm-row-error tmm-quant-error">{dl.error}</span>}
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
        message={`Remove ${deleteTarget} from the server's model cache? It will need to be downloaded again to use it.`}
        confirmText="Delete"
      />
    </div>
  );
}
