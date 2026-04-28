import { useState } from "react";
import MarkdownRenderer from "./MarkdownRenderer.jsx";
import "./MessageBubble.css";

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
  const [showActions, setShowActions] = useState(false);

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
    <div
      className="message-row"
      onMouseEnter={() => setShowActions(true)}
      onMouseLeave={() => setShowActions(false)}
    >
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
        {!isEditing && !isStreaming && (showActions || copied) && (
          <div className="bubble-actions">
            <button
              className={`bubble-action-btn ${copied ? "copied" : ""}`}
              onClick={handleCopy}
              title="Copy message"
            >
              {copied ? "Copied!" : "Copy"}
            </button>
            {isUser && (
              <button
                className="bubble-action-btn"
                onClick={handleEdit}
                title="Edit message"
              >
                Edit
              </button>
            )}
            {!isUser && isLastAssistant && (
              <button
                className="bubble-action-btn"
                onClick={() => onRegenerate?.(message.id)}
                title="Regenerate response"
              >
                Regenerate
              </button>
            )}
            <button
              className="bubble-action-btn danger"
              onClick={() => onDelete?.(message.id)}
              title="Delete message"
            >
              Delete
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
