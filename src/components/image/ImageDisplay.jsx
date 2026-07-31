import { useState, useEffect, useRef } from "react";
import { useImageStore } from "../../stores/imageStore.js";
import { authHeaders } from "../../services/auth.js";
import "./ImageDisplay.css";

export default function ImageDisplay() {
  const {
    currentImages,
    currentGenerationId,
    selectedGeneration,
    isGenerating,
    progress,
    getImageUrl,
  } = useImageStore();

  const [activeIndex, setActiveIndex] = useState(0);
  const [imageLoaded, setImageLoaded] = useState(false);
  const [blobUrl, setBlobUrl] = useState(null);
  const prevBlobUrl = useRef(null);

  // Reset active index when images change
  const activeImage = currentImages[activeIndex] || currentImages[0];

  // Fetch image with auth headers and create blob URL
  useEffect(() => {
    if (!activeImage) {
      setBlobUrl(null);
      return;
    }

    let cancelled = false;
    const url = getImageUrl(activeImage.generationId, activeImage.id);

    (async () => {
      try {
        const response = await fetch(url, { headers: await authHeaders() });
        if (!response.ok) throw new Error("Failed to load image");
        const blob = await response.blob();
        if (cancelled) return;
        const newBlobUrl = URL.createObjectURL(blob);
        // Revoke previous blob URL
        if (prevBlobUrl.current) {
          URL.revokeObjectURL(prevBlobUrl.current);
        }
        prevBlobUrl.current = newBlobUrl;
        setBlobUrl(newBlobUrl);
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to fetch image:", err);
          setBlobUrl(null);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [activeImage?.id, activeImage?.generationId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup blob URLs on unmount
  useEffect(() => {
    return () => {
      if (prevBlobUrl.current) {
        URL.revokeObjectURL(prevBlobUrl.current);
      }
    };
  }, []);

  const handleDownload = async () => {
    if (!activeImage) return;
    try {
      const url = getImageUrl(activeImage.generationId, activeImage.id);
      const response = await fetch(url, { headers: await authHeaders() });
      const blob = await response.blob();
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = blobUrl;
      a.download = `llmui-${activeImage.generationId}-${activeIndex}.png`;
      a.click();
      URL.revokeObjectURL(blobUrl);
    } catch (err) {
      console.error("Download failed:", err);
    }
  };

  // Show generating state
  if (isGenerating) {
    return (
      <div className="image-display-empty">
        <div className="image-display-generating">
          <div className="image-display-spinner" />
          <p>Generating image...</p>
          <p className="image-display-pct">{Math.round(progress * 100)}%</p>
        </div>
      </div>
    );
  }

  // No images yet
  if (currentImages.length === 0) {
    return (
      <div className="image-display-empty">
        <div className="image-display-placeholder">
          <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1" strokeLinecap="round" strokeLinejoin="round" opacity="0.3">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <polyline points="21 15 16 10 5 21" />
          </svg>
          <h3>No images yet</h3>
          <p>Configure your settings and click Generate to create an image.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="image-display">
      <div className="image-display-canvas">
        {blobUrl ? (
          <img
            key={activeImage?.id}
            src={blobUrl}
            alt={selectedGeneration?.prompt || "Generated image"}
            className={`image-display-img ${imageLoaded ? "loaded" : ""}`}
            onLoad={() => setImageLoaded(true)}
            onError={() => setImageLoaded(false)}
          />
        ) : activeImage ? (
          <div className="image-display-generating">
            <div className="image-display-spinner" />
            <p>Loading image...</p>
          </div>
        ) : null}
      </div>

      {/* Actions bar */}
      <div className="image-display-actions">
        {currentImages.length > 1 && (
          <div className="image-display-nav">
            {currentImages.map((img, i) => (
              <button
                key={img.id}
                className={`image-display-nav-btn ${i === activeIndex ? "active" : ""}`}
                onClick={() => { setActiveIndex(i); setImageLoaded(false); }}
              >
                {i + 1}
              </button>
            ))}
          </div>
        )}
        <div className="image-display-btns">
          <button className="image-display-action-btn" onClick={handleDownload} title="Download">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
            Download
          </button>
        </div>
      </div>

      {/* Generation info */}
      {selectedGeneration && (
        <div className="image-display-info">
          <span className="image-display-info-item">
            <strong>Seed:</strong> {selectedGeneration.seed}
          </span>
          <span className="image-display-info-item">
            <strong>Steps:</strong> {selectedGeneration.steps}
          </span>
          <span className="image-display-info-item">
            <strong>CFG:</strong> {selectedGeneration.cfg_scale}
          </span>
          <span className="image-display-info-item">
            <strong>Size:</strong> {selectedGeneration.width}×{selectedGeneration.height}
          </span>
        </div>
      )}
    </div>
  );
}
