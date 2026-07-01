import { useState, useEffect, useMemo } from "react";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import { fetchHardwareInfo, getAvailableCapacity } from "../../services/hardwareApi.js";
import {
  MODEL_CATALOG,
  MODEL_CATEGORIES,
  getCompatibility,
  COMPAT_LABELS,
  COMPAT_RANK,
  pickBestVariant,
} from "../../constants/modelCatalog.js";
import "./ModelPullDialog.css";

export default function ModelPullDialog({
  isOpen,
  onClose,
  onPull,
  pullProgress,
  localModels = [],
}) {
  const [customName, setCustomName] = useState("");
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [hardware, setHardware] = useState(null);
  const [hwLoading, setHwLoading] = useState(false);
  const [showCustom, setShowCustom] = useState(false);

  // Fetch hardware info when dialog opens
  useEffect(() => {
    if (isOpen) {
      setCustomName("");
      setSearch("");
      setShowCustom(false);
      setHwLoading(true);
      fetchHardwareInfo().then((data) => {
        if (data.ok) setHardware(data);
        setHwLoading(false);
      });
    }
  }, [isOpen]);

  // Build a set of installed model names for quick lookup
  const installedSet = useMemo(() => {
    const s = new Set();
    for (const m of localModels) {
      s.add(m.name);
      // Also add base name without tag  e.g. "llama3.1:8b" -> "llama3.1"
      const base = m.name.split(":")[0];
      s.add(base);
    }
    return s;
  }, [localModels]);

  // Determine available VRAM (use server-reported GPU, fallback to RAM-based estimate)
  const availableVram = useMemo(() => getAvailableCapacity(hardware), [hardware]);

  // Filter catalog
  const filteredModels = useMemo(() => {
    let models = MODEL_CATALOG;

    if (category !== "all") {
      models = models.filter((m) => m.categories.includes(category));
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      models = models.filter(
        (m) =>
          m.name.toLowerCase().includes(q) ||
          m.displayName.toLowerCase().includes(q) ||
          m.description.toLowerCase().includes(q)
      );
    }

    // Surface the best-fitting models for this machine first.
    if (availableVram) {
      models = [...models].sort((a, b) => {
        const rankA = COMPAT_RANK[getCompatibility(pickBestVariant(a, availableVram).vramGb, availableVram)];
        const rankB = COMPAT_RANK[getCompatibility(pickBestVariant(b, availableVram).vramGb, availableVram)];
        return rankA - rankB;
      });
    }

    return models;
  }, [category, search, availableVram]);

  const handlePullVariant = (modelName, tag) => {
    const fullName = tag === "latest" ? modelName : `${modelName}:${tag}`;
    onPull(fullName);
  };

  const handleCustomPull = () => {
    if (customName.trim()) {
      onPull(customName.trim());
    }
  };

  const isPulling = pullProgress !== null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={isPulling ? undefined : onClose}
      title="Pull Model"
      showCloseButton={!isPulling}
    >
      <div className="pull-dialog">
        {isPulling ? (
          <div className="pull-progress">
            <div className="pull-progress-model">{pullProgress.model}</div>
            <div className="pull-progress-bar">
              <div
                className="pull-progress-fill"
                style={{ width: `${pullProgress.progress}%` }}
              />
            </div>
            <p className="pull-status">
              {pullProgress.status}
              {pullProgress.progress > 0 && ` (${pullProgress.progress}%)`}
            </p>
          </div>
        ) : (
          <>
            {/* ── Hardware Summary ──────────────────────── */}
            <div className="pull-hw-summary">
              {hwLoading ? (
                <div className="pull-hw-loading">Detecting hardware…</div>
              ) : hardware ? (
                <>
                  {hardware.gpus?.length > 0 ? (
                    hardware.gpus.map((gpu) => (
                      <div key={gpu.index} className="pull-hw-chip gpu">
                        <span className="pull-hw-icon">⬡</span>
                        <span className="pull-hw-label">{gpu.name}</span>
                        <span className="pull-hw-value">{gpu.vramTotalGb} GB VRAM</span>
                        <span className="pull-hw-free">({gpu.vramFreeGb} GB free)</span>
                      </div>
                    ))
                  ) : (
                    <div className="pull-hw-chip ram">
                      <span className="pull-hw-icon">▦</span>
                      <span className="pull-hw-label">CPU only</span>
                      <span className="pull-hw-value">{hardware.ram?.totalGb} GB RAM</span>
                    </div>
                  )}
                  <div className="pull-hw-chip ram">
                    <span className="pull-hw-icon">▤</span>
                    <span className="pull-hw-label">System RAM</span>
                    <span className="pull-hw-value">{hardware.ram?.totalGb} GB</span>
                    <span className="pull-hw-free">({hardware.ram?.freeGb} GB free)</span>
                  </div>
                </>
              ) : (
                <div className="pull-hw-chip unknown">
                  <span className="pull-hw-icon">?</span>
                  <span className="pull-hw-label">Hardware detection unavailable</span>
                </div>
              )}
            </div>

            {/* ── Search & Filters ──────────────────────── */}
            <div className="pull-controls">
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search models…"
                className="pull-search"
              />
              <div className="pull-categories">
                {MODEL_CATEGORIES.map((cat) => (
                  <button
                    key={cat.id}
                    className={`pull-cat-btn ${category === cat.id ? "active" : ""}`}
                    onClick={() => setCategory(cat.id)}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>
            </div>

            {/* ── Model Library ─────────────────────────── */}
            <div className="pull-library">
              {filteredModels.length === 0 ? (
                <div className="pull-empty">No models found matching your search.</div>
              ) : (
                filteredModels.map((model) => (
                  <CatalogModelCard
                    key={model.name}
                    model={model}
                    availableVram={availableVram}
                    hasGpu={hardware?.gpus?.length > 0}
                    installedSet={installedSet}
                    onPull={handlePullVariant}
                  />
                ))
              )}
            </div>

            {/* ── Custom Model Name ─────────────────────── */}
            <div className="pull-custom-section">
              <button
                className="pull-custom-toggle"
                onClick={() => setShowCustom(!showCustom)}
              >
                {showCustom ? "▾" : "▸"} Pull by name
              </button>
              {showCustom && (
                <div className="pull-custom-row">
                  <Input
                    value={customName}
                    onChange={(e) => setCustomName(e.target.value)}
                    placeholder="e.g., llama3, mistral, codellama:7b"
                    onKeyDown={(e) => e.key === "Enter" && handleCustomPull()}
                    className="pull-custom-input"
                  />
                  <Button onClick={handleCustomPull} disabled={!customName.trim()}>
                    Pull
                  </Button>
                </div>
              )}
              <p className="pull-help">
                Browse{" "}
                <a
                  href="https://ollama.com/library"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="pull-link"
                >
                  ollama.com/library
                </a>{" "}
                for more models.
              </p>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

/* ── Catalog Model Card ──────────────────────────────────── */

function CatalogModelCard({ model, availableVram, hasGpu, installedSet, onPull }) {
  const [expanded, setExpanded] = useState(false);
  const showVariants = model.variants.length > 1;

  // Pick the "default" variant (largest one that fits, or the smallest)
  const bestVariant = useMemo(
    () => pickBestVariant(model, availableVram),
    [model, availableVram]
  );

  return (
    <div className="catalog-card">
      <div className="catalog-card-main" onClick={() => showVariants && setExpanded(!expanded)}>
        <div className="catalog-card-info">
          <div className="catalog-card-title-row">
            <h4 className="catalog-card-name">{model.displayName}</h4>
            <div className="catalog-card-badges">
              {model.toolSupport && <span className="catalog-badge tools">Tools</span>}
              {model.categories.map((c) => (
                <span key={c} className="catalog-badge cat">{c}</span>
              ))}
            </div>
          </div>
          <p className="catalog-card-desc">{model.description}</p>
          {!expanded && (
            <VariantRow
              model={model}
              variant={bestVariant}
              availableVram={availableVram}
              hasGpu={hasGpu}
              installedSet={installedSet}
              onPull={onPull}
              isDefault
            />
          )}
        </div>
        {showVariants && (
          <button className="catalog-expand-btn">
            {expanded ? "▾" : "▸"} {model.variants.length} sizes
          </button>
        )}
      </div>

      {expanded && (
        <div className="catalog-variants">
          {model.variants.map((v) => (
            <VariantRow
              key={v.tag}
              model={model}
              variant={v}
              availableVram={availableVram}
              hasGpu={hasGpu}
              installedSet={installedSet}
              onPull={onPull}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Variant Row ─────────────────────────────────────────── */

function VariantRow({ model, variant, availableVram, hasGpu, installedSet, onPull, isDefault }) {
  const compat = getCompatibility(variant.vramGb, availableVram);
  const compatInfo = COMPAT_LABELS[compat];
  const fullName = variant.tag === "latest" ? model.name : `${model.name}:${variant.tag}`;
  const isInstalled = installedSet.has(fullName) || installedSet.has(model.name + ":" + variant.tag);

  return (
    <div className={`variant-row ${isDefault ? "variant-default" : ""}`}>
      <div className="variant-info">
        <span className="variant-tag">{variant.tag}</span>
        <span className="variant-params">{variant.params}</span>
        <span className="variant-quant">{variant.quantization}</span>
      </div>

      <div className="variant-stats">
        <span className="variant-stat">
          <span className="variant-stat-label">{hasGpu ? "VRAM" : "RAM"}</span>
          <span className="variant-stat-value">{variant.vramGb} GB</span>
        </span>
        <span className="variant-stat">
          <span className="variant-stat-label">Disk</span>
          <span className="variant-stat-value">{variant.diskGb} GB</span>
        </span>
        <span
          className="variant-compat"
          style={{ color: compatInfo.color, borderColor: `${compatInfo.color}40` }}
          title={`${compatInfo.label}: requires ${variant.vramGb} GB${availableVram ? `, you have ${availableVram} GB` : ""}`}
        >
          <span className="variant-compat-icon">{compatInfo.icon}</span>
          {compatInfo.label}
        </span>
      </div>

      <div className="variant-action">
        {isInstalled ? (
          <span className="variant-installed">Installed</span>
        ) : (
          <Button
            variant={compat === "insufficient" ? "ghost" : "primary"}
            onClick={(e) => {
              e.stopPropagation();
              onPull(model.name, variant.tag);
            }}
            className="variant-pull-btn"
          >
            Pull
          </Button>
        )}
      </div>
    </div>
  );
}
