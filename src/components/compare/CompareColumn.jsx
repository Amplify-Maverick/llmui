import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import MarkdownRenderer from "../chat/MarkdownRenderer.jsx";
import "./CompareColumn.css";

export default function CompareColumn({
  model,
  streamState,
  onPick,
  onStop,
}) {
  const [copied, setCopied] = useState(false);
  const contentRef = useRef(null);

  const {
    status = "idle",
    content = "",
    tokenCount = 0,
    startTime,
    endTime,
    error,
  } = streamState || {};

  // Auto-scroll during streaming
  useEffect(() => {
    if (status === "streaming" && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, status]);

  // Calculate live tokens/sec
  const tokensPerSec = useMemo(() => {
    if (!startTime || tokenCount === 0) return null;
    const elapsed = ((endTime || Date.now()) - startTime) / 1000;
    if (elapsed <= 0) return null;
    return (tokenCount / elapsed).toFixed(1);
  }, [tokenCount, startTime, endTime, status]);

  // Calculate final stats
  const finalStats = useMemo(() => {
    if (status !== "complete" && status !== "aborted") return null;
    if (!startTime || !endTime) return null;
    const duration = (endTime - startTime) / 1000;
    return {
      duration: duration.toFixed(1),
      tokens: tokenCount,
      avgTokPerSec: tokenCount > 0 ? (tokenCount / duration).toFixed(1) : "0",
    };
  }, [status, startTime, endTime, tokenCount]);

  const handleCopy = useCallback(async () => {
    if (!content) return;
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  }, [content]);

  const handlePick = useCallback(() => {
    if (onPick && (status === "complete" || status === "aborted") && content) {
      onPick(model, content, finalStats);
    }
  }, [onPick, model, content, status, finalStats]);

  const isStreaming = status === "streaming";
  const isComplete = status === "complete" || status === "aborted";
  const hasError = status === "error";

  return (
    <div className={`compare-column ${status}`}>
      <div className="compare-column-header">
        <div className="compare-column-header-left">
          <span className="compare-column-model" title={model}>
            {model}
          </span>
          {isStreaming && tokensPerSec && (
            <span className="compare-column-speed">{tokensPerSec} tok/s</span>
          )}
        </div>
        <div className="compare-column-header-actions">
          {isStreaming && onStop && (
            <button
              className="compare-column-stop-btn"
              onClick={() => onStop(model)}
              title="Stop generation"
            >
              Stop
            </button>
          )}
          {content && (
            <button
              className="compare-column-copy-btn"
              onClick={handleCopy}
              title="Copy response"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
          )}
        </div>
      </div>

      <div className="compare-column-content" ref={contentRef}>
        {hasError ? (
          <div className="compare-column-error">
            <span className="compare-column-error-icon">!</span>
            <span>{error || "An error occurred"}</span>
          </div>
        ) : content ? (
          <>
            <MarkdownRenderer content={content} />
            {isStreaming && <span className="streaming-cursor" />}
          </>
        ) : isStreaming ? (
          <div className="compare-column-loading">
            <span className="compare-column-loading-dot" />
            <span className="compare-column-loading-dot" />
            <span className="compare-column-loading-dot" />
          </div>
        ) : null}
      </div>

      {isComplete && finalStats && (
        <div className="compare-column-footer">
          <div className="compare-column-stats">
            <span className="compare-column-stat">
              <span className="compare-column-stat-label">Time:</span>
              <span className="compare-column-stat-value">{finalStats.duration}s</span>
            </span>
            <span className="compare-column-stat">
              <span className="compare-column-stat-label">Tokens:</span>
              <span className="compare-column-stat-value">{finalStats.tokens}</span>
            </span>
            <span className="compare-column-stat">
              <span className="compare-column-stat-label">Avg:</span>
              <span className="compare-column-stat-value">{finalStats.avgTokPerSec} tok/s</span>
            </span>
          </div>
          <button className="compare-column-pick-btn" onClick={handlePick}>
            Pick this one
          </button>
        </div>
      )}
    </div>
  );
}
