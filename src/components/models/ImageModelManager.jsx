import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { imageApi } from "../../services/imageApi.js";
import { useImageStore } from "../../stores/imageStore.js";
import { formatBytes } from "../../utils/formatters.js";
import Button from "../shared/Button.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import "./TextModelManager.css";
import "./ImageModelManager.css";

const GiB = 1024 ** 3;
const gib = (b) => `${(b / GiB).toFixed(1)} GiB`;
const FIT_LABEL = { fits: "Fits on GPU", tight: "Tight", nofit: "Too big" };
const ACTIVE = new Set(["queued", "downloading", "verifying"]);

function Fit({ level, size, gpuBytes }) {
  if (!level || level === "unknown") return <span />;
  return (
    <span
      className={`tmm-fit fit-${level}`}
      title={`${formatBytes(size)} file vs ${gib(gpuBytes)} of VRAM${level === "tight" ? " (little room left for compute)" : ""}`}
    >
      {FIT_LABEL[level]}
    </span>
  );
}

function JobProgress({ job, onCancel, onDismiss }) {
  const pct = job.bytes_total ? Math.min(100, (job.bytes_done / job.bytes_total) * 100) : null;
  const active = ACTIVE.has(job.state);
  return (
    <div className={`tmm-row ${job.state === "failed" ? "failed" : ""}`}>
      <div className="tmm-row-main">
        <div className="tmm-row-title">
          <span className="tmm-model-id">{job.file_id}</span>
          <span className={`model-status-pill status-${job.state === "failed" ? "failed" : "downloading"}`}>
            {job.state === "verifying" ? "verifying…" : job.state === "queued" ? "starting…" : job.state}
          </span>
        </div>
        <div className="tmm-row-meta">
          <span>
            from {job.repo}/{job.path}
          </span>
          {job.resumed_from > 0 && <span>resumed at {formatBytes(job.resumed_from)}</span>}
        </div>
        {active && (
          <div className="tmm-progress">
            <div className={`tmm-progress-bar ${pct == null ? "indeterminate" : ""}`}>
              <div style={pct == null ? undefined : { width: `${pct}%` }} />
            </div>
            <span className="tmm-progress-text">
              {pct == null ? "starting…" : `${pct.toFixed(0)}% · ${formatBytes(job.bytes_done)} / ${formatBytes(job.bytes_total)}`}
            </span>
          </div>
        )}
        {job.error && <div className="tmm-failure">{job.error}</div>}
      </div>
      <div className="tmm-row-actions">
        {active ? (
          <Button variant="secondary" className="btn-sm" onClick={onCancel}>
            Cancel
          </Button>
        ) : (
          <Button variant="ghost" className="btn-sm" onClick={onDismiss}>
            Dismiss
          </Button>
        )}
      </div>
    </div>
  );
}

/** Recipe + component picker for one installed model file. */
function SetupPanel({ file, recipes, files, onSave, onClose }) {
  const choices = useMemo(
    () => recipes.filter((r) => r.primaryCategories.includes(file.category)),
    [recipes, file.category]
  );
  const [recipeId, setRecipeId] = useState(file.setup?.recipe || choices[0]?.id || "");
  const recipe = choices.find((r) => r.id === recipeId);
  const [components, setComponents] = useState(() => {
    const c = { ...(file.setup?.components || {}) };
    delete c[recipes.find((r) => r.id === file.setup?.recipe)?.primarySlot];
    return c;
  });
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  const filesIn = (cats) => files.filter((f) => f.inCatalog && cats.includes(f.category));

  // Pre-fill a needed slot when exactly one installed file can go there.
  useEffect(() => {
    if (!recipe) return;
    setComponents((prev) => {
      const next = {};
      for (const need of recipe.needs) {
        for (const slotId of need.slots) if (prev[slotId]) next[slotId] = prev[slotId];
        if (need.slots.some((s) => next[s])) continue;
        const only = filesIn(need.categories);
        if (only.length === 1) next[need.slots[0]] = only[0].id;
      }
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [recipeId]);

  const save = async (makeDefault) => {
    setSaving(makeDefault ? "default" : "save");
    setError(null);
    try {
      await onSave({ model: file.id, recipe: recipeId, components, makeDefault });
      onClose();
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(null);
    }
  };

  const slotLabel = (slotId) => recipe?.slots.find((s) => s.id === slotId)?.label || slotId;
  const slotCats = (slotId) => recipe?.slots.find((s) => s.id === slotId)?.categories || [];

  return (
    <div className="imm-setup">
      {choices.length === 0 ? (
        <p className="tmm-row-error">sd-server has no recipe that loads a file from {file.category}/.</p>
      ) : (
        <>
          <label className="imm-field">
            <span>Recipe</span>
            <select className="imm-select" value={recipeId} onChange={(e) => setRecipeId(e.target.value)}>
              {choices.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.name} ({r.id})
                </option>
              ))}
            </select>
          </label>
          {recipe?.description && <p className="tmm-hint">{recipe.description}</p>}
          {recipe?.needs.map((need) =>
            need.slots.map((slotId, i) => {
              const options = filesIn(slotCats(slotId));
              return (
                <label key={slotId} className="imm-field">
                  <span>
                    {slotLabel(slotId)}
                    {need.slots.length > 1 ? (i === 0 ? " (or the next)" : "") : " *"}
                  </span>
                  <select
                    className="imm-select"
                    value={components[slotId] || ""}
                    onChange={(e) => setComponents((c) => ({ ...c, [slotId]: e.target.value }))}
                  >
                    <option value="">{options.length ? "— choose —" : `nothing installed in ${slotCats(slotId).join("/")}/`}</option>
                    {options.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.id}
                      </option>
                    ))}
                  </select>
                </label>
              );
            })
          )}
          {recipe && recipe.needs.length === 0 && <p className="tmm-hint">Loads from this one file.</p>}
          {error && <p className="tmm-row-error">{error}</p>}
          <div className="imm-setup-actions">
            <Button variant="ghost" className="btn-sm" onClick={onClose}>
              Close
            </Button>
            <Button variant="secondary" className="btn-sm" disabled={!!saving} onClick={() => save(false)}>
              {saving === "save" ? "Saving…" : "Save"}
            </Button>
            <Button className="btn-sm" disabled={!!saving} onClick={() => save(true)}>
              {saving === "default" ? "Saving…" : "Save & make default"}
            </Button>
          </div>
          <p className="tmm-hint">
            “Make default” writes this model, recipe and the recipe's size/steps/CFG/sampler to ~/.llmui/sd_config.json.
          </p>
        </>
      )}
    </div>
  );
}

export default function ImageModelManager() {
  const fetchImageOptions = useImageStore((s) => s.fetchAll);

  const [data, setData] = useState(null); // GET /api/images/models
  const [loadError, setLoadError] = useState(null);
  const [job, setJob] = useState(null);
  const [dismissedJob, setDismissedJob] = useState(null);
  const [actionError, setActionError] = useState(null);
  const [setupFor, setSetupFor] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [busy, setBusy] = useState({}); // file id → "delete" | "default"

  const [query, setQuery] = useState("");
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [openRepo, setOpenRepo] = useState(null);
  const [lastQuery, setLastQuery] = useState("");

  const load = useCallback(async () => {
    try {
      setData(await imageApi.models());
      setLoadError(null);
    } catch (err) {
      setLoadError(err.message);
    }
  }, []);

  const search = useCallback(async (q) => {
    setSearching(true);
    setSearchError(null);
    setLastQuery(q);
    try {
      setResults(await imageApi.searchHF(q));
    } catch (err) {
      setSearchError(err.message);
    } finally {
      setSearching(false);
    }
  }, []);

  // ── Download job polling ──
  const pollTimer = useRef(null);
  const pollJob = useCallback(async () => {
    clearTimeout(pollTimer.current);
    try {
      const { job: j } = await imageApi.currentInstall();
      setJob((prev) => {
        // Just finished: refresh the installed list and the Images view's model list.
        if (prev && ACTIVE.has(prev.state) && j && j.id === prev.id && !ACTIVE.has(j.state)) {
          load();
          fetchImageOptions();
          setResults((r) => r && { ...r, stale: true });
        }
        return j;
      });
      if (j && ACTIVE.has(j.state)) pollTimer.current = setTimeout(pollJob, 1000);
    } catch {
      // helper unreachable; the status line says so
    }
  }, [load, fetchImageOptions]);

  useEffect(() => {
    load();
    search("");
    pollJob();
    return () => clearTimeout(pollTimer.current);
  }, [load, search, pollJob]);

  // Mark search results installed once a download completes.
  useEffect(() => {
    if (results?.stale) search(lastQuery);
  }, [results?.stale, search, lastQuery]);

  const helper = data?.helper;
  const helperReady = !!helper?.ok;
  const jobActive = !!job && ACTIVE.has(job.state);
  const gpuBytes = data?.gpuBytes || results?.gpuBytes || 8 * GiB;
  const usableDisk = helper?.disk ? Math.max(0, helper.disk.free - helper.disk.reserve) : null;

  const install = async (repo, f) => {
    setActionError(null);
    try {
      const j = await imageApi.install({
        repo: repo.id,
        path: f.path,
        revision: repo.sha || "main",
        category: f.category,
        recipe: f.kind === "model" ? f.recipe : undefined,
      });
      setJob(j);
      setDismissedJob(null);
      pollJob();
    } catch (err) {
      setActionError(`Install ${f.name}: ${err.message}`);
    }
  };

  const cancel = async () => {
    try {
      await imageApi.cancelInstall(job.id);
    } catch (err) {
      setActionError(`Cancel: ${err.message}`);
    }
    pollJob();
  };

  const saveSetup = async (body) => {
    await imageApi.saveSetup(body);
    await load();
    fetchImageOptions();
  };

  const makeDefault = async (f) => {
    setBusy((b) => ({ ...b, [f.id]: "default" }));
    setActionError(null);
    try {
      const components = { ...f.setup.components };
      for (const [slot, id] of Object.entries(components)) if (id === f.id) delete components[slot];
      await saveSetup({ model: f.id, recipe: f.setup.recipe, components, makeDefault: true });
    } catch (err) {
      setActionError(`Make default: ${err.message}`);
      setSetupFor(f.id); // usually a missing component; let them fix it
    } finally {
      setBusy(({ [f.id]: _, ...rest }) => rest);
    }
  };

  const remove = async (f) => {
    setBusy((b) => ({ ...b, [f.id]: "delete" }));
    setActionError(null);
    try {
      await imageApi.deleteFile(f.category, f.name);
      await load();
      fetchImageOptions();
      if (results) search(lastQuery);
    } catch (err) {
      setActionError(`Delete ${f.id}: ${err.message}`);
    } finally {
      setBusy(({ [f.id]: _, ...rest }) => rest);
    }
  };

  const files = data?.files || [];
  const models = files.filter((f) => f.kind === "model");
  const components = files.filter((f) => f.kind === "component");
  const recipeName = (id) => data?.recipes.find((r) => r.id === id)?.name || id;
  const showJob = job && job.id !== dismissedJob && (jobActive || job.state === "failed" || job.state === "cancelled");

  const renderFile = (f) => {
    const b = busy[f.id];
    const protectedFile = f.isDefault || f.usedByDefault;
    return (
      <div key={f.id} className="imm-file">
        <div className="tmm-row">
          <div className="tmm-row-main">
            <div className="tmm-row-title">
              <span className="tmm-model-id">{f.id}</span>
              {f.isDefault && <span className="tmm-default">default</span>}
              {f.usedByDefault && <span className="tmm-default">used by default</span>}
              {!f.inCatalog && (
                <span className="imm-tag" title="sd-server's catalog doesn't list this file">
                  not in sd-server catalog
                </span>
              )}
            </div>
            <div className="tmm-row-meta">
              {f.size != null && <span>{formatBytes(f.size)}</span>}
              {f.kind === "model" &&
                (f.setup ? (
                  <span>
                    recipe <strong className="imm-strong">{recipeName(f.setup.recipe)}</strong>
                  </span>
                ) : (
                  <span className="imm-warn">no recipe set — won't show in Images until set up</span>
                ))}
              {f.kind === "model" && <Fit level={f.fit} size={f.size} gpuBytes={gpuBytes} />}
            </div>
          </div>
          <div className="tmm-row-actions">
            {f.kind === "model" && f.inCatalog && (
              <Button variant="ghost" className="btn-sm" onClick={() => setSetupFor(setupFor === f.id ? null : f.id)}>
                {f.setup ? "Recipe…" : "Set up…"}
              </Button>
            )}
            {f.kind === "model" && f.setup && !f.isDefault && f.inCatalog && (
              <Button variant="secondary" className="btn-sm" disabled={!!b} onClick={() => makeDefault(f)}>
                {b === "default" ? "Saving…" : "Make default"}
              </Button>
            )}
            <Button
              variant="danger"
              className="btn-sm"
              disabled={!!b || !f.deletable || protectedFile || !helperReady}
              title={
                protectedFile
                  ? "Used by the default model; change the default first"
                  : !helperReady
                    ? "The download helper isn't reachable"
                    : !f.deletable
                      ? "Only top-level files in the helper's model dir can be deleted"
                      : undefined
              }
              onClick={() => setDeleteTarget(f)}
            >
              {b === "delete" ? "Deleting…" : "Delete"}
            </Button>
          </div>
        </div>
        {setupFor === f.id && data && (
          <SetupPanel file={f} recipes={data.recipes} files={files} onSave={saveSetup} onClose={() => setSetupFor(null)} />
        )}
      </div>
    );
  };

  return (
    <div className="tmm">
      <div className="tmm-gpu imm-status">
        <span className={`tmm-dot ${data && !data.sdError ? "on" : ""}`} title={data?.sdError || "sd-server reachable"} />
        <span>
          GPU {gib(gpuBytes)} VRAM
          {usableDisk != null && (
            <>
              {" "}· disk {gib(helper.disk.free)} free, <strong>{gib(usableDisk)}</strong> usable ({gib(helper.disk.reserve)} kept free)
            </>
          )}
        </span>
        <span className={`tmm-dot ${helperReady ? "on" : ""}`} />
        <span>
          {helperReady ? "Download helper connected" : "Download helper unavailable"}
          {helperReady && !helper.hfToken && " · no HF token (gated repos won't download)"}
        </span>
      </div>

      {loadError && <div className="model-manager-error"><span>{loadError}</span></div>}
      {data?.sdError && <div className="model-manager-error"><span>sd-server: {data.sdError}</span></div>}
      {helper && !helperReady && (
        <div className="tmm-failure">
          <strong>Can't install or delete:</strong> {helper.error}. See deploy/sd-fetch/README.md.
        </div>
      )}
      {actionError && (
        <div className="model-manager-error">
          <span>{actionError}</span>
          <button className="model-manager-error-close" onClick={() => setActionError(null)}>×</button>
        </div>
      )}

      {showJob && <JobProgress job={job} onCancel={cancel} onDismiss={() => setDismissedJob(job.id)} />}

      {/* ── Installed ── */}
      <section className="tmm-section">
        <h3 className="tmm-section-title">
          Models <span className="image-models-count">{models.length}</span>
        </h3>
        {!data ? (
          <p className="tmm-empty">Loading…</p>
        ) : models.length === 0 ? (
          <p className="tmm-empty">No checkpoints or diffusion models yet. Install one from Hugging Face below.</p>
        ) : (
          <div className="tmm-list">{models.map(renderFile)}</div>
        )}
      </section>

      {components.length > 0 && (
        <section className="tmm-section">
          <h3 className="tmm-section-title">
            Components <span className="image-models-count">{components.length}</span>
          </h3>
          <p className="tmm-hint">Text encoders, VAEs and other files that recipes like FLUX need next to the model.</p>
          <div className="tmm-list">{components.map(renderFile)}</div>
        </section>
      )}

      {/* ── Hugging Face ── */}
      <section className="tmm-section">
        <h3 className="tmm-section-title">Install from Hugging Face</h3>
        <form
          className="tmm-search"
          onSubmit={(e) => {
            e.preventDefault();
            setOpenRepo(null);
            search(query.trim());
          }}
        >
          <input
            className="input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search text-to-image models, e.g. dreamshaper, sdxl, flux gguf"
          />
          <Button type="submit" disabled={searching}>
            {searching ? "Searching…" : "Search"}
          </Button>
        </form>
        <p className="tmm-hint">
          Only repos with a single-file .safetensors or .gguf checkpoint are shown (diffusers folders can't be loaded).
          Fit compares the file size with {gib(gpuBytes)} of VRAM; recipes that need text encoders load those too.
        </p>
        {searchError && <p className="tmm-row-error">{searchError}</p>}
        {searching && !results && <p className="tmm-empty">Searching… (reads each repo's file list)</p>}
        {results && !searching && results.repos.length === 0 && !searchError && (
          <p className="tmm-empty">No repos with single-file checkpoints found.</p>
        )}
        <div className="tmm-list">
          {results?.repos.map((r) => {
            const open = openRepo === r.id;
            const modelFiles = r.files.filter((f) => f.kind === "model");
            const families = [...new Set(modelFiles.map((f) => f.recipeName).filter(Boolean))];
            return (
              <div key={r.id} className={`tmm-repo ${open ? "open" : ""}`}>
                <button className="tmm-repo-head" onClick={() => setOpenRepo(open ? null : r.id)} aria-expanded={open}>
                  <span className="tmm-chevron">{open ? "▾" : "▸"}</span>
                  <span className="tmm-model-id">{r.id}</span>
                  {r.gated && <span className="imm-tag" title="Needs HF_TOKEN in /etc/sd/fetch.env with access granted on huggingface.co">gated</span>}
                  <span className="tmm-repo-stats">
                    <span>{families.length ? families.join(", ") : "won't load"}</span>
                    <span>{r.files.length} file{r.files.length === 1 ? "" : "s"}</span>
                    <span>↓ {r.downloads.toLocaleString()}</span>
                  </span>
                </button>
                {open && (
                  <div className="tmm-quants">
                    {r.files.map((f) => {
                      const loadable = f.kind === "component" || !!f.recipe;
                      const tooBigForDisk = usableDisk != null && f.size > usableDisk;
                      const isThisJob = jobActive && job.repo === r.id && job.path === f.path;
                      return (
                        <div key={f.path} className="imm-hf-file">
                          <span className="tmm-quant-tag imm-path" title={f.path}>
                            {f.path}
                          </span>
                          <span className="tmm-quant-size">{formatBytes(f.size)}</span>
                          {f.kind === "model" ? <Fit level={f.fit} size={f.size} gpuBytes={gpuBytes} /> : <span />}
                          <span className="tmm-quant-action">
                            {f.installed ? (
                              <span className="tmm-installed">Installed</span>
                            ) : isThisJob ? (
                              <span className="tmm-installed">Downloading…</span>
                            ) : (
                              <Button
                                variant={f.fit === "nofit" ? "ghost" : "primary"}
                                className="btn-sm"
                                disabled={!loadable || !helperReady || jobActive || tooBigForDisk}
                                title={
                                  !loadable
                                    ? "No sd-server recipe for this file"
                                    : !helperReady
                                      ? "The download helper isn't reachable"
                                      : jobActive
                                        ? "One download at a time"
                                        : tooBigForDisk
                                          ? "Not enough disk space on the sd-server host"
                                          : `Download to ${f.category}/`
                                }
                                onClick={() => install(r, f)}
                              >
                                Install
                              </Button>
                            )}
                          </span>
                          <span className="imm-hf-detail">
                            {f.kind === "component" ? (
                              <>component → {f.category}/</>
                            ) : f.recipe ? (
                              <>
                                {f.recipeName} <code>{f.recipe}</code> → {f.category}/
                                {f.needs.length > 0 && <> · also needs {f.needs.map((n) => n.label).join(", ")}</>}
                              </>
                            ) : (
                              <span className="imm-wont">won't load: {f.reason}</span>
                            )}
                            {tooBigForDisk && <span className="imm-wont"> · not enough disk space</span>}
                          </span>
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
          remove(deleteTarget);
          setDeleteTarget(null);
        }}
        title="Delete image model file"
        message={`Delete ${deleteTarget?.id}${deleteTarget?.size ? ` (${formatBytes(deleteTarget.size)})` : ""} from the sd-server host? It will need to be downloaded again to use it.`}
        confirmText="Delete"
      />
    </div>
  );
}
