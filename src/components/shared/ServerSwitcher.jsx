import { useEffect, useState } from "react";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { ConfirmModal } from "./Modal.jsx";
import { FEASIBILITY_LABEL, FEASIBILITY_ICON } from "../../constants/feasibility.js";
import "./ServerSwitcher.css";

const REMOTE_STATUS_POLL_MS = 10000;

function formatSize(bytes) {
  if (!bytes) return "?";
  const gb = bytes / (1024 ** 3);
  return gb >= 1 ? `${gb.toFixed(1)} GB` : `${(bytes / (1024 ** 2)).toFixed(0)} MB`;
}

function CapabilityModal({ models, hardware, onClose }) {
  const hasGpu = hardware?.gpus?.length > 0;
  const capacityGb = hardware?.effectiveCapacityGb;
  const capacityLabel = hasGpu ? "VRAM" : "usable RAM";

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
  const { activeTarget, remoteOllamaUrl, remoteStatus, serverSwitching, switchServer, fetchRemoteStatus } = useSettingsStore();
  const { fetchModels, localCapability, fetchLocalCapability } = useModelsStore();
  const [showCapability, setShowCapability] = useState(false);
  const [checking, setChecking] = useState(false);
  const [confirmOfflineSwitch, setConfirmOfflineSwitch] = useState(false);

  // Poll GPU-server reachability continuously, regardless of which mode is
  // currently active, so the badge is accurate before the user opens the switcher.
  useEffect(() => {
    fetchRemoteStatus();
    const id = setInterval(fetchRemoteStatus, REMOTE_STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [fetchRemoteStatus]);

  const handleLocal = async () => {
    if (activeTarget === "local") return;
    try {
      await switchServer("local");
      fetchModels();
      setChecking(true);
      const result = await fetchLocalCapability();
      if (result) setShowCapability(true);
      setChecking(false);
    } catch {
      // switch failed, error in store
    }
  };

  const doSwitchRemote = async () => {
    try {
      await switchServer("remote");
      fetchModels();
    } catch {
      // error in store
    }
  };

  const handleRemote = async () => {
    if (activeTarget === "remote") return;
    if (!remoteOllamaUrl) return;
    if (remoteStatus.online === false) {
      setConfirmOfflineSwitch(true);
      return;
    }
    await doSwitchRemote();
  };

  const isLocal = activeTarget === "local";
  const isRemote = activeTarget === "remote";
  const remoteConfigured = !!remoteOllamaUrl;
  const remoteDotColor = !remoteConfigured ? null : remoteStatus.online === true ? "#4ade80" : remoteStatus.online === false ? "#f87171" : "#9ca3af";

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
          <span className="server-switcher-label">Mini Mode</span>
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
          <span className="server-switcher-label">GPU Mode</span>
          {remoteDotColor && (
            <span
              className="server-switcher-dot"
              style={{ backgroundColor: remoteDotColor }}
              title={remoteStatus.online === false ? "GPU server unreachable" : remoteStatus.online === true ? "GPU server online" : "GPU server status unknown"}
            />
          )}
        </button>
      </div>

      {showCapability && (
        <CapabilityModal
          models={localCapability.models}
          hardware={localCapability.hardware}
          onClose={() => setShowCapability(false)}
        />
      )}

      <ConfirmModal
        isOpen={confirmOfflineSwitch}
        onClose={() => setConfirmOfflineSwitch(false)}
        onConfirm={() => {
          setConfirmOfflineSwitch(false);
          doSwitchRemote();
        }}
        title="GPU server appears offline"
        message="LLMUI couldn't reach the GPU server on its last check. Switch to GPU Mode anyway?"
        confirmText="Switch anyway"
        variant="danger"
      />
    </>
  );
}
