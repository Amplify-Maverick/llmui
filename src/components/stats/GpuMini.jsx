import { useMachinesStore } from "../../stores/machinesStore.js";
import { useGpuStats, fmt, vramPct } from "../../hooks/useGpuStats.js";
import { tempColor, utilizationColor, vramColor } from "../../utils/gpuColors.js";
import "./GpuMini.css";

const muted = "var(--color-text-muted)";

/** One-line live GPU strip for the machine `kind` ("chat" | "image") runs on. */
export default function GpuMini({ kind = "chat" }) {
  const machineId = useMachinesStore((s) => s.effective[kind]);
  const machine = useMachinesStore((s) => s.machines.find((m) => m.id === machineId));
  const { gpus, error, loading } = useGpuStats(machineId);
  const label = machine?.name || "GPU";

  if (!machineId || (loading && gpus.length === 0)) {
    return <div className="gpu-mini-error">Reading {label} GPU…</div>;
  }
  if (gpus.length === 0) {
    return <div className="gpu-mini-error" title={error || ""}>{label}: GPU stats unavailable</div>;
  }

  return (
    <>
      {gpus.map((gpu) => {
        const pct = vramPct(gpu);
        const asleep = gpu.state === "asleep";
        return (
          <div key={gpu.index} className="gpu-mini">
            <span className="gpu-mini-label" title={gpu.name || ""}>
              <span className={asleep ? "gpu-mini-live gpu-mini-live-asleep" : "gpu-mini-live"} />
              {label}
              {gpu.name && <span className="gpu-mini-gpuname">{gpu.name}</span>}
            </span>

            <span className="gpu-mini-separator">│</span>

            {asleep ? (
              <span className="gpu-mini-metric gpu-mini-asleep" title="Runtime-suspended; sensors aren't read so polling doesn't wake it">
                Asleep (idle, powered down)
              </span>
            ) : (
              <>
                <span className="gpu-mini-metric">
                  <span className="gpu-mini-metric-label">GPU</span>
                  <span style={{ color: gpu.utilization == null ? muted : utilizationColor(gpu.utilization), fontWeight: 600 }}>
                    {fmt(gpu.utilization, "%")}
                  </span>
                  <span className="gpu-mini-bar-track">
                    <span className="gpu-mini-bar-fill" style={{ width: `${Math.min(gpu.utilization ?? 0, 100)}%`, background: utilizationColor(gpu.utilization ?? 0) }} />
                  </span>
                </span>
              </>
            )}

            <span className="gpu-mini-separator">│</span>

            <span className="gpu-mini-metric">
              <span className="gpu-mini-metric-label">VRAM</span>
              <span style={{ color: pct == null ? muted : vramColor(pct), fontWeight: 600 }}>
                {fmt(gpu.memoryUsed)}/{fmt(gpu.memoryTotal)} MiB
              </span>
              <span className="gpu-mini-bar-track">
                <span className="gpu-mini-bar-fill" style={{ width: `${Math.min(pct ?? 0, 100)}%`, background: vramColor(pct ?? 0) }} />
              </span>
            </span>

            {!asleep && (
              <>
                <span className="gpu-mini-separator">│</span>

                <span className="gpu-mini-metric">
                  <span className="gpu-mini-metric-label">Temp</span>
                  <span style={{ color: gpu.temperature == null ? muted : tempColor(gpu.temperature), fontWeight: 600 }}>
                    {fmt(gpu.temperature, "°C")}
                  </span>
                </span>

                <span className="gpu-mini-separator">│</span>

                <span className="gpu-mini-metric">
                  <span className="gpu-mini-metric-label">Power</span>
                  <span style={{ color: gpu.powerDraw == null ? muted : "#c4b5fd", fontWeight: 600 }}>
                    {fmt(gpu.powerDraw, "W")}
                  </span>
                </span>
              </>
            )}
          </div>
        );
      })}
    </>
  );
}
