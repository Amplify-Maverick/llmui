import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { formatBytes } from "../../utils/formatters.js";
import { fetchHardwareInfo } from "../../services/hardwareApi.js";
import StatCard from "./StatCard.jsx";
import GpuStats from "./GpuStats.jsx";
import "./SystemStats.css";

export default function SystemStats() {
  const { models, modelsLoaded, fetchModels } = useModelsStore();
  const [hardware, setHardware] = useState(null);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    fetchHardwareInfo().then((data) => {
      if (data.ok) setHardware(data);
    });
  }, []);

  // llama.cpp reports model file size in /v1/models meta; other servers may not.
  const totalSize = models.reduce((acc, m) => acc + (m.size || 0), 0);

  return (
    <div className="system-stats">
      <h2 className="system-stats-title">System Overview</h2>

      <div className="system-stats-grid">
        <StatCard
          label="Served Models"
          value={models.length}
          color="#6ee7b7"
        />
        {totalSize > 0 && (
          <StatCard
            label="Model Size"
            value={formatBytes(totalSize)}
            color="#60a5fa"
          />
        )}
        {hardware && (
          <>
            <StatCard
              label="System RAM"
              value={`${hardware.ram.totalGb} GB`}
              color="#c4b5fd"
            />
            <StatCard
              label="Available RAM"
              value={`${hardware.ram.availableGb} GB`}
              color="#a78bfa"
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

      {modelsLoaded && models.length === 0 && (
        <div className="system-stats-empty">
          <p>No models are being served.</p>
          <p className="system-stats-empty-hint">
            Load a model on the OpenAI-compatible server (OPENAI_BASE_URL).
          </p>
        </div>
      )}
    </div>
  );
}
