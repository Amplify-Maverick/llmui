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

/** Sum of known sizes and how many items had none. */
function total(items, sizeOf) {
  let bytes = 0;
  let unknown = 0;
  for (const it of items || []) {
    const b = sizeOf(it);
    if (b > 0) bytes += b;
    else unknown++;
  }
  return { bytes, unknown };
}

/** "Models use X (text · image) · Y free of Z", always shown on an online machine's card. */
function Storage({ text, image, disk }) {
  const t = text?.items ? total(text.items, (m) => m.diskSize) : null;
  const i = image?.items ? total(image.items, (f) => f.size) : null;
  const unknown = (t?.unknown || 0) + (i?.unknown || 0);
  const pct = disk?.total > 0 ? Math.round(((disk.total - disk.free) / disk.total) * 100) : null;
  return (
    <div className="mm-storage">
      <div className="mm-storage-line">
        <span className="mm-storage-label">Models</span>
        {!text || !image ? (
          <span className="mm-note">measuring…</span>
        ) : (
          <span>
            <strong>{formatBytes((t?.bytes || 0) + (i?.bytes || 0))}</strong>
            <span className="mm-storage-split">
              {" "}(text {t ? formatBytes(t.bytes) : "?"} · image {i ? formatBytes(i.bytes) : "?"})
            </span>
            {unknown > 0 && <span className="mm-note"> + {unknown} of unknown size</span>}
          </span>
        )}
      </div>
      <div
        className="mm-storage-line"
        title={disk ? `Disk holding the model folder, as reported by sd-fetch. Downloads keep ${formatBytes(disk.reserve)} free.` : ""}
      >
        <span className="mm-storage-label">Free</span>
        {disk ? (
          <span>
            <strong>{formatBytes(disk.free)}</strong> of {formatBytes(disk.total)}
          </span>
        ) : (
          <span className="mm-note">{image ? "unknown (download helper unavailable)" : "checking…"}</span>
        )}
      </div>
      {pct != null && (
        <div className="mm-storage-bar" role="img" aria-label={`Disk ${pct}% used`}>
          <span style={{ width: `${pct}%` }} className={pct >= 90 ? "is-full" : ""} />
        </div>
      )}
    </div>
  );
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
  const [disk, setDisk] = useState(null); // sd-fetch's { free, total, reserve } of the model disk
  const online = machine.status?.online;
  const seq = useRef(0);

  const load = useCallback(async () => {
    const n = ++seq.current; // earlier listings stay shown until this one arrives
    const [t, i] = await Promise.all([
      settle(async () => (await llamaApi.list(machine.id)).models),
      settle(async () => {
        const data = await imageApi.models(machine.id);
        if (data.helper?.disk) setDisk(data.helper.disk);
        if (data.sdError && !data.files?.length) throw new Error(data.sdError);
        return data.files || [];
      }),
    ]);
    if (n !== seq.current) return; // closed or reloaded meanwhile
    setText(t);
    setImage(i);
  }, [machine.id]);

  // Listed once the machine is online (for the storage line), again when opened.
  useEffect(() => {
    if (online) load();
    return () => {
      seq.current++;
    };
  }, [open, online, load]);

  return (
    <div className="mm">
      {online && <Storage text={text} image={image} disk={disk} />}
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
