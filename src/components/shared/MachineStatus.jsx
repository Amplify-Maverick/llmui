import { useMachinesStore, fallbackNotice } from "../../stores/machinesStore.js";
import "../stats/MachinesPanel.css";

/** App-wide banner while the selected machine is down and requests go to the default one. */
export function MachineNotice({ onOpenSystem }) {
  const state = useMachinesStore();
  const text = fallbackNotice(state);
  if (!text) return null;
  const reason = (state.fallback.chat || state.fallback.image)?.reason;
  return (
    <div className="machine-notice" role="status">
      <span>⚠ {text}</span>
      {reason && <span className="machine-notice-reason">{reason}</span>}
      {onOpenSystem && <button onClick={onOpenSystem}>System</button>}
    </div>
  );
}

/** Header chip: where chat (and images, if different) run right now. */
export function MachineChip({ onClick }) {
  const { machines, effective, fallback, loaded } = useMachinesStore();
  if (!loaded) return null;
  const m = (id) => machines.find((x) => x.id === id);
  const chat = m(effective.chat);
  const image = m(effective.image);
  const falling = !!(fallback.chat || fallback.image);
  const online = chat?.status?.online;
  const label = !chat ? "" : chat.id === image?.id ? chat.name : `Chat ${chat.name} · Images ${image?.name}`;
  return (
    <button
      className={`machine-chip ${falling ? "is-fallback" : ""}`}
      onClick={onClick}
      title="Machine running chat and images (change it on the System page)"
    >
      <span className={`machine-dot ${chat?.status ? (online ? "is-up" : "is-down") : ""}`} />
      {label}
    </button>
  );
}
