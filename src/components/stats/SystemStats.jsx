import { useEffect, useState } from "react";
import { ollamaApi } from "../../services/ollamaApi.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { formatBytes } from "../../utils/formatters.js";
import { fetchHardwareInfo } from "../../services/hardwareApi.js";
import StatCard from "./StatCard.jsx";
import GpuStats from "./GpuStats.jsx";
import "./SystemStats.css";

export default function SystemStats() {
  const { localModels, unloadModel } = useModelsStore();
  const [runningModels, setRunningModels] = useState([]);
  const [unloadingModel, setUnloadingModel] = useState(null);
  const [hardware, setHardware] = useState(null);

  const fetchRunning = async () => {
    try {
      const data = await ollamaApi.listRunningModels();
      setRunningModels(data.models || []);
    } catch (err) {
      console.error("Failed to fetch running models:", err);
    }
  };

  useEffect(() => {
    fetchRunning();
    const id = setInterval(fetchRunning, 5000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    fetchHardwareInfo().then((data) => {
      if (data.ok) setHardware(data);
    });
  }, []);

  const handleUnload = async (modelName) => {
    setUnloadingModel(modelName);
    try {
      await unloadModel(modelName);
      await fetchRunning();
    } catch (err) {
      console.error("Failed to unload model:", err);
    } finally {
      setUnloadingModel(null);
    }
  };

  const totalSize = localModels.reduce((acc, m) => acc + (m.size || 0), 0);

  return (
    <div className="system-stats">
      <h2 className="system-stats-title">System Overview</h2>

      <div className="system-stats-grid">
        <StatCard
          label="Installed Models"
          value={localModels.length}
          color="#6ee7b7"
        />
        <StatCard
          label="Total Storage"
          value={formatBytes(totalSize)}
          color="#60a5fa"
        />
        <StatCard
          label="Running Models"
          value={runningModels.length}
          color="#fcd34d"
        />
        {hardware && (
          <>
            <StatCard
              label="System RAM"
              value={`${hardware.ram.totalGb} GB`}
              color="#c4b5fd"
            />
            <StatCard
              label="CPU"
              value={`${hardware.cpu.cores} cores`}
              color="#ff8fab"
            />
          </>
        )}
      </div>

      <GpuStats />

      {runningModels.length > 0 && (
        <>
          <h3 className="system-stats-section-title">Running Models</h3>
          {runningModels.map((model) => (
            <div key={model.name} className="running-model-card">
              <div className="running-model-header">
                <div className="running-model-name">{model.name}</div>
                <button
                  className="running-model-unload-btn"
                  onClick={() => handleUnload(model.name)}
                  disabled={unloadingModel === model.name}
                  title="Unload model from VRAM"
                >
                  {unloadingModel === model.name ? "Unloading..." : "Unload"}
                </button>
              </div>
              {model.size && (
                <div className="running-model-detail">
                  <span>Size</span>
                  <span className="running-model-detail-mono">
                    {formatBytes(model.size)}
                  </span>
                </div>
              )}
              {model.size_vram !== undefined && (
                <div className="running-model-detail">
                  <span>VRAM Used</span>
                  <span className="running-model-detail-mono">
                    {formatBytes(model.size_vram)}
                  </span>
                </div>
              )}
              {model.expires_at && (
                <div className="running-model-detail">
                  <span>Expires</span>
                  <span className="running-model-detail-mono">
                    {new Date(model.expires_at).toLocaleTimeString()}
                  </span>
                </div>
              )}
            </div>
          ))}
        </>
      )}

      {localModels.length === 0 && (
        <div className="system-stats-empty">
          <p>No models installed yet.</p>
          <p className="system-stats-empty-hint">
            Go to the Models tab to download your first model.
          </p>
        </div>
      )}
    </div>
  );
}
