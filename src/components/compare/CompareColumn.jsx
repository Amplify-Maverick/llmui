import { useState, useCallback, useMemo, useRef, useEffect } from "react";
import MarkdownRenderer from "../chat/MarkdownRenderer.jsx";
import { liveTokensPerSec } from "../../utils/streamSpeed.js";
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
    phase = null,
    content = "",
    tokenCount = 0,
    firstTokenTime,
    startTime,
    endTime,
    loadMs,
    timings,
    tokensPerSec: finalTokensPerSec,
    promptPerSec,
    error,
  } = streamState || {};

  // Auto-scroll during streaming
  useEffect(() => {
    if (status === "streaming" && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [content, status]);

  // Live tokens/sec while streaming, from the first generated token.
  // `content` changes on every token, which recomputes this.
  const tokensPerSec = useMemo(() => {
    if (status !== "streaming") return null;
    const tps = liveTokensPerSec(tokenCount, firstTokenTime);
    return tps ? tps.toFixed(1) : null;
  }, [status, tokenCount, firstTokenTime, content]);

  // Final stats. Time = request sent → last token (prompt + generation;
  // excludes the explicit load step, shown separately). Speeds come from
  // llama.cpp's timings when present.
  const finalStats = useMemo(() => {
    if (status !== "complete" && status !== "aborted") return null;
    if (!startTime || !endTime) return null;
    const duration = (endTime - startTime) / 1000;
    return {
      duration: duration.toFixed(1),
      tokens: timings?.predicted_n ?? tokenCount,
      avgTokPerSec: finalTokensPerSec ? finalTokensPerSec.toFixed(1) : null,
      readTokPerSec: promptPerSec ? promptPerSec.toFixed(0) : null,
      loadSec: loadMs ? (loadMs / 1000).toFixed(1) : null,
    };
  }, [status, startTime, endTime, tokenCount, timings, finalTokensPerSec, promptPerSec, loadMs]);

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
  const isWaiting = status === "queued" || status === "preparing";
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
          {(isStreaming || isWaiting) && onStop && (
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
        ) : isWaiting ? (
          <div className="compare-column-phase">
            {status === "preparing" && <span className="compare-column-loading-dot" />}
            <span>{phase || "Waiting…"}</span>
          </div>
        ) : status === "aborted" ? (
          <div className="compare-column-phase">Stopped before any output.</div>
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
            <span className="compare-column-stat" title="Request sent → last token (prompt + generation)">
              <span className="compare-column-stat-label">Time:</span>
              <span className="compare-column-stat-value">{finalStats.duration}s</span>
            </span>
            <span className="compare-column-stat" title="Generation (writing) speed">
              <span className="compare-column-stat-value">{finalStats.avgTokPerSec ?? "–"} tok/s</span>
            </span>
            {finalStats.readTokPerSec && (
              <span className="compare-column-stat" title="Prompt processing (reading) speed">
                <span className="compare-column-stat-label">read</span>
                <span className="compare-column-stat-value">{finalStats.readTokPerSec} tok/s</span>
              </span>
            )}
            <span className="compare-column-stat">
              <span className="compare-column-stat-label">Tokens:</span>
              <span className="compare-column-stat-value">{finalStats.tokens}</span>
            </span>
            {finalStats.loadSec && (
              <span className="compare-column-stat" title="Time to load the model before this run">
                <span className="compare-column-stat-label">Load:</span>
                <span className="compare-column-stat-value">{finalStats.loadSec}s</span>
              </span>
            )}
          </div>
          <button className="compare-column-pick-btn" onClick={handlePick}>
            Pick this one
          </button>
        </div>
      )}
    </div>
  );
}
