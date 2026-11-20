import { useEffect, useState } from "react";
import { useMachinesStore } from "../../stores/machinesStore.js";
import GpuStats from "./GpuStats.jsx";
import "./MachinesPanel.css";

const SERVICES = [
  ["llama", "Chat (llama router)"],
  ["sd", "Images (sd-server)"],
  ["fetch", "Downloads & GPU stats (sd-fetch)"],
];

function ago(ts, now) {
  if (!ts) return "";
  const s = Math.max(0, Math.round((now - ts) / 1000));
  return s < 2 ? "just now" : `${s}s ago`;
}

function ServiceRow({ label, svc }) {
  const state = !svc ? "unknown" : svc.ok === true ? "up" : svc.ok === false ? "down" : "off";
  const text = { up: "up", down: "down", off: "not set up", unknown: "checking…" }[state];
  return (
    <div className="machine-svc" title={svc?.error || ""}>
      <span className={`machine-svc-dot is-${state}`} />
      <span className="machine-svc-label">{label}</span>
      <span className={`machine-svc-state is-${state}`}>{text}</span>
      {svc?.error && state !== "up" && <span className="machine-svc-error">{svc.error}</span>}
    </div>
  );
}

/** Machine switch + one card per machine (status, live GPU). Lives on the System page. */
export default function MachinesPanel() {
  const { machines, selected, effective, switching, error, loaded, select } = useMachinesStore();
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  if (!loaded) {
    return <div className="machines-panel machines-loading">{error ? `Machine status unavailable: ${error}` : "Checking machines…"}</div>;
  }

  return (
    <section className="machines-panel">
      <div className="machines-head">
        <div>
          <h3 className="system-stats-section-title">Compute machine</h3>
          <p className="machines-hint">
            Chat and image generation run on the selected machine. Jellyfin is the default, and the
            Workstation is used only while you select it here. Switching never loads or unloads a model.
          </p>
        </div>
        <div className="machine-switch" role="radiogroup" aria-label="Machine for chat and images">
          {machines.map((m) => (
            <button
              key={m.id}
              role="radio"
              aria-checked={selected === m.id}
              className={`machine-switch-opt ${selected === m.id ? "active" : ""}`}
              disabled={!!switching}
              onClick={() => selected !== m.id && select(m.id)}
            >
              <span className={`machine-dot ${m.status ? (m.status.online ? "is-up" : "is-down") : ""}`} />
              {m.name}
              {m.isDefault && <span className="machine-tag">default</span>}
              {switching === m.id && <span className="machine-tag">switching…</span>}
            </button>
          ))}
        </div>
      </div>
      {error && <p className="machines-error">{error}</p>}

      <div className="machines-grid">
        {machines.map((m) => {
          const usedFor = [effective.chat === m.id && "chat", effective.image === m.id && "images"].filter(Boolean);
          return (
            <div key={m.id} className={`machine-card ${selected === m.id ? "is-selected" : ""}`}>
              <div className="machine-card-head">
                <span className={`machine-dot ${m.status ? (m.status.online ? "is-up" : "is-down") : ""}`} />
                <span className="machine-card-name">{m.name}</span>
                <span className={`machine-online ${m.status?.online ? "is-up" : "is-down"}`}>
                  {!m.status ? "checking…" : m.status.online ? "online" : "offline"}
                </span>
                {usedFor.length > 0 && <span className="machine-tag is-active">in use: {usedFor.join(" + ")}</span>}
                <span className="machine-card-gpu">{m.gpuLabel}</span>
              </div>
              <div className="machine-svcs">
                {SERVICES.map(([key, label]) => (
                  <ServiceRow key={key} label={label} svc={m.status?.[key]} />
                ))}
              </div>
              <GpuStats machineId={m.id} />
              <div className="machine-checked">checked {ago(m.status?.checkedAt, now)}</div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
