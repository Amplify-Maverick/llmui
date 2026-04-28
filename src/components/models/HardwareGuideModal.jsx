import { useEffect, useState, useCallback } from "react";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import ModelTag from "./ModelTag.jsx";
import { MODEL_TIERS } from "../../constants/hardwareTiers.js";
import { detectGPU, parseGPUName } from "../../utils/hardwareDetection.js";
import "./HardwareGuideModal.css";

export default function HardwareGuideModal({ isOpen, onClose, onInstallModel }) {
  const [gpuInfo, setGpuInfo] = useState(null);
  const [showManualCommands, setShowManualCommands] = useState(false);
  const [showAllTiers, setShowAllTiers] = useState(false);

  useEffect(() => {
    if (isOpen) {
      const info = detectGPU();
      setGpuInfo(info);
    }
  }, [isOpen]);

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
  };

  const handleModelClick = useCallback((model) => {
    if (onInstallModel) {
      onInstallModel(model);
    }
  }, [onInstallModel]);

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
        {/* Detected Hardware Section */}
        {gpuInfo?.detected && gpuInfo.vram ? (
          <div className="hw-detected-card">
            <div className="hw-gpu-name">{parseGPUName(gpuInfo.renderer)}</div>
            <div className="hw-vram-display">
              <span className="hw-vram-value">{gpuInfo.vram} GB</span>
              <span className="hw-vram-label">VRAM</span>
              {gpuInfo.tier && (
                <span
                  className="hw-tier-badge"
                  style={{
                    background: `${gpuInfo.tier.color}20`,
                    color: gpuInfo.tier.color,
                  }}
                >
                  {gpuInfo.tier.name}
                </span>
              )}
            </div>
            {gpuInfo.tier && (
              <>
                <div className="hw-tier-description">{gpuInfo.tier.description}</div>
                <div className="hw-recommended">
                  <div className="hw-recommended-title">Recommended Models</div>
                  <div className="hw-model-list">
                    {gpuInfo.tier.models.map((model) => (
                      <ModelTag key={model} model={model} onClick={handleModelClick} />
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : gpuInfo?.detected ? (
          <div className="hw-not-detected">
            <div className="hw-not-detected-title">
              GPU Detected: {parseGPUName(gpuInfo.renderer)}
            </div>
            <div className="hw-not-detected-desc">
              Could not determine VRAM automatically. Use the commands below to check your GPU memory.
            </div>
          </div>
        ) : (
          <div className="hw-not-detected">
            <div className="hw-not-detected-error">Could not detect GPU</div>
            <div className="hw-not-detected-desc">
              {gpuInfo?.error || "WebGL is not available. Use the commands below to check your hardware."}
            </div>
          </div>
        )}

        {/* Manual Commands (Collapsible) */}
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
                Run these commands in your terminal for detailed GPU info:
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

        {/* All Model Tiers (Collapsible) */}
        <div>
          <div
            className="hw-collapsible-header"
            onClick={() => setShowAllTiers(!showAllTiers)}
          >
            <span className="hw-collapsible-title">All Hardware Tiers & Models</span>
            <span className="hw-collapsible-icon">
              {showAllTiers ? "−" : "+"}
            </span>
          </div>
          {showAllTiers && (
            <div className="hw-collapsible-body">
              {MODEL_TIERS.map((tier) => (
                <div key={tier.name} className="hw-tier-card">
                  <div className="hw-tier-header">
                    <span className="hw-tier-name" style={{ color: tier.color }}>
                      {tier.name}
                    </span>
                    <span
                      className="hw-vram-badge"
                      style={{
                        background: `${tier.color}20`,
                        color: tier.color,
                      }}
                    >
                      {tier.vram} VRAM
                    </span>
                  </div>
                  <div className="hw-tier-gpus">{tier.gpus}</div>
                  <div className="hw-tier-notes">{tier.notes}</div>
                  <div className="hw-model-list">
                    {tier.models.map((model) => (
                      <ModelTag key={model} model={model} onClick={handleModelClick} />
                    ))}
                  </div>
                </div>
              ))}
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
