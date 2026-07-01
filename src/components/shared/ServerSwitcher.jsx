import { useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { ollamaApi } from "../../services/ollamaApi.js";
import "./ServerSwitcher.css";

const FEASIBILITY_LABEL = {
  good: "Runs well",
  slow: "Slow",
  poor: "Not recommended",
};

const FEASIBILITY_ICON = {
  good: "✓",
  slow: "~",
  poor: "✗",
};

function formatSize(bytes) {
  if (!bytes) return "?";
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function CapabilityModal({ models, hardware, onClose }) {
  const hasGpu = hardware?.gpus?.length > 0;
  const capacityGb = hasGpu ? hardware.totalVramGb : hardware?.ram?.totalGb;
  const capacityLabel = hasGpu ? "VRAM" : "RAM";

  return (
    <div className="server-capability-backdrop" onClick={onClose}>
      <div className="server-capability-modal" onClick={(e) => e.stopPropagation()}>
        <div className="server-capability-header">
          <span>Local model check</span>
          <button className="server-capability-close" onClick={onClose}>✕</button>
        </div>
        <p className="server-capability-desc">
          {hasGpu
            ? `Feasibility is based on this machine's detected ${capacityGb} GB ${capacityLabel}.`
            : capacityGb
              ? `No GPU detected — running on CPU. Feasibility is based on this machine's ${capacityGb} GB ${capacityLabel}.`
              : "Feasibility is based on model size (hardware detection unavailable)."}
        </p>
        {models.length === 0 ? (
          <p className="server-capability-empty">No models found in local Ollama.</p>
        ) : (
          <ul className="server-capability-list">
            {models.map((m) => (
              <li key={m.name} className={`server-capability-item feasibility-${m.cpuFeasibility}`}>
                <span className="server-capability-icon">{FEASIBILITY_ICON[m.cpuFeasibility]}</span>
                <span className="server-capability-name">{m.name}</span>
                <span className="server-capability-size">{formatSize(m.size)}</span>
                <span className="server-capability-label">{FEASIBILITY_LABEL[m.cpuFeasibility]}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

export default function ServerSwitcher() {
  const { activeTarget, remoteOllamaUrl, serverSwitching, switchServer } = useSettingsStore();
  const { fetchModels } = useModelsStore();
  const [capability, setCapability] = useState(null);
  const [checking, setChecking] = useState(false);

  const handleLocal = async () => {
    if (activeTarget === "local") return;
    try {
      await switchServer("local");
      fetchModels();
      setChecking(true);
      try {
        const result = await ollamaApi.getLocalCapability();
        setCapability(result);
      } catch {
        // capability check failed (local Ollama not running), still switched
      } finally {
        setChecking(false);
      }
    } catch {
      // switch failed, error in store
    }
  };

  const handleRemote = async () => {
    if (activeTarget === "remote") return;
    if (!remoteOllamaUrl) return;
    try {
      await switchServer("remote");
      fetchModels();
    } catch {
      // error in store
    }
  };

  const isLocal = activeTarget === "local";
  const isRemote = activeTarget === "remote";
  const remoteConfigured = !!remoteOllamaUrl;

  return (
    <>
      <div className="server-switcher" title={remoteConfigured ? undefined : "Configure GPU server URL in Settings"}>
        <button
          className={`server-switcher-btn ${isLocal ? "active" : ""}`}
          onClick={handleLocal}
          disabled={serverSwitching || checking}
        >
          {(serverSwitching && isRemote) || checking ? (
            <span className="server-switcher-spinner" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="2" y="3" width="20" height="14" rx="2" />
              <path d="M8 21h8M12 17v4" />
            </svg>
          )}
          <span className="server-switcher-label">Local</span>
        </button>
        <button
          className={`server-switcher-btn ${isRemote ? "active" : ""} ${!remoteConfigured ? "disabled" : ""}`}
          onClick={handleRemote}
          disabled={serverSwitching || !remoteConfigured}
          title={remoteConfigured ? undefined : "Set GPU server URL in Settings → Ollama Server"}
        >
          {serverSwitching && isLocal ? (
            <span className="server-switcher-spinner" />
          ) : (
            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5">
              <rect x="2" y="2" width="20" height="8" rx="2" />
              <rect x="2" y="14" width="20" height="8" rx="2" />
              <line x1="6" y1="6" x2="6.01" y2="6" />
              <line x1="6" y1="18" x2="6.01" y2="18" />
            </svg>
          )}
          <span className="server-switcher-label">GPU Server</span>
        </button>
      </div>

      {capability !== null && (
        <CapabilityModal
          models={capability.models}
          hardware={capability.hardware}
          onClose={() => setCapability(null)}
        />
      )}
    </>
  );
}
