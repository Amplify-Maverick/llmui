import { useState, useEffect, useCallback } from "react";
import { comfyApi } from "../../services/comfyApi.js";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import "./CivitaiModelBrowser.css";

const MODEL_TYPES = [
  { value: "Checkpoint", label: "Checkpoints" },
  { value: "LORA", label: "LoRAs" },
  { value: "LoCon", label: "LoCon" },
  { value: "VAE", label: "VAE" },
  { value: "TextualInversion", label: "Embeddings" },
  { value: "Controlnet", label: "ControlNet" },
  { value: "Upscaler", label: "Upscaler" },
];

const SORT_OPTIONS = [
  { value: "Highest Rated", label: "Highest Rated" },
  { value: "Most Downloaded", label: "Most Downloaded" },
  { value: "Newest", label: "Newest" },
];

function formatFileSize(bytes) {
  if (!bytes) return "Unknown";
  if (bytes < 1024) return bytes + " B";
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + " GB";
}

function formatNumber(num) {
  if (!num) return "0";
  if (num >= 1000000) return (num / 1000000).toFixed(1) + "M";
  if (num >= 1000) return (num / 1000).toFixed(1) + "K";
  return num.toString();
}

/**
 * Estimate VRAM requirement based on file size, base model, and precision.
 * Returns { vram: "~X GB", tier: "low"|"medium"|"high"|"very-high" }
 */
function estimateVram(fileSizeKB, baseModel, fp) {
  if (!fileSizeKB) return null;

  const fileSizeGB = (fileSizeKB * 1024) / (1024 * 1024 * 1024);
  const base = (baseModel || "").toLowerCase();

  // Base VRAM ≈ model file size loaded in memory + ~20% overhead for inference
  let vramGB;

  // Quantized / pruned models (fp16 is roughly half of fp32)
  if (fp === "fp16" || base.includes("fp16")) {
    vramGB = fileSizeGB * 1.2;
  } else if (fp === "fp8" || base.includes("fp8") || base.includes("nf4")) {
    vramGB = fileSizeGB * 1.1;
  } else {
    // Default: assume fp16 storage (most .safetensors are fp16)
    vramGB = fileSizeGB * 1.2;
  }

  // Adjust for known architectures that need extra VRAM for text encoders, VAE, etc.
  if (base.includes("flux")) {
    vramGB += 2; // FLUX needs T5 text encoder
  } else if (base.includes("sdxl") || base.includes("sd xl") || base.includes("pony")) {
    vramGB += 1; // SDXL has dual text encoders
  } else if (base.includes("sd 1") || base.includes("sd1") || base.includes("1.5")) {
    vramGB += 0.5;
  } else if (base.includes("cascade")) {
    vramGB += 1;
  }

  // Minimum 2GB for any model
  vramGB = Math.max(vramGB, 2);

  // Round to nearest 0.5
  vramGB = Math.round(vramGB * 2) / 2;

  let tier;
  if (vramGB <= 6) tier = "low";        // Fits 8GB GPUs easily
  else if (vramGB <= 8) tier = "medium"; // Fits 8GB GPUs tight
  else if (vramGB <= 12) tier = "high";  // Needs 12GB+
  else tier = "very-high";               // Needs 16GB+

  return { vram: `~${vramGB} GB`, tier };
}

/** Get VRAM estimate for a model's latest version */
function getModelVramEstimate(model) {
  const version = model?.modelVersions?.[0];
  if (!version) return null;

  const primaryFile = version.files?.find(f =>
    f.name?.endsWith(".safetensors") || f.name?.endsWith(".ckpt")
  ) || version.files?.[0];

  if (!primaryFile) return null;

  return estimateVram(
    primaryFile.sizeKB,
    version.baseModel,
    primaryFile.metadata?.fp
  );
}

export default function CivitaiModelBrowser({ isOpen, onClose, modelsPath }) {
  const [query, setQuery] = useState("");
  const [modelType, setModelType] = useState("Checkpoint");
  const [sort, setSort] = useState("Most Downloaded");
  const [results, setResults] = useState([]);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState(null);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [selectedModel, setSelectedModel] = useState(null);
  const [downloading, setDownloading] = useState({}); // { [filename]: { percent, downloaded, total, error } }
  const [downloadAborts, setDownloadAborts] = useState({});

  const search = useCallback(async (searchPage = 1) => {
    setIsSearching(true);
    setSearchError(null);
    try {
      const data = await comfyApi.searchCivitai({
        query: query.trim(),
        types: modelType,
        sort,
        limit: 20,
        page: searchPage,
        nsfw: false,
      });
      setResults(data.items || []);
      setPage(searchPage);
      const meta = data.metadata || {};
      setTotalPages(meta.totalPages || 1);
    } catch (err) {
      setSearchError(err.message);
      setResults([]);
    } finally {
      setIsSearching(false);
    }
  }, [query, modelType, sort]);

  useEffect(() => {
    if (isOpen) {
      search(1);
    }
  }, [isOpen]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (isOpen) {
      setSelectedModel(null);
    }
  }, [isOpen]);

  const handleSearch = (e) => {
    e?.preventDefault();
    search(1);
  };

  const handleDownload = async (version, file) => {
    if (!modelsPath) {
      setSearchError("ComfyUI models path not configured. Set it in Settings first.");
      return;
    }

    const filename = file.name;
    const downloadUrl = file.downloadUrl;

    setDownloading((prev) => ({
      ...prev,
      [filename]: { percent: 0, downloaded: 0, total: 0, error: null, complete: false },
    }));

    try {
      const handle = await comfyApi.downloadModel(
        { downloadUrl, filename, modelType },
        (event) => {
          switch (event.type) {
            case "started":
              setDownloading((prev) => ({
                ...prev,
                [filename]: { ...prev[filename], downloadId: event.downloadId },
              }));
              break;
            case "progress":
              setDownloading((prev) => ({
                ...prev,
                [filename]: {
                  ...prev[filename],
                  percent: event.percent,
                  downloaded: event.downloaded,
                  total: event.total,
                },
              }));
              break;
            case "complete":
              setDownloading((prev) => ({
                ...prev,
                [filename]: { ...prev[filename], percent: 100, complete: true },
              }));
              break;
            case "error":
              setDownloading((prev) => ({
                ...prev,
                [filename]: { ...prev[filename], error: event.error },
              }));
              break;
          }
        }
      );

      setDownloadAborts((prev) => ({ ...prev, [filename]: handle }));
    } catch (err) {
      setDownloading((prev) => ({
        ...prev,
        [filename]: { ...prev[filename], error: err.message },
      }));
    }
  };

  const handleCancelDownload = (filename) => {
    const handle = downloadAborts[filename];
    if (handle) {
      handle.abort();
      setDownloading((prev) => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
      setDownloadAborts((prev) => {
        const next = { ...prev };
        delete next[filename];
        return next;
      });
    }
  };

  const renderModelCard = (model) => {
    const thumbUrl = model.modelVersions?.[0]?.images?.[0]?.url;
    const latestVersion = model.modelVersions?.[0];
    const stats = model.stats || {};
    const vramEst = getModelVramEstimate(model);

    return (
      <div
        key={model.id}
        className={`civitai-card ${selectedModel?.id === model.id ? "selected" : ""}`}
        onClick={() => setSelectedModel(selectedModel?.id === model.id ? null : model)}
      >
        <div className="civitai-card-thumb">
          {thumbUrl ? (
            <img src={thumbUrl} alt={model.name} loading="lazy" />
          ) : (
            <div className="civitai-card-no-thumb">🖼️</div>
          )}
          {vramEst && (
            <span className={`civitai-vram-badge vram-${vramEst.tier}`} title="Estimated VRAM requirement">
              🎮 {vramEst.vram}
            </span>
          )}
        </div>
        <div className="civitai-card-info">
          <div className="civitai-card-name" title={model.name}>{model.name}</div>
          <div className="civitai-card-meta">
            <span className="civitai-card-type">{model.type}</span>
            {latestVersion && (
              <span className="civitai-card-version">{latestVersion.name}</span>
            )}
          </div>
          <div className="civitai-card-stats">
            <span title="Downloads">⬇ {formatNumber(stats.downloadCount)}</span>
            <span title="Rating">⭐ {(stats.rating || 0).toFixed(1)}</span>
            <span title="Favorites">♥ {formatNumber(stats.favoriteCount)}</span>
          </div>
        </div>
      </div>
    );
  };

  const renderModelDetail = () => {
    if (!selectedModel) return null;

    return (
      <div className="civitai-detail">
        <div className="civitai-detail-header">
          <h3 className="civitai-detail-title">{selectedModel.name}</h3>
          <button className="civitai-detail-close" onClick={() => setSelectedModel(null)}>×</button>
        </div>

        {selectedModel.description && (
          <p
            className="civitai-detail-desc"
            dangerouslySetInnerHTML={{
              __html: selectedModel.description.replace(/<[^>]*>/g, " ").slice(0, 300),
            }}
          />
        )}

        <div className="civitai-detail-meta">
          <a
            href={`https://civitai.com/models/${selectedModel.id}`}
            target="_blank"
            rel="noopener noreferrer"
            className="civitai-detail-link"
          >
            View on Civitai ↗
          </a>
        </div>

        <div className="civitai-versions">
          <h4 className="civitai-versions-title">Versions & Files</h4>
          {(selectedModel.modelVersions || []).map((version) => (
            <div key={version.id} className="civitai-version">
              <div className="civitai-version-header">
                <span className="civitai-version-name">{version.name}</span>
                {version.baseModel && (
                  <span className="civitai-version-base">{version.baseModel}</span>
                )}
              </div>
              <div className="civitai-files">
                {(version.files || []).map((file) => {
                  const dl = downloading[file.name];
                  const isDownloading = dl && !dl.complete && !dl.error;
                  const isComplete = dl?.complete;
                  const hasError = dl?.error;
                  const fileVram = estimateVram(file.sizeKB, version.baseModel, file.metadata?.fp);

                  return (
                    <div key={file.id} className="civitai-file">
                      <div className="civitai-file-info">
                        <span className="civitai-file-name" title={file.name}>
                          {file.name}
                        </span>
                        <span className="civitai-file-size">
                          {formatFileSize(file.sizeKB ? file.sizeKB * 1024 : 0)}
                        </span>
                        {file.metadata?.fp && (
                          <span className="civitai-file-fp">{file.metadata.fp}</span>
                        )}
                        {file.metadata?.format && (
                          <span className="civitai-file-format">{file.metadata.format}</span>
                        )}
                        {fileVram && (
                          <span className={`civitai-file-vram vram-${fileVram.tier}`} title="Estimated VRAM">
                            🎮 {fileVram.vram}
                          </span>
                        )}
                      </div>

                      {isDownloading ? (
                        <div className="civitai-file-download-progress">
                          <div className="civitai-progress-bar">
                            <div
                              className="civitai-progress-fill"
                              style={{ width: `${dl.percent || 0}%` }}
                            />
                          </div>
                          <span className="civitai-progress-text">
                            {dl.percent}%
                            {dl.total > 0 && ` (${formatFileSize(dl.downloaded)} / ${formatFileSize(dl.total)})`}
                          </span>
                          <button
                            className="civitai-cancel-btn"
                            onClick={() => handleCancelDownload(file.name)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : isComplete ? (
                        <span className="civitai-file-done">✓ Downloaded</span>
                      ) : (
                        <div className="civitai-file-actions">
                          {hasError && (
                            <span className="civitai-file-error" title={dl.error}>
                              ✗ {dl.error.slice(0, 40)}
                            </span>
                          )}
                          <Button
                            variant="primary"
                            onClick={(e) => {
                              e.stopPropagation();
                              handleDownload(version, file);
                            }}
                            disabled={!modelsPath}
                            className="civitai-download-btn"
                          >
                            ⬇ Download
                          </Button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Download Models from Civitai"
      showCloseButton={true}
    >
      <div className="civitai-browser">
        {/* Search Bar */}
        <form className="civitai-search-bar" onSubmit={handleSearch}>
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search models..."
            className="civitai-search-input"
          />
          <select
            className="civitai-filter-select"
            value={modelType}
            onChange={(e) => setModelType(e.target.value)}
          >
            {MODEL_TYPES.map((t) => (
              <option key={t.value} value={t.value}>{t.label}</option>
            ))}
          </select>
          <select
            className="civitai-filter-select"
            value={sort}
            onChange={(e) => setSort(e.target.value)}
          >
            {SORT_OPTIONS.map((s) => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </select>
          <Button onClick={handleSearch} disabled={isSearching}>
            {isSearching ? "Searching..." : "Search"}
          </Button>
        </form>

        {!modelsPath && (
          <div className="civitai-warning">
            ⚠️ ComfyUI models path not configured. Go to <strong>Settings</strong> and set the
            "ComfyUI Models Path" before downloading.
          </div>
        )}

        {searchError && (
          <div className="civitai-error">{searchError}</div>
        )}

        <div className="civitai-content">
          {/* Results Grid */}
          <div className="civitai-results">
            {isSearching ? (
              <div className="civitai-loading">Searching Civitai...</div>
            ) : results.length === 0 ? (
              <div className="civitai-empty">
                No models found. Try a different search term.
              </div>
            ) : (
              <>
                <div className="civitai-grid">
                  {results.map(renderModelCard)}
                </div>

                {/* Pagination */}
                {totalPages > 1 && (
                  <div className="civitai-pagination">
                    <Button
                      variant="ghost"
                      disabled={page <= 1 || isSearching}
                      onClick={() => search(page - 1)}
                    >
                      ← Previous
                    </Button>
                    <span className="civitai-page-info">
                      Page {page} of {totalPages}
                    </span>
                    <Button
                      variant="ghost"
                      disabled={page >= totalPages || isSearching}
                      onClick={() => search(page + 1)}
                    >
                      Next →
                    </Button>
                  </div>
                )}
              </>
            )}
          </div>

          {/* Detail Panel */}
          {selectedModel && renderModelDetail()}
        </div>
      </div>
    </Modal>
  );
}
