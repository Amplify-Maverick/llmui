import { useEffect, useState, useRef } from "react";
import { fetchGpuStats } from "../../services/gpuApi.js";

const POLL_INTERVAL = 2000;

// ── Styles ──────────────────────────────────────────────────

const containerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "12px",
  padding: "6px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  background: "rgba(255,255,255,0.02)",
  fontSize: "12px",
  fontFamily: "'DM Mono', monospace",
  color: "#8a8a9a",
  overflowX: "auto",
};

const gpuLabelStyle = {
  color: "#60a5fa",
  fontWeight: "600",
  fontSize: "11px",
  whiteSpace: "nowrap",
  display: "flex",
  alignItems: "center",
  gap: "5px",
};

const metricStyle = {
  display: "flex",
  alignItems: "center",
  gap: "6px",
  whiteSpace: "nowrap",
};

const miniBarTrackStyle = {
  width: "48px",
  height: "4px",
  background: "rgba(255,255,255,0.06)",
  borderRadius: "2px",
  overflow: "hidden",
  flexShrink: 0,
};

const miniBarFillStyle = (pct, color) => ({
  height: "100%",
  width: `${Math.min(pct, 100)}%`,
  background: color,
  borderRadius: "2px",
  transition: "width 0.6s ease",
});

const liveStyle = {
  width: "5px",
  height: "5px",
  borderRadius: "50%",
  background: "#6ee7b7",
  animation: "gpuPulse 2s ease-in-out infinite",
  flexShrink: 0,
};

const errorStyle = {
  padding: "6px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  background: "rgba(255,255,255,0.02)",
  fontSize: "11px",
  color: "#6a6a7a",
  textAlign: "center",
};

// ── Helpers ─────────────────────────────────────────────────

function tempColor(t) {
  if (t < 50) return "#6ee7b7";
  if (t < 70) return "#fcd34d";
  if (t < 85) return "#fb923c";
  return "#ff6b6b";
}

function utilizationColor(p) {
  if (p < 30) return "#6ee7b7";
  if (p < 70) return "#60a5fa";
  if (p < 90) return "#fcd34d";
  return "#fb923c";
}

function vramColor(p) {
  if (p < 50) return "#60a5fa";
  if (p < 80) return "#fcd34d";
  return "#fb923c";
}

// ── Component ───────────────────────────────────────────────

export default function GpuMini() {
  const [gpus, setGpus] = useState([]);
  const [error, setError] = useState(null);
  const styleInjected = useRef(false);

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
    return <div style={errorStyle}>GPU unavailable</div>;
  }

  if (gpus.length === 0) {
    return <div style={errorStyle}>Detecting GPU…</div>;
  }

  return (
    <>
      {gpus.map((gpu) => {
        const vramPct = (gpu.memoryUsed / gpu.memoryTotal) * 100;
        return (
          <div key={gpu.index} style={containerStyle}>
            <span style={gpuLabelStyle}>
              <span style={liveStyle} />
              {gpu.name}
            </span>

            <span style={{ color: "rgba(255,255,255,0.1)" }}>│</span>

            {/* Utilization */}
            <span style={metricStyle}>
              <span style={{ color: "#6a6a7a" }}>GPU</span>
              <span style={{ color: utilizationColor(gpu.utilization), fontWeight: 600 }}>
                {gpu.utilization}%
              </span>
              <span style={miniBarTrackStyle}>
                <span style={miniBarFillStyle(gpu.utilization, utilizationColor(gpu.utilization))} />
              </span>
            </span>

            <span style={{ color: "rgba(255,255,255,0.1)" }}>│</span>

            {/* VRAM */}
            <span style={metricStyle}>
              <span style={{ color: "#6a6a7a" }}>VRAM</span>
              <span style={{ color: vramColor(vramPct), fontWeight: 600 }}>
                {gpu.memoryUsed.toLocaleString()}/{gpu.memoryTotal.toLocaleString()} MiB
              </span>
              <span style={miniBarTrackStyle}>
                <span style={miniBarFillStyle(vramPct, vramColor(vramPct))} />
              </span>
            </span>

            <span style={{ color: "rgba(255,255,255,0.1)" }}>│</span>

            {/* Temperature */}
            <span style={metricStyle}>
              <span style={{ color: "#6a6a7a" }}>Temp</span>
              <span style={{ color: tempColor(gpu.temperature), fontWeight: 600 }}>
                {gpu.temperature}°C
              </span>
            </span>

            <span style={{ color: "rgba(255,255,255,0.1)" }}>│</span>

            {/* Power */}
            <span style={metricStyle}>
              <span style={{ color: "#6a6a7a" }}>Power</span>
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
