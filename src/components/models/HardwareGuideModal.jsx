import { useEffect, useMemo, useState } from "react";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import { fetchHardwareInfo, getAvailableCapacity } from "../../services/hardwareApi.js";
import {
  MODEL_CATALOG,
  getCompatibility,
  pickBestVariant,
  COMPAT_RANK,
  COMPAT_LABELS,
} from "../../constants/modelCatalog.js";
import "./HardwareGuideModal.css";

export default function HardwareGuideModal({ isOpen, onClose }) {
  const [hardware, setHardware] = useState(null);
  const [loading, setLoading] = useState(false);
  const [showManualCommands, setShowManualCommands] = useState(false);

  useEffect(() => {
    if (isOpen) {
      setLoading(true);
      fetchHardwareInfo().then((data) => {
        setHardware(data.ok ? data : null);
        setLoading(false);
      });
    }
  }, [isOpen]);

  const availableCapacity = useMemo(() => getAvailableCapacity(hardware), [hardware]);
  const hasGpu = hardware?.gpus?.length > 0;

  // Best-fitting catalog models for this machine, best fit first.
  const recommended = useMemo(() => {
    if (!availableCapacity) return [];
    return MODEL_CATALOG.map((model) => {
      const variant = pickBestVariant(model, availableCapacity);
      const compat = getCompatibility(variant.vramGb, availableCapacity);
      return { model, variant, compat };
    })
      .filter((r) => r.compat === "excellent" || r.compat === "good")
      .sort((a, b) => COMPAT_RANK[a.compat] - COMPAT_RANK[b.compat])
      .slice(0, 10);
  }, [availableCapacity]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Hardware Detection"
      footer={
        <Button variant="ghost" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="hw-modal-content">
        {/* Detected Hardware Section — reports on the server actually running
            Ollama, not the browser viewing this dashboard. */}
        {loading ? (
          <div className="hw-text">Detecting hardware…</div>
        ) : hardware ? (
          <div className="hw-detected-card">
            <div className="hw-gpu-name">
              {hasGpu
                ? hardware.gpus.map((g) => g.name).join(", ")
                : hardware.cpu?.model || "Unknown CPU"}
            </div>
            <div className="hw-vram-display">
              <span className="hw-vram-value">
                {hasGpu ? hardware.totalVramGb : hardware.ram?.totalGb} GB
              </span>
              <span className="hw-vram-label">{hasGpu ? "VRAM" : "System RAM"}</span>
              {!hasGpu && hardware.cpu?.cores && (
                <span className="hw-tier-badge" style={{ background: "#60a5fa20", color: "#60a5fa" }}>
                  {hardware.cpu.cores} cores
                </span>
              )}
            </div>
            <div className="hw-tier-description">
              {hasGpu
                ? "Dedicated GPU detected on this server — models load into VRAM."
                : `No dedicated GPU detected on this server (${hardware.platform}/${hardware.arch}) — models run on CPU using system RAM.`}
            </div>
            {!hasGpu && hardware.ram?.availableGb != null && (
              <div className="hw-tier-description">
                {hardware.ram.availableGb} GB currently available (other processes on this
                machine are using the rest) — recommendations below are sized to fit that and
                stay responsive on {hardware.cpu?.cores} CPU cores.
              </div>
            )}
          </div>
        ) : (
          <div className="hw-not-detected">
            <div className="hw-not-detected-error">Could not detect hardware</div>
            <div className="hw-not-detected-desc">
              The server didn't report hardware info. Use the manual commands below to check
              your GPU memory.
            </div>
          </div>
        )}

        {/* Recommended Models — based on the server's real detected capacity */}
        {recommended.length > 0 && (
          <div className="hw-section">
            <h3 className="hw-section-title">Recommended for this machine</h3>
            <div className="hw-recommended">
              <div className="hw-recommended-title">
                Best fit given {availableCapacity} GB {hasGpu ? "VRAM" : "usable RAM"}
              </div>
              <div className="hw-model-list">
                {recommended.map(({ model, variant, compat }) => (
                  <span
                    key={`${model.name}:${variant.tag}`}
                    className="hw-model-chip"
                    style={{
                      color: COMPAT_LABELS[compat].color,
                      borderColor: `${COMPAT_LABELS[compat].color}40`,
                    }}
                    title={`${COMPAT_LABELS[compat].label} — ${model.displayName}`}
                  >
                    {model.name}:{variant.tag}
                  </span>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* Manual Commands (Collapsible) — for GPUs this server can't
            auto-detect VRAM for (AMD, Intel Arc, etc). */}
        <div>
          <div
            className="hw-collapsible-header"
            onClick={() => setShowManualCommands(!showManualCommands)}
          >
            <span className="hw-collapsible-title">Manual Detection Commands</span>
            <span className="hw-collapsible-icon">
              {showManualCommands ? "−" : "+"}
            </span>
          </div>
          {showManualCommands && (
            <div className="hw-collapsible-body">
              <p className="hw-text">
                Automatic detection covers NVIDIA GPUs and system RAM. For AMD/Intel GPUs, run
                these on the server for detailed info:
              </p>

              <div className="hw-label">Linux (NVIDIA)</div>
              <div className="hw-code-block" onClick={() => copyToClipboard("nvidia-smi")}>
                nvidia-smi
              </div>

              <div className="hw-label">Linux (AMD)</div>
              <div className="hw-code-block" onClick={() => copyToClipboard("rocm-smi")}>
                rocm-smi
              </div>

              <div className="hw-label">macOS</div>
              <div
                className="hw-code-block"
                onClick={() => copyToClipboard("system_profiler SPDisplaysDataType")}
              >
                system_profiler SPDisplaysDataType
              </div>

              <div className="hw-label">Windows (PowerShell)</div>
              <div
                className="hw-code-block"
                onClick={() =>
                  copyToClipboard(
                    "Get-WmiObject Win32_VideoController | Select Name, AdapterRAM"
                  )
                }
              >
                Get-WmiObject Win32_VideoController | Select Name, AdapterRAM
              </div>
            </div>
          )}
        </div>

        {/* Finding Models Section */}
        <div className="hw-section" style={{ marginTop: "8px" }}>
          <h3 className="hw-section-title">Finding More Models</h3>
          <p className="hw-text">
            Browse the Ollama model library for all available models:
          </p>
          <p className="hw-text" style={{ marginBottom: "8px" }}>
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noopener noreferrer"
              className="hw-link"
            >
              ollama.com/library
            </a>
          </p>
          <p className="hw-text">
            Look for tags like <code style={{ color: "var(--color-primary)" }}>:7b-q4_K_M</code> which
            indicate 7 billion parameters with 4-bit quantization — these use less VRAM.
          </p>
        </div>

        <div className="hw-tip-box">
          <strong>Tip:</strong> If a model runs slowly or crashes, try a smaller quantization
          (e.g., <code>mistral:7b-q4</code> instead of <code>mistral:7b</code>) or a smaller
          model.
        </div>
      </div>
    </Modal>
  );
}
