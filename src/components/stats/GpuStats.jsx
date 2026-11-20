import { useGpuStats, fmt, vramPct } from "../../hooks/useGpuStats.js";
import { tempColor, utilizationColor, vramColor } from "../../utils/gpuColors.js";
import "./GpuStats.css";

const muted = "var(--color-text-muted)";

function Metric({ label, value, color, pct, sub }) {
  return (
    <div className="gpu-metric-box">
      <div className="gpu-metric-label">{label}</div>
      <div className="gpu-metric-value" style={{ color: value === "—" ? muted : color }}>{value}</div>
      <div className="gpu-bar-track">
        <div className="gpu-bar-fill" style={{ width: `${Math.min(pct ?? 0, 100)}%`, background: color }} />
      </div>
      {sub && <div className="gpu-subtext">{sub}</div>}
    </div>
  );
}

/** Live GPU stats of one machine (from its sd-fetch helper), polled every 2 s while visible. */
export default function GpuStats({ machineId }) {
  const { gpus, error, loading, timestamp } = useGpuStats(machineId);

  if (loading && gpus.length === 0) return <div className="gpu-error">Reading GPU…</div>;
  if (gpus.length === 0) {
    return (
      <div className="gpu-error">
        <p>GPU stats unavailable</p>
        {error && <p className="gpu-error-detail">{error}</p>}
      </div>
    );
  }

  return (
    <div>
      {gpus.map((gpu) => {
        const pct = vramPct(gpu);
        const asleep = gpu.state === "asleep";
        const vramMetric = (
          <Metric
            label="VRAM"
            value={fmt(pct, "%")}
            color={vramColor(pct ?? 0)}
            pct={pct}
            sub={`${fmt(gpu.memoryUsed)} / ${fmt(gpu.memoryTotal)} MiB`}
          />
        );
        return (
          <div key={gpu.index} className="gpu-card">
            <div className="gpu-name">
              <span className={asleep ? "gpu-live-dot gpu-live-dot-asleep" : "gpu-live-dot"} title={asleep ? "Asleep" : "Live"} />
              {gpu.name || `GPU ${gpu.index}`}
              {timestamp && <span className="gpu-timestamp">{new Date(timestamp).toLocaleTimeString()}</span>}
            </div>
            {asleep ? (
              <div className="gpu-metrics-grid">
                <div className="gpu-metric-box gpu-asleep" title="The card has runtime-suspended; its sensors aren't read so polling doesn't wake it.">
                  <div className="gpu-metric-label">Status</div>
                  <div className="gpu-asleep-text">Asleep (idle, powered down)</div>
                </div>
                {vramMetric}
              </div>
            ) : (
              <div className="gpu-metrics-grid">
                <Metric
                  label="Utilization"
                  value={fmt(gpu.utilization, "%")}
                  color={utilizationColor(gpu.utilization ?? 0)}
                  pct={gpu.utilization}
                />
                {vramMetric}
                <Metric
                  label="Temperature"
                  value={fmt(gpu.temperature, "°C")}
                  color={tempColor(gpu.temperature ?? 0)}
                  pct={gpu.temperature}
                />
                <Metric label="Power" value={fmt(gpu.powerDraw, " W")} color="#c4b5fd" pct={null} />
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
