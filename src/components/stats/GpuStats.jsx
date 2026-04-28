import { useEffect, useState } from "react";
import { fetchGpuStats } from "../../services/gpuApi.js";
import { tempColor, utilizationColor, vramColor } from "../../utils/gpuColors.js";
import "./GpuStats.css";

const POLL_INTERVAL = 2000;

export default function GpuStats() {
  const [gpus, setGpus] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);

  useEffect(() => {
    let active = true;

    const poll = async () => {
      const data = await fetchGpuStats();
      if (!active) return;
      if (data.ok) {
        setGpus(data.gpus);
        setLastUpdate(data.timestamp);
        setError(null);
      } else {
        setError(data.error);
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => {
      active = false;
      clearInterval(id);
    };
  }, []);

  if (error) {
    return (
      <div>
        <h3 className="gpu-section-title">GPU</h3>
        <div className="gpu-error">
          <p>GPU monitoring unavailable</p>
          <p className="gpu-error-detail">{error}</p>
        </div>
      </div>
    );
  }

  if (gpus.length === 0) {
    return (
      <div>
        <h3 className="gpu-section-title">GPU</h3>
        <div className="gpu-error">Detecting GPU…</div>
      </div>
    );
  }

  return (
    <div>
      <h3 className="gpu-section-title">
        GPU Monitor
        <span className="gpu-live-dot" title="Live" />
        {lastUpdate && (
          <span className="gpu-timestamp">
            updated {new Date(lastUpdate).toLocaleTimeString()}
          </span>
        )}
      </h3>

      {gpus.map((gpu) => {
        const vramPct = (gpu.memoryUsed / gpu.memoryTotal) * 100;
        const powerPct = gpu.powerLimit > 0 ? (gpu.powerDraw / gpu.powerLimit) * 100 : 0;

        return (
          <div key={gpu.index} className="gpu-card">
            <div className="gpu-name">
              <span className="gpu-name-index">GPU {gpu.index}</span>
              <span className="gpu-name-separator">—</span>
              {gpu.name}
            </div>

            <div className="gpu-metrics-grid">
              {/* Utilization */}
              <div className="gpu-metric-box">
                <div className="gpu-metric-label">Utilization</div>
                <div className="gpu-metric-value" style={{ color: utilizationColor(gpu.utilization) }}>
                  {gpu.utilization}%
                </div>
                <div className="gpu-bar-track">
                  <div className="gpu-bar-fill" style={{ width: `${Math.min(gpu.utilization, 100)}%`, background: utilizationColor(gpu.utilization) }} />
                </div>
              </div>

              {/* VRAM */}
              <div className="gpu-metric-box">
                <div className="gpu-metric-label">VRAM Usage</div>
                <div className="gpu-metric-value" style={{ color: vramColor(vramPct) }}>
                  {vramPct.toFixed(0)}%
                </div>
                <div className="gpu-bar-track">
                  <div className="gpu-bar-fill" style={{ width: `${Math.min(vramPct, 100)}%`, background: vramColor(vramPct) }} />
                </div>
                <div className="gpu-subtext">
                  {gpu.memoryUsed.toLocaleString()} / {gpu.memoryTotal.toLocaleString()} MiB
                </div>
              </div>

              {/* Temperature */}
              <div className="gpu-metric-box">
                <div className="gpu-metric-label">Temperature</div>
                <div className="gpu-metric-value" style={{ color: tempColor(gpu.temperature) }}>
                  {gpu.temperature}°C
                </div>
                <div className="gpu-bar-track">
                  <div className="gpu-bar-fill" style={{ width: `${Math.min(gpu.temperature, 100)}%`, background: tempColor(gpu.temperature) }} />
                </div>
              </div>

              {/* Power */}
              <div className="gpu-metric-box">
                <div className="gpu-metric-label">Power</div>
                <div className="gpu-metric-value" style={{ color: "#c4b5fd" }}>
                  {gpu.powerDraw.toFixed(0)}W
                </div>
                <div className="gpu-bar-track">
                  <div className="gpu-bar-fill" style={{ width: `${Math.min(powerPct, 100)}%`, background: "#c4b5fd" }} />
                </div>
                <div className="gpu-subtext">limit {gpu.powerLimit.toFixed(0)}W</div>
              </div>

              {/* Fan Speed */}
              <div className="gpu-metric-box">
                <div className="gpu-metric-label">Fan Speed</div>
                <div className="gpu-metric-value" style={{ color: "#8a8a9a" }}>
                  {gpu.fanSpeed}%
                </div>
                <div className="gpu-bar-track">
                  <div className="gpu-bar-fill" style={{ width: `${Math.min(gpu.fanSpeed, 100)}%`, background: "#8a8a9a" }} />
                </div>
              </div>

              {/* Clocks */}
              <div className="gpu-metric-box">
                <div className="gpu-metric-label">Clocks</div>
                <div className="gpu-metric-value" style={{ color: "#60a5fa", fontSize: "18px" }}>
                  {gpu.clockGraphics} MHz
                </div>
                <div className="gpu-subtext">mem {gpu.clockMemory} MHz</div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
