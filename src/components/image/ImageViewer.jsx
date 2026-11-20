import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { useImageViewerStore } from "../../stores/imageViewerStore.js";
import { imageApi } from "../../services/imageApi.js";
import { authHeaders } from "../../services/auth.js";
import { formatBytes } from "../../utils/formatters.js";
import "./ImageViewer.css";

const keyOf = (it) => `${it.generationId}/${it.imageId}`;

/**
 * Full-screen preview of a stored generated image: fit-to-screen (click for
 * 100% and pan), prompt with copy, size, file size, machine, model, recipe,
 * settings. Esc / close / click outside closes; arrows or swipe move.
 * Opened through useImageViewerStore; mounted once in App.
 */
export default function ImageViewer() {
  const { items, index, close, go } = useImageViewerStore();
  const item = items[index];
  const isOpen = !!item;

  const blobs = useRef(new Map()); // key → object URL
  const metas = useRef(new Map()); // key → meta | { error }
  const [, bump] = useState(0);
  const rerender = useCallback(() => bump((n) => n + 1), []);

  const [zoom, setZoom] = useState(false);
  const stageRef = useRef(null);
  const imgRef = useRef(null);
  const closeRef = useRef(null);
  const zoomAnchor = useRef(null); // { fx, fy } fraction of the image clicked
  const drag = useRef(null);
  const touch = useRef(null);

  // Fetch image + metadata for the current item and its neighbours. Results
  // that land after the preview closed (a new session) are dropped.
  const session = useRef(0);
  useEffect(() => {
    if (!isOpen) return;
    const sid = session.current;
    for (const it of [items[index], items[index + 1], items[index - 1]].filter(Boolean)) {
      const key = keyOf(it);
      if (!blobs.current.has(key)) {
        blobs.current.set(key, null);
        (async () => {
          let url = "error";
          try {
            const res = await fetch(imageApi.getImageUrl(it.generationId, it.imageId), { headers: await authHeaders() });
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            url = URL.createObjectURL(await res.blob());
          } catch {
            // shown as "Couldn't load this image"
          }
          if (sid !== session.current) {
            if (url !== "error") URL.revokeObjectURL(url);
            return;
          }
          blobs.current.set(key, url);
          rerender();
        })();
      }
      if (!metas.current.has(key)) {
        metas.current.set(key, null);
        imageApi
          .getImageMeta(it.generationId, it.imageId)
          .catch((err) => ({ error: err.message }))
          .then((m) => {
            if (sid !== session.current) return;
            metas.current.set(key, m);
            rerender();
          });
      }
    }
  }, [isOpen, items, index, rerender]);

  // Drop cached images when the preview closes.
  useEffect(() => {
    if (isOpen) return;
    session.current += 1;
    for (const url of blobs.current.values()) if (url && url !== "error") URL.revokeObjectURL(url);
    blobs.current.clear();
    metas.current.clear();
  }, [isOpen]);

  // Back to fit when moving to another image.
  useEffect(() => setZoom(false), [index, items]);

  // Keyboard: Esc, ←, →. Capture phase so the app's own shortcuts don't also fire.
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e) => {
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  }, [isOpen, close, go]);

  // Lock page scroll and move focus into the dialog; give it back on close.
  useEffect(() => {
    if (!isOpen) return;
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.({ preventScroll: true });
    };
  }, [isOpen]);

  // Entering 100%: scroll so the clicked point stays under the pointer (centred).
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const img = imgRef.current;
    if (!zoom || !stage || !img) return;
    const a = zoomAnchor.current || { fx: 0.5, fy: 0.5 };
    stage.scrollLeft = img.offsetLeft + a.fx * img.offsetWidth - stage.clientWidth / 2;
    stage.scrollTop = img.offsetTop + a.fy * img.offsetHeight - stage.clientHeight / 2;
  }, [zoom]);

  if (!isOpen) return null;

  const key = keyOf(item);
  const src = blobs.current.get(key);
  const meta = metas.current.get(key);
  const hasPrev = index > 0;
  const hasNext = index < items.length - 1;

  const onImageClick = (e) => {
    e.stopPropagation();
    if (drag.current?.moved) return; // end of a pan, not a click
    if (!zoom) {
      const r = e.currentTarget.getBoundingClientRect();
      zoomAnchor.current = { fx: (e.clientX - r.left) / r.width, fy: (e.clientY - r.top) / r.height };
    }
    setZoom((z) => !z);
  };

  // Mouse drag pans at 100% (touch scrolls natively).
  const onPointerDown = (e) => {
    if (!zoom || e.pointerType !== "mouse" || e.button !== 0) return;
    const s = stageRef.current;
    drag.current = { x: e.clientX, y: e.clientY, left: s.scrollLeft, top: s.scrollTop, moved: false, active: true };
    e.preventDefault();
  };
  const onPointerMove = (e) => {
    const d = drag.current;
    if (!d?.active) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (Math.abs(dx) + Math.abs(dy) > 4) d.moved = true;
    stageRef.current.scrollLeft = d.left - dx;
    stageRef.current.scrollTop = d.top - dy;
  };
  const onPointerUp = () => {
    if (drag.current) drag.current.active = false;
    // Let the click that follows see `moved`, then forget the drag.
    setTimeout(() => (drag.current = null), 0);
  };

  // Swipe left/right moves between images (only when fitted; at 100% touch pans).
  const onTouchStart = (e) => {
    touch.current = !zoom && e.touches.length === 1 ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
  };
  const onTouchEnd = (e) => {
    const t = touch.current;
    touch.current = null;
    if (!t || zoom) return;
    const dx = e.changedTouches[0].clientX - t.x;
    const dy = e.changedTouches[0].clientY - t.y;
    if (Math.abs(dx) > 50 && Math.abs(dx) > 1.5 * Math.abs(dy)) go(dx < 0 ? 1 : -1);
  };

  const download = async () => {
    try {
      let url = src && src !== "error" ? src : null;
      let temp = null;
      if (!url) {
        const res = await fetch(imageApi.getImageUrl(item.generationId, item.imageId), { headers: await authHeaders() });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        url = temp = URL.createObjectURL(await res.blob());
      }
      const a = document.createElement("a");
      a.href = url;
      const ext = meta?.mimeType === "image/jpeg" ? "jpg" : "png";
      a.download = `llmui-${item.generationId}-${(meta?.position ?? 0) + 1}.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      if (temp) setTimeout(() => URL.revokeObjectURL(temp), 1000);
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  return (
    <div className="iv-overlay" role="dialog" aria-modal="true" aria-label="Image preview" onClick={close}>
      <div className="iv-main">
        <div className="iv-bar" onClick={(e) => e.stopPropagation()}>
          <span className="iv-counter">
            {items.length > 1 ? `${index + 1} / ${items.length}` : ""}
            {zoom && <span className="iv-zoom-tag">100%</span>}
          </span>
          <div className="iv-bar-btns">
            <button className="iv-btn" onClick={download} title="Download" aria-label="Download">
              <DownloadIcon />
              <span className="iv-btn-label">Download</span>
            </button>
            <button ref={closeRef} className="iv-btn" onClick={close} title="Close (Esc)" aria-label="Close">
              <CloseIcon />
            </button>
          </div>
        </div>

        <div
          ref={stageRef}
          className={`iv-stage ${zoom ? "is-zoomed" : ""}`}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={onPointerUp}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
          onClick={(e) => {
            // Clicking the backdrop around the image closes; the end of a pan doesn't.
            if (drag.current?.moved) e.stopPropagation();
          }}
        >
          {src && src !== "error" ? (
            <div className="iv-canvas">
              <img
                ref={imgRef}
                key={key}
                src={src}
                alt={meta?.prompt || "Generated image"}
                className="iv-img"
                draggable={false}
                onClick={onImageClick}
                title={zoom ? "Click to fit to screen" : "Click to view at 100%"}
              />
            </div>
          ) : (
            <div className="iv-status">{src === "error" ? "Couldn't load this image" : <span className="iv-spinner" />}</div>
          )}
        </div>

        {hasPrev && (
          <button className="iv-nav iv-nav-prev" onClick={(e) => { e.stopPropagation(); go(-1); }} aria-label="Previous image" title="Previous (←)">
            <ChevronIcon dir="left" />
          </button>
        )}
        {hasNext && (
          <button className="iv-nav iv-nav-next" onClick={(e) => { e.stopPropagation(); go(1); }} aria-label="Next image" title="Next (→)">
            <ChevronIcon dir="right" />
          </button>
        )}
      </div>

      <aside className="iv-info" onClick={(e) => e.stopPropagation()}>
        <InfoPanel meta={meta} />
      </aside>
    </div>
  );
}

// ── info panel ──────────────────────────────────────────────────────────

const UNKNOWN = <span className="iv-unknown">unknown</span>;
const known = (v) => v !== null && v !== undefined && v !== "";
const show = (v, fmt = (x) => x) => (known(v) ? fmt(v) : UNKNOWN);
const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
const baseName = (id) => id.split("/").pop();
const SLOT_LABELS = { vae: "VAE", clip_l: "CLIP-L", clip_g: "CLIP-G", t5xxl: "T5-XXL", llm: "LLM" };
const slotLabel = (slot) => SLOT_LABELS[slot] || slot.charAt(0).toUpperCase() + slot.slice(1).replace(/_/g, " ");

function InfoPanel({ meta }) {
  if (!meta) return <div className="iv-info-loading">Loading details…</div>;
  if (meta.error) return <div className="iv-info-error">Couldn't load details: {meta.error}</div>;

  const s = meta.settings || {};
  const t = meta.timings;
  const components = Object.entries(meta.components || {}).filter(([, id]) => id !== meta.model);

  return (
    <>
      <TextBlock label="Prompt" text={meta.prompt} />
      {known(meta.negativePrompt) && <TextBlock label="Negative prompt" text={meta.negativePrompt} />}

      <dl className="iv-details">
        <Row label="Size">{known(meta.width) && known(meta.height) ? `${meta.width} × ${meta.height} px` : UNKNOWN}</Row>
        <Row label="File size">{show(meta.fileSize, formatBytes)}</Row>
        <Row label="Server">{show(meta.machine?.name || meta.machine?.id)}</Row>
        <Row label="Model">
          {known(meta.model) ? <span title={meta.model}>{baseName(meta.model)}</span> : UNKNOWN}
        </Row>
        <Row label="Recipe">{show(meta.recipe)}</Row>
        {components.map(([slot, id]) => (
          <Row key={slot} label={slotLabel(slot)}>
            <span title={id}>{baseName(id)}</span>
          </Row>
        ))}
        <Row label="Seed">{show(s.seed)}</Row>
        <Row label="Steps">{show(s.steps)}</Row>
        <Row label="CFG">{show(s.cfgScale)}</Row>
        <Row label="Sampler">
          {known(s.sampler) ? `${s.sampler}${s.scheduler ? ` · ${s.scheduler}` : ""}` : UNKNOWN}
        </Row>
        <Row label="Time">
          {t && known(t.totalMs)
            ? `${seconds(t.totalMs)}${known(t.generateMs) ? ` (${seconds(t.generateMs)} generating)` : ""}`
            : UNKNOWN}
        </Row>
        <Row label="Created">{show(meta.createdAt, (ms) => new Date(ms).toLocaleString())}</Row>
      </dl>
    </>
  );
}

function Row({ label, children }) {
  return (
    <>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </>
  );
}

function TextBlock({ label, text }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => setCopied(false), [text]);
  const copy = async () => {
    try {
      await copyText(text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };
  return (
    <section className="iv-text">
      <div className="iv-text-head">
        <span className="iv-label">{label}</span>
        {known(text) && (
          <button className={`iv-copy ${copied ? "is-done" : ""}`} onClick={copy} aria-label={`Copy ${label.toLowerCase()}`}>
            {copied ? "Copied" : "Copy"}
          </button>
        )}
      </div>
      <p className="iv-text-body">{known(text) ? text : UNKNOWN}</p>
    </section>
  );
}

/** Clipboard API where allowed (secure context), else the textarea fallback. */
async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.setAttribute("readonly", "");
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("copy command refused");
}

// ── icons ───────────────────────────────────────────────────────────────

const svgProps = { width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true };

function DownloadIcon() {
  return (
    <svg {...svgProps}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" y1="15" x2="12" y2="3" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...svgProps}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}

function ChevronIcon({ dir }) {
  return (
    <svg {...svgProps} width={22} height={22}>
      <polyline points={dir === "left" ? "15 18 9 12 15 6" : "9 18 15 12 9 6"} />
    </svg>
  );
}
