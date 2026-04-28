import { useEffect, useState } from "react";
import { fetchGpuStats } from "../../services/gpuApi.js";
import { tempColor, utilizationColor, vramColor } from "../../utils/gpuColors.js";
import "./GpuMini.css";

const POLL_INTERVAL = 2000;

export default function GpuMini() {
  const [gpus, setGpus] = useState([]);
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    const poll = async () => {
      const data = await fetchGpuStats();
      if (!active) return;
      if (data.ok) {
        setGpus(data.gpus);
        setError(null);
      } else {
        setError(data.error);
      }
    };
    poll();
    const id = setInterval(poll, POLL_INTERVAL);
    return () => { active = false; clearInterval(id); };
  }, []);

  if (error) {
    return <div className="gpu-mini-error">GPU unavailable</div>;
  }

  if (gpus.length === 0) {
    return <div className="gpu-mini-error">Detecting GPU…</div>;
  }

  return (
    <>
      {gpus.map((gpu) => {
        const vramPct = (gpu.memoryUsed / gpu.memoryTotal) * 100;
        return (
          <div key={gpu.index} className="gpu-mini">
            <span className="gpu-mini-label">
              <span className="gpu-mini-live" />
              {gpu.name}
            </span>

            <span className="gpu-mini-separator">│</span>

            {/* Utilization */}
            <span className="gpu-mini-metric">
              <span className="gpu-mini-metric-label">GPU</span>
              <span style={{ color: utilizationColor(gpu.utilization), fontWeight: 600 }}>
                {gpu.utilization}%
              </span>
              <span className="gpu-mini-bar-track">
                <span className="gpu-mini-bar-fill" style={{ width: `${Math.min(gpu.utilization, 100)}%`, background: utilizationColor(gpu.utilization) }} />
              </span>
            </span>

            <span className="gpu-mini-separator">│</span>

            {/* VRAM */}
            <span className="gpu-mini-metric">
              <span className="gpu-mini-metric-label">VRAM</span>
              <span style={{ color: vramColor(vramPct), fontWeight: 600 }}>
                {gpu.memoryUsed.toLocaleString()}/{gpu.memoryTotal.toLocaleString()} MiB
              </span>
              <span className="gpu-mini-bar-track">
                <span className="gpu-mini-bar-fill" style={{ width: `${Math.min(vramPct, 100)}%`, background: vramColor(vramPct) }} />
              </span>
            </span>

            <span className="gpu-mini-separator">│</span>

            {/* Temperature */}
            <span className="gpu-mini-metric">
              <span className="gpu-mini-metric-label">Temp</span>
              <span style={{ color: tempColor(gpu.temperature), fontWeight: 600 }}>
                {gpu.temperature}°C
              </span>
            </span>

            <span className="gpu-mini-separator">│</span>

            {/* Power */}
            <span className="gpu-mini-metric">
              <span className="gpu-mini-metric-label">Power</span>
              <span style={{ color: "#c4b5fd", fontWeight: 600 }}>
                {gpu.powerDraw.toFixed(0)}W
              </span>
            </span>
          </div>
        );
      })}
    </>
  );
}
