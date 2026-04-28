import { useEffect, useState, useRef } from "react";
import { fetchGpuStats } from "../../services/gpuApi.js";

const POLL_INTERVAL = 2000; // 2 seconds

// ── Styles ──────────────────────────────────────────────────

const sectionTitleStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: "0 0 16px 0",
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const gpuCardStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "12px",
  padding: "20px",
  marginBottom: "16px",
};

const gpuNameStyle = {
  fontSize: "15px",
  fontWeight: "600",
  color: "#e8e8f0",
  marginBottom: "16px",
  display: "flex",
  alignItems: "center",
  gap: "8px",
};

const metricsGridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
  gap: "12px",
};

const metricBoxStyle = {
  background: "rgba(255,255,255,0.02)",
  borderRadius: "8px",
  padding: "12px",
};

const metricLabelStyle = {
  fontSize: "11px",
  color: "#8a8a9a",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginBottom: "6px",
};

const metricValueStyle = {
  fontSize: "22px",
  fontWeight: "700",
  fontFamily: "'DM Mono', monospace",
  marginBottom: "6px",
};

const barTrackStyle = {
  height: "4px",
  background: "rgba(255,255,255,0.06)",
  borderRadius: "2px",
  overflow: "hidden",
};

const barFillStyle = (pct, color) => ({
  height: "100%",
  width: `${Math.min(pct, 100)}%`,
  background: color,
  borderRadius: "2px",
  transition: "width 0.6s ease",
});

const subtextStyle = {
  fontSize: "11px",
  color: "#6a6a7a",
  marginTop: "4px",
  fontFamily: "'DM Mono', monospace",
};

const errorStyle = {
  color: "#8a8a9a",
  textAlign: "center",
  padding: "24px",
  fontSize: "13px",
};

const liveIndicatorStyle = {
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  background: "#6ee7b7",
  display: "inline-block",
  animation: "gpuPulse 2s ease-in-out infinite",
};

// ── Helpers ─────────────────────────────────────────────────

function tempColor(temp) {
  if (temp < 50) return "#6ee7b7";
  if (temp < 70) return "#fcd34d";
  if (temp < 85) return "#fb923c";
  return "#ff6b6b";
}

function utilizationColor(pct) {
  if (pct < 30) return "#6ee7b7";
  if (pct < 70) return "#60a5fa";
  if (pct < 90) return "#fcd34d";
  return "#fb923c";
}

function vramColor(pct) {
  if (pct < 50) return "#60a5fa";
  if (pct < 80) return "#fcd34d";
  return "#fb923c";
}

// ── Component ───────────────────────────────────────────────

export default function GpuStats() {
  const [gpus, setGpus] = useState([]);
  const [error, setError] = useState(null);
  const [lastUpdate, setLastUpdate] = useState(null);
  const styleInjected = useRef(false);

  // Inject keyframe animation once
  useEffect(() => {
    if (styleInjected.current) return;
    styleInjected.current = true;
    const style = document.createElement("style");
    style.textContent = `
      @keyframes gpuPulse {
        0%, 100% { opacity: 1; }
        50% { opacity: 0.3; }
      }
    `;
    document.head.appendChild(style);
    return () => {
      document.head.removeChild(style);
      styleInjected.current = false;
    };
  }, []);

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
        <h3 style={sectionTitleStyle}>GPU</h3>
        <div style={errorStyle}>
          <p>GPU monitoring unavailable</p>
          <p style={{ marginTop: "4px", fontSize: "12px" }}>{error}</p>
        </div>
      </div>
    );
  }

  if (gpus.length === 0) {
    return (
      <div>
        <h3 style={sectionTitleStyle}>GPU</h3>
        <div style={errorStyle}>Detecting GPU…</div>
      </div>
    );
  }

  return (
    <div>
      <h3 style={sectionTitleStyle}>
        GPU Monitor
        <span style={liveIndicatorStyle} title="Live" />
        {lastUpdate && (
          <span style={{ fontSize: "11px", color: "#6a6a7a", marginLeft: "auto", fontFamily: "'DM Mono', monospace" }}>
            updated {new Date(lastUpdate).toLocaleTimeString()}
          </span>
        )}
      </h3>

      {gpus.map((gpu) => {
        const vramPct = (gpu.memoryUsed / gpu.memoryTotal) * 100;
        const powerPct = gpu.powerLimit > 0 ? (gpu.powerDraw / gpu.powerLimit) * 100 : 0;

        return (
          <div key={gpu.index} style={gpuCardStyle}>
            <div style={gpuNameStyle}>
              <span style={{ color: "#60a5fa" }}>GPU {gpu.index}</span>
              <span style={{ color: "#8a8a9a", fontWeight: 400 }}>—</span>
              {gpu.name}
            </div>

            <div style={metricsGridStyle}>
              {/* Utilization */}
              <div style={metricBoxStyle}>
                <div style={metricLabelStyle}>Utilization</div>
                <div style={{ ...metricValueStyle, color: utilizationColor(gpu.utilization) }}>
                  {gpu.utilization}%
                </div>
                <div style={barTrackStyle}>
                  <div style={barFillStyle(gpu.utilization, utilizationColor(gpu.utilization))} />
                </div>
              </div>

              {/* VRAM */}
              <div style={metricBoxStyle}>
                <div style={metricLabelStyle}>VRAM Usage</div>
                <div style={{ ...metricValueStyle, color: vramColor(vramPct) }}>
                  {vramPct.toFixed(0)}%
                </div>
                <div style={barTrackStyle}>
                  <div style={barFillStyle(vramPct, vramColor(vramPct))} />
                </div>
                <div style={subtextStyle}>
                  {gpu.memoryUsed.toLocaleString()} / {gpu.memoryTotal.toLocaleString()} MiB
                </div>
              </div>

              {/* Temperature */}
              <div style={metricBoxStyle}>
                <div style={metricLabelStyle}>Temperature</div>
                <div style={{ ...metricValueStyle, color: tempColor(gpu.temperature) }}>
                  {gpu.temperature}°C
                </div>
                <div style={barTrackStyle}>
                  <div style={barFillStyle(gpu.temperature, tempColor(gpu.temperature))} />
                </div>
              </div>

              {/* Power */}
              <div style={metricBoxStyle}>
                <div style={metricLabelStyle}>Power</div>
                <div style={{ ...metricValueStyle, color: "#c4b5fd" }}>
                  {gpu.powerDraw.toFixed(0)}W
                </div>
                <div style={barTrackStyle}>
                  <div style={barFillStyle(powerPct, "#c4b5fd")} />
                </div>
                <div style={subtextStyle}>
                  limit {gpu.powerLimit.toFixed(0)}W
                </div>
              </div>

              {/* Fan Speed */}
              <div style={metricBoxStyle}>
                <div style={metricLabelStyle}>Fan Speed</div>
                <div style={{ ...metricValueStyle, color: "#8a8a9a" }}>
                  {gpu.fanSpeed}%
                </div>
                <div style={barTrackStyle}>
                  <div style={barFillStyle(gpu.fanSpeed, "#8a8a9a")} />
                </div>
              </div>

              {/* Clocks */}
              <div style={metricBoxStyle}>
                <div style={metricLabelStyle}>Clocks</div>
                <div style={{ ...metricValueStyle, color: "#60a5fa", fontSize: "18px" }}>
                  {gpu.clockGraphics} MHz
                </div>
                <div style={subtextStyle}>
                  mem {gpu.clockMemory} MHz
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
