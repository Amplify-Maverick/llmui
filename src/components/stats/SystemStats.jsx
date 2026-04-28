import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { ollamaApi } from "../../services/ollamaApi.js";
import StatCard from "./StatCard.jsx";
import GpuStats from "./GpuStats.jsx";
import { formatBytes } from "../../utils/storage.js";

const containerStyle = {
  padding: "20px",
};

const titleStyle = {
  fontSize: "20px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: "0 0 24px 0",
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
  gap: "16px",
  marginBottom: "32px",
};

const sectionTitleStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: "0 0 16px 0",
};

const runningModelCardStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "12px",
  padding: "16px",
  marginBottom: "12px",
};

const modelNameStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#e8e8f0",
  marginBottom: "8px",
};

const modelDetailStyle = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: "13px",
  color: "#8a8a9a",
  marginBottom: "4px",
};

const emptyStyle = {
  color: "#8a8a9a",
  textAlign: "center",
  padding: "40px",
};

export default function SystemStats() {
  const { localModels, runningModels, fetchModels, fetchRunningModels } = useModelsStore();
  const { ollamaBaseUrl } = useSettingsStore();
  const [isConnected, setIsConnected] = useState(false);

  useEffect(() => {
    const checkConnection = async () => {
      ollamaApi.setBaseUrl(ollamaBaseUrl);
      const connected = await ollamaApi.checkConnection();
      setIsConnected(connected);
    };

    checkConnection();
    fetchModels();
    fetchRunningModels();

    // Auto-refresh every 5 seconds
    const interval = setInterval(() => {
      checkConnection();
      fetchRunningModels();
    }, 5000);

    return () => clearInterval(interval);
  }, [ollamaBaseUrl, fetchModels, fetchRunningModels]);

  const totalSize = localModels.reduce((sum, m) => sum + (m.size || 0), 0);
  const totalVram = runningModels.reduce((sum, m) => sum + (m.size_vram || 0), 0);

  return (
    <div style={containerStyle}>
      <h2 style={titleStyle}>System Status</h2>

      <div style={gridStyle}>
        <StatCard
          label="Server Status"
          value={isConnected ? "Online" : "Offline"}
          color={isConnected ? "#6ee7b7" : "#ff6b6b"}
        />
        <StatCard
          label="Local Models"
          value={localModels.length}
          color="#60a5fa"
        />
        <StatCard
          label="Running Models"
          value={runningModels.length}
          color="#fcd34d"
        />
        <StatCard
          label="Total Model Size"
          value={formatBytes(totalSize)}
          color="#c4b5fd"
        />
      </div>

      <GpuStats />

      <div style={{ marginTop: "24px" }}>
        <h3 style={sectionTitleStyle}>Running Models</h3>
      </div>

      {runningModels.length === 0 ? (
        <div style={emptyStyle}>
          <p>No models currently running.</p>
          <p style={{ fontSize: "13px", marginTop: "8px" }}>
            Models are loaded when you send a message.
          </p>
        </div>
      ) : (
        runningModels.map((model) => (
          <div key={model.name} style={runningModelCardStyle}>
            <div style={modelNameStyle}>{model.name}</div>
            <div style={modelDetailStyle}>
              <span>VRAM Usage</span>
              <span>{formatBytes(model.size_vram)}</span>
            </div>
            <div style={modelDetailStyle}>
              <span>Total Size</span>
              <span>{formatBytes(model.size)}</span>
            </div>
            {model.details?.family && (
              <div style={modelDetailStyle}>
                <span>Family</span>
                <span>{model.details.family}</span>
              </div>
            )}
            {model.expires_at && (
              <div style={modelDetailStyle}>
                <span>Expires</span>
                <span>{new Date(model.expires_at).toLocaleTimeString()}</span>
              </div>
            )}
          </div>
        ))
      )}

      <div style={{ marginTop: "24px" }}>
        <h3 style={sectionTitleStyle}>Connection Info</h3>
        <div style={runningModelCardStyle}>
          <div style={modelDetailStyle}>
            <span>Ollama URL</span>
            <span style={{ fontFamily: "'DM Mono', monospace" }}>{ollamaBaseUrl}</span>
          </div>
          {totalVram > 0 && (
            <div style={modelDetailStyle}>
              <span>Total VRAM in Use</span>
              <span>{formatBytes(totalVram)}</span>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
