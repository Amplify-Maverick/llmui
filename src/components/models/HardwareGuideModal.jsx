import { useEffect, useState, useCallback } from "react";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import { detectGPU, parseGPUName } from "../../utils/hardwareDetection.js";

function ModelTag({ model, onClick }) {
  const [isHovered, setIsHovered] = useState(false);

  const style = {
    fontSize: "12px",
    padding: "4px 10px",
    borderRadius: "6px",
    background: isHovered ? "rgba(110, 231, 183, 0.25)" : "rgba(110, 231, 183, 0.1)",
    border: isHovered ? "1px solid rgba(110, 231, 183, 0.5)" : "1px solid rgba(110, 231, 183, 0.2)",
    color: "#6ee7b7",
    fontFamily: "'DM Mono', monospace",
    cursor: "pointer",
    transition: "all 0.15s ease",
    transform: isHovered ? "translateY(-1px)" : "none",
  };

  return (
    <span
      style={style}
      onClick={() => onClick(model)}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={`Click to install ${model}`}
    >
      {model}
    </span>
  );
}

const sectionStyle = {
  marginBottom: "24px",
};

const sectionTitleStyle = {
  fontSize: "15px",
  fontWeight: "600",
  color: "#e8e8f0",
  marginBottom: "12px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const detectedCardStyle = {
  background: "linear-gradient(135deg, rgba(110, 231, 183, 0.1) 0%, rgba(96, 165, 250, 0.1) 100%)",
  border: "1px solid rgba(110, 231, 183, 0.3)",
  borderRadius: "12px",
  padding: "20px",
  marginBottom: "24px",
};

const gpuNameStyle = {
  fontSize: "18px",
  fontWeight: "600",
  color: "#e8e8f0",
  marginBottom: "8px",
};

const vramDisplayStyle = {
  display: "inline-flex",
  alignItems: "center",
  gap: "8px",
  background: "rgba(0, 0, 0, 0.2)",
  padding: "6px 12px",
  borderRadius: "6px",
  marginBottom: "16px",
};

const vramValueStyle = {
  fontSize: "24px",
  fontWeight: "700",
  color: "#6ee7b7",
};

const vramLabelStyle = {
  fontSize: "13px",
  color: "#8a8a9a",
};

const tierBadgeStyle = {
  display: "inline-block",
  fontSize: "12px",
  fontWeight: "600",
  padding: "4px 10px",
  borderRadius: "6px",
  marginLeft: "12px",
};

const recommendedSectionStyle = {
  background: "rgba(0, 0, 0, 0.2)",
  borderRadius: "8px",
  padding: "14px",
  marginTop: "12px",
};

const recommendedTitleStyle = {
  fontSize: "12px",
  fontWeight: "600",
  color: "#8a8a9a",
  marginBottom: "8px",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
};

const modelListStyle = {
  display: "flex",
  flexWrap: "wrap",
  gap: "6px",
};


const notDetectedStyle = {
  background: "rgba(255, 107, 107, 0.1)",
  border: "1px solid rgba(255, 107, 107, 0.2)",
  borderRadius: "12px",
  padding: "20px",
  marginBottom: "24px",
  textAlign: "center",
};

const codeBlockStyle = {
  background: "rgba(0, 0, 0, 0.3)",
  border: "1px solid rgba(255, 255, 255, 0.1)",
  borderRadius: "8px",
  padding: "12px 16px",
  fontFamily: "'DM Mono', monospace",
  fontSize: "13px",
  color: "#6ee7b7",
  marginBottom: "8px",
  overflowX: "auto",
  cursor: "pointer",
};

const labelStyle = {
  fontSize: "12px",
  color: "#8a8a9a",
  marginBottom: "4px",
  fontWeight: "500",
};

const textStyle = {
  color: "#8a8a9a",
  fontSize: "13px",
  lineHeight: "1.6",
  margin: "0 0 12px 0",
};

const collapsibleHeaderStyle = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  cursor: "pointer",
  padding: "12px 0",
  borderTop: "1px solid rgba(255, 255, 255, 0.1)",
  marginTop: "8px",
};

const tierCardStyle = {
  background: "rgba(255, 255, 255, 0.03)",
  border: "1px solid rgba(255, 255, 255, 0.08)",
  borderRadius: "10px",
  padding: "14px",
  marginBottom: "10px",
};

const tierHeaderStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "8px",
};

const tierNameStyle = {
  fontSize: "14px",
  fontWeight: "600",
  color: "#e8e8f0",
};

const vramBadgeStyle = {
  fontSize: "11px",
  fontWeight: "600",
  padding: "3px 8px",
  borderRadius: "4px",
  background: "rgba(96, 165, 250, 0.2)",
  color: "#60a5fa",
};

const linkStyle = {
  color: "#60a5fa",
  textDecoration: "none",
};

const tipBoxStyle = {
  background: "rgba(252, 211, 77, 0.1)",
  border: "1px solid rgba(252, 211, 77, 0.2)",
  borderRadius: "8px",
  padding: "12px 16px",
  fontSize: "13px",
  color: "#fcd34d",
};

const MODEL_TIERS = [
  {
    name: "Entry Level",
    vram: "4-6 GB",
    color: "#fcd34d",
    gpus: "GTX 1650, RTX 3050, RX 6500 XT",
    models: ["tinyllama", "phi3:mini", "gemma:2b", "qwen2:0.5b"],
    notes: "Small models, good for basic tasks and testing",
  },
  {
    name: "Mid Range",
    vram: "8 GB",
    color: "#6ee7b7",
    gpus: "RTX 3060, RTX 4060, RX 6600, RX 7600",
    models: ["llama3.2:3b", "mistral:7b-q4", "gemma2:9b-q4", "qwen2.5:7b-q4"],
    notes: "7B parameter models with 4-bit quantization work well",
  },
  {
    name: "High End",
    vram: "12-16 GB",
    color: "#60a5fa",
    gpus: "RTX 3080, RTX 4070, RTX 4080, RX 7800 XT",
    models: ["llama3.1:8b", "mistral:7b", "codellama:13b-q4", "gemma2:9b"],
    notes: "Run 7B-13B models at higher quality quantization",
  },
  {
    name: "Enthusiast",
    vram: "24+ GB",
    color: "#c4b5fd",
    gpus: "RTX 3090, RTX 4090, A5000, A6000",
    models: ["llama3.1:70b-q4", "codellama:34b", "mixtral:8x7b", "qwen2.5:32b"],
    notes: "Run large 30B-70B models, multiple models simultaneously",
  },
];

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
      <div style={{ maxWidth: "550px" }}>
        {/* Detected Hardware Section */}
        {gpuInfo?.detected && gpuInfo.vram ? (
          <div style={detectedCardStyle}>
            <div style={gpuNameStyle}>{parseGPUName(gpuInfo.renderer)}</div>
            <div style={vramDisplayStyle}>
              <span style={vramValueStyle}>{gpuInfo.vram} GB</span>
              <span style={vramLabelStyle}>VRAM</span>
              {gpuInfo.tier && (
                <span
                  style={{
                    ...tierBadgeStyle,
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
                <div style={{ fontSize: "13px", color: "#8a8a9a", marginBottom: "4px" }}>
                  {gpuInfo.tier.description}
                </div>
                <div style={recommendedSectionStyle}>
                  <div style={recommendedTitleStyle}>Recommended Models</div>
                  <div style={modelListStyle}>
                    {gpuInfo.tier.models.map((model) => (
                      <ModelTag key={model} model={model} onClick={handleModelClick} />
                    ))}
                  </div>
                </div>
              </>
            )}
          </div>
        ) : gpuInfo?.detected ? (
          <div style={notDetectedStyle}>
            <div style={{ fontSize: "16px", color: "#e8e8f0", marginBottom: "8px" }}>
              GPU Detected: {parseGPUName(gpuInfo.renderer)}
            </div>
            <div style={{ fontSize: "13px", color: "#8a8a9a" }}>
              Could not determine VRAM automatically. Use the commands below to check your GPU memory.
            </div>
          </div>
        ) : (
          <div style={notDetectedStyle}>
            <div style={{ fontSize: "16px", color: "#ff6b6b", marginBottom: "8px" }}>
              Could not detect GPU
            </div>
            <div style={{ fontSize: "13px", color: "#8a8a9a" }}>
              {gpuInfo?.error || "WebGL is not available. Use the commands below to check your hardware."}
            </div>
          </div>
        )}

        {/* Manual Commands (Collapsible) */}
        <div>
          <div
            style={collapsibleHeaderStyle}
            onClick={() => setShowManualCommands(!showManualCommands)}
          >
            <span style={{ fontSize: "14px", color: "#8a8a9a" }}>
              Manual Detection Commands
            </span>
            <span style={{ color: "#8a8a9a", fontSize: "18px" }}>
              {showManualCommands ? "−" : "+"}
            </span>
          </div>
          {showManualCommands && (
            <div style={{ paddingBottom: "16px" }}>
              <p style={textStyle}>
                Run these commands in your terminal for detailed GPU info:
              </p>

              <div style={labelStyle}>Linux (NVIDIA)</div>
              <div style={codeBlockStyle} onClick={() => copyToClipboard("nvidia-smi")}>
                nvidia-smi
              </div>

              <div style={labelStyle}>Linux (AMD)</div>
              <div style={codeBlockStyle} onClick={() => copyToClipboard("rocm-smi")}>
                rocm-smi
              </div>

              <div style={labelStyle}>macOS</div>
              <div
                style={codeBlockStyle}
                onClick={() => copyToClipboard("system_profiler SPDisplaysDataType")}
              >
                system_profiler SPDisplaysDataType
              </div>

              <div style={labelStyle}>Windows (PowerShell)</div>
              <div
                style={codeBlockStyle}
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
            style={collapsibleHeaderStyle}
            onClick={() => setShowAllTiers(!showAllTiers)}
          >
            <span style={{ fontSize: "14px", color: "#8a8a9a" }}>
              All Hardware Tiers & Models
            </span>
            <span style={{ color: "#8a8a9a", fontSize: "18px" }}>
              {showAllTiers ? "−" : "+"}
            </span>
          </div>
          {showAllTiers && (
            <div style={{ paddingBottom: "16px" }}>
              {MODEL_TIERS.map((tier) => (
                <div key={tier.name} style={tierCardStyle}>
                  <div style={tierHeaderStyle}>
                    <span style={{ ...tierNameStyle, color: tier.color }}>{tier.name}</span>
                    <span
                      style={{
                        ...vramBadgeStyle,
                        background: `${tier.color}20`,
                        color: tier.color,
                      }}
                    >
                      {tier.vram} VRAM
                    </span>
                  </div>
                  <div style={{ fontSize: "12px", color: "#8a8a9a", marginBottom: "4px" }}>
                    {tier.gpus}
                  </div>
                  <div style={{ fontSize: "12px", color: "#6a6a7a" }}>{tier.notes}</div>
                  <div style={modelListStyle}>
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
        <div style={{ ...sectionStyle, marginTop: "8px" }}>
          <h3 style={sectionTitleStyle}>Finding More Models</h3>
          <p style={textStyle}>
            Browse the Ollama model library for all available models:
          </p>
          <p style={{ ...textStyle, marginBottom: "8px" }}>
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noopener noreferrer"
              style={linkStyle}
            >
              ollama.com/library
            </a>
          </p>
          <p style={textStyle}>
            Look for tags like <code style={{ color: "#6ee7b7" }}>:7b-q4_K_M</code> which
            indicate 7 billion parameters with 4-bit quantization — these use less VRAM.
          </p>
        </div>

        <div style={tipBoxStyle}>
          <strong>Tip:</strong> If a model runs slowly or crashes, try a smaller quantization
          (e.g., <code>mistral:7b-q4</code> instead of <code>mistral:7b</code>) or a smaller
          model.
        </div>
      </div>
    </Modal>
  );
}
