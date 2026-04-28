import { useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer.jsx";
import "./MessageBubble.css";

// Icons as inline SVGs for better control
const CopyIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
  </svg>
);

const CheckIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="20 6 9 17 4 12"/>
  </svg>
);

const EditIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
    <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
  </svg>
);

const RefreshIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="23 4 23 10 17 10"/>
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
  </svg>
);

const TrashIcon = () => (
  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <polyline points="3 6 5 6 21 6"/>
    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
  </svg>
);

function formatDuration(seconds) {
  if (!seconds) return null;
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(0);
  return `${mins}m ${secs}s`;
}

function formatTokensPerSec(tokensPerSec) {
  if (!tokensPerSec) return null;
  return `${tokensPerSec.toFixed(1)} tok/s`;
}

export default function MessageBubble({
  message,
  isStreaming = false,
  onCopy,
  onEdit,
  onDelete,
  onRegenerate,
  isLastAssistant = false,
}) {
  const [copied, setCopied] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [editContent, setEditContent] = useState(message.content);

  const isUser = message.role === "user";

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(message.content);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
      onCopy?.();
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const handleEdit = () => {
    setEditContent(message.content);
    setIsEditing(true);
  };

  const handleSaveEdit = () => {
    if (editContent.trim() && editContent !== message.content) {
      onEdit?.(message.id, editContent.trim());
    }
    setIsEditing(false);
  };

  const handleCancelEdit = () => {
    setEditContent(message.content);
    setIsEditing(false);
  };

  const handleKeyDown = (e) => {
    if (e.key === "Escape") {
      handleCancelEdit();
    } else if (e.key === "Enter" && e.ctrlKey) {
      handleSaveEdit();
    }
  };

  return (
    <div className="message-row">
      <div className={`bubble ${isUser ? "bubble-user" : "bubble-assistant"}`}>
        <div className={`bubble-role ${isUser ? "bubble-role-user" : "bubble-role-assistant"}`}>
          {isUser ? "You" : "Assistant"}
          {!isUser && message.model && (
            <span className="bubble-model">{message.model}</span>
          )}
          {!isUser && message.duration && (
            <span className="bubble-duration">{formatDuration(message.duration)}</span>
          )}
          {!isUser && message.tokensPerSec && (
            <span className="bubble-tokens-per-sec">{formatTokensPerSec(message.tokensPerSec)}</span>
          )}
        </div>

        {isEditing ? (
          <div className="bubble-edit">
            <textarea
              className="bubble-edit-textarea"
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              onKeyDown={handleKeyDown}
              autoFocus
            />
            <div className="bubble-edit-actions">
              <span className="bubble-edit-hint">Ctrl+Enter to save, Esc to cancel</span>
              <button className="bubble-edit-btn cancel" onClick={handleCancelEdit}>
                Cancel
              </button>
              <button className="bubble-edit-btn save" onClick={handleSaveEdit}>
                Save & Regenerate
              </button>
            </div>
          </div>
        ) : (
          <div className="bubble-content">
            {isUser ? (
              <div className="bubble-text-content">{message.content}</div>
            ) : (
              <MarkdownRenderer content={message.content} />
            )}
            {isStreaming && <span className="streaming-cursor" />}
          </div>
        )}

        {/* Message Actions */}
        {!isEditing && !isStreaming && (
          <div className="bubble-actions">
            <button
              className={`bubble-action-btn ${copied ? "copied" : ""}`}
              onClick={handleCopy}
              title={copied ? "Copied!" : "Copy message"}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
            {isUser && (
              <button
                className="bubble-action-btn"
                onClick={handleEdit}
                title="Edit message"
              >
                <EditIcon />
              </button>
            )}
            {!isUser && isLastAssistant && (
              <button
                className="bubble-action-btn"
                onClick={() => onRegenerate?.(message.id)}
                title="Regenerate response"
              >
                <RefreshIcon />
              </button>
            )}
            <button
              className="bubble-action-btn danger"
              onClick={() => onDelete?.(message.id)}
              title="Delete message"
            >
              <TrashIcon />
            </button>
          </div>
        )}

        {/* Image attachments */}
        {message.images && message.images.length > 0 && (
          <div className="bubble-images">
            {message.images.map((img, idx) => (
              <img
                key={idx}
                src={img.data ? `data:${img.type};base64,${img.data}` : img.url}
                alt={img.name || `Image ${idx + 1}`}
                className="bubble-image"
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
