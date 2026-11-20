import Button from "../shared/Button.jsx";
import "./MachineColumns.css";

/** Grid of per-machine columns on the Models page. */
export function MachineColumns({ children }) {
  return <div className="mcol-grid">{children}</div>;
}

/**
 * One machine's column. The selected machine gets every control; the others
 * only install and delete (loading would use a GPU that isn't selected).
 */
export function MachineColumn({ machine, selected, count, children }) {
  return (
    <div className={`mcol ${selected ? "is-selected" : ""}`}>
      <div className="mcol-head">
        <span className={`mcol-dot ${machine.status ? (machine.status.online ? "is-up" : "is-down") : ""}`} />
        <span className="mcol-name">{machine.name}</span>
        {count != null && <span className="image-models-count">{count}</span>}
        {selected ? (
          <span className="mcol-tag is-selected">selected</span>
        ) : (
          <span className="mcol-tag" title="Select this machine on the System page to load, unload or set up its models">
            install &amp; delete only
          </span>
        )}
        <span className="mcol-gpu">{machine.gpuLabel}</span>
      </div>
      {children}
    </div>
  );
}

/**
 * Install button for one machine on a search result. `many`: more than one
 * machine, so each button names its machine.
 */
export function InstallOn({ machine, many, installed, active, progress, failed, disabled, title, variant, onInstall }) {
  const where = many ? ` on ${machine.name}` : "";
  if (installed && !active) return <span className="tmm-installed">Installed{where}</span>;
  if (active) return progress || <span className="tmm-installed">Downloading{where}…</span>;
  return (
    <Button variant={variant || "primary"} className="btn-sm" disabled={disabled} title={title} onClick={onInstall}>
      {failed ? `Retry${where}` : `Install${where}`}
    </Button>
  );
}
