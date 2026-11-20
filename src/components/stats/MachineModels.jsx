import { useCallback, useEffect, useRef, useState } from "react";
import { llamaApi } from "../../services/llamaApi.js";
import { imageApi } from "../../services/imageApi.js";
import { modelStatusLabel } from "../../stores/modelsStore.js";
import { formatBytes } from "../../utils/formatters.js";

const ACTIVE_TEXT = new Set(["loaded", "loading", "sleeping"]);

/** Fetch one listing; resolves to { items } or { error }. */
async function settle(fn) {
  try {
    return { items: await fn() };
  } catch (err) {
    return { error: err.message };
  }
}

function Size({ bytes }) {
  return <span className="mm-size">{bytes ? formatBytes(bytes) : "size unknown"}</span>;
}

function Section({ title, result, empty, children }) {
  return (
    <div className="mm-section">
      <div className="mm-section-title">{title}</div>
      {!result ? (
        <p className="mm-note">Loading…</p>
      ) : result.error ? (
        <p className="mm-note is-error">Couldn't list them: {result.error}</p>
      ) : result.items.length === 0 ? (
        <p className="mm-note">{empty}</p>
      ) : (
        <ul className="mm-list">{children}</ul>
      )}
    </div>
  );
}

/**
 * "Show installed models" for one machine card on the System page. Read-only:
 * the same listings the Models page uses, asked for this machine by id. Fetched
 * when opened (and when the machine comes back online while open); no polling.
 */
export default function MachineModels({ machine, managed, onOpenModels }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState(null); // { items } | { error } | null while loading
  const [image, setImage] = useState(null);
  const online = machine.status?.online;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current;
    setText(null);
    setImage(null);
    const [t, i] = await Promise.all([
      settle(async () => (await llamaApi.list(machine.id)).models),
      settle(async () => {
        const data = await imageApi.models(machine.id);
        if (data.sdError && !data.files?.length) throw new Error(data.sdError);
        return data.files || [];
      }),
    ]);
    if (n !== seq.current) return; // closed or reloaded meanwhile
    setText(t);
    setImage(i);
  }, [machine.id]);

  useEffect(() => {
    if (open && online) load();
    return () => {
      seq.current++;
    };
  }, [open, online, load]);

  return (
    <div className="mm">
      <button className="mm-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className={`mm-caret ${open ? "is-open" : ""}`} aria-hidden="true">▸</span>
        {open ? "Hide installed models" : "Show installed models"}
      </button>
      {open && (
        <div className="mm-body">
          {online === false ? (
            <p className="mm-note">{machine.name} is offline, so its models can't be listed.</p>
          ) : online == null ? (
            <p className="mm-note">Checking whether {machine.name} is online…</p>
          ) : (
            <>
              <Section title="Text (llama.cpp)" result={text} empty="No text models installed.">
                {text?.items?.map((m) => {
                  const active = ACTIVE_TEXT.has(m.status) && !m.failed;
                  return (
                    <li key={m.id} className="mm-row">
                      <span className="mm-name" title={m.id}>{m.id}</span>
                      {active ? (
                        <span className="mm-badge is-loaded">{modelStatusLabel(m)}</span>
                      ) : (
                        m.failed && <span className="mm-badge is-error">{modelStatusLabel(m)}</span>
                      )}
                      <Size bytes={m.diskSize} />
                    </li>
                  );
                })}
              </Section>
              <Section title="Image (sd-server)" result={image} empty="No image models installed.">
                {image?.items?.map((f) => (
                  <li key={f.path || f.id} className="mm-row">
                    <span className="mm-name" title={f.path || f.id}>
                      {f.name || f.id}
                      {f.kind === "component" && <span className="mm-kind">{f.category}</span>}
                    </span>
                    {f.loaded && <span className="mm-badge is-loaded">loaded</span>}
                    <Size bytes={f.size} />
                  </li>
                ))}
              </Section>
            </>
          )}
          {onOpenModels && (
            <p className="mm-foot">
              <button className="mm-link" onClick={onOpenModels}>
                Manage models on the Models page →
              </button>
              {!managed && <span className="mm-note"> It acts on the selected machine; select {machine.name} above first.</span>}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
