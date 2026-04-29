import { useState, memo } from "react";
import "./ToolCallCard.css";

function ToolCallCard({ toolCall }) {
  const [expanded, setExpanded] = useState(false);
  const { id, name, arguments: args, status, result, error } = toolCall;

  const statusIcon = {
    calling: "\u23F3", // hourglass
    completed: error ? "\u274C" : "\u2705", // cross or checkmark
  }[status];

  const formatToolName = (name) => {
    return name.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  };

  const formatJson = (obj) => {
    if (obj === null || obj === undefined) return "null";
    try {
      return JSON.stringify(obj, null, 2);
    } catch {
      return String(obj);
    }
  };

  return (
    <div className={`tool-call-card ${status} ${error ? "error" : ""}`}>
      <div
        className="tool-call-header"
        onClick={() => setExpanded(!expanded)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => e.key === "Enter" && setExpanded(!expanded)}
      >
        <span className="tool-call-icon">{statusIcon}</span>
        <span className="tool-call-name">{formatToolName(name)}</span>
        {args && typeof args === "object" && Object.keys(args).length > 0 && (
          <span className="tool-call-preview">
            ({Object.entries(args)
              .slice(0, 2)
              .map(([k, v]) => `${k}: ${typeof v === "string" ? `"${v.slice(0, 20)}${v.length > 20 ? "..." : ""}"` : v}`)
              .join(", ")}
            {Object.keys(args).length > 2 ? ", ..." : ""})
          </span>
        )}
        <span className={`tool-call-expand ${expanded ? "expanded" : ""}`}>
          {expanded ? "\u25BC" : "\u25B6"}
        </span>
      </div>
      {expanded && (
        <div className="tool-call-details">
          <div className="tool-call-section">
            <div className="tool-call-section-label">Arguments:</div>
            <pre className="tool-call-json">{formatJson(args)}</pre>
          </div>
          {status === "completed" && (
            <div className="tool-call-section">
              <div className="tool-call-section-label">
                {error ? "Error:" : "Result:"}
              </div>
              <pre className={`tool-call-json ${error ? "error-text" : ""}`}>
                {error || formatJson(result)}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default memo(ToolCallCard);
