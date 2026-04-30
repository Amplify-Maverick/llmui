import { useState } from "react";
import { formatDate } from "../../utils/formatters.js";
import "./ConversationItem.css";

export default function ConversationItem({
  conversation,
  isActive,
  onClick,
  onDelete,
  onRename,
  onTags,
  onExport,
  availableTags = [],
  selectMode = false,
  isSelected = false,
}) {
  const [showMenu, setShowMenu] = useState(false);

  const conversationTags = conversation.tags || [];
  const tagObjects = availableTags.filter((t) => conversationTags.includes(t.id));

  const handleAction = (e, action) => {
    e.stopPropagation();
    setShowMenu(false);
    action(conversation.id);
  };

  return (
    <div
      className={`conv-item ${isActive ? "active" : ""} ${selectMode ? "select-mode" : ""} ${isSelected ? "selected" : ""}`}
      onClick={onClick}
    >
      <div className="conv-item-header">
        {selectMode && (
          <div className={`conv-item-checkbox ${isSelected ? 'checked' : ''}`}>
            {isSelected && (
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            )}
          </div>
        )}
        <div className="conv-item-title">{conversation.title}</div>
        {!selectMode && (
          <button
            className="conv-item-menu-btn"
            onClick={(e) => {
              e.stopPropagation();
              setShowMenu(!showMenu);
            }}
            title="More options"
          >
            ⋯
          </button>
        )}
        {showMenu && (
          <div className="conv-item-menu">
            <button onClick={(e) => handleAction(e, onRename)}>Rename</button>
            <button onClick={(e) => handleAction(e, onTags)}>Tags</button>
            <button onClick={(e) => handleAction(e, onExport)}>Export</button>
            <button className="danger" onClick={(e) => handleAction(e, onDelete)}>
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Tags display */}
      {tagObjects.length > 0 && (
        <div className="conv-item-tags">
          {tagObjects.map((tag) => (
            <span
              key={tag.id}
              className="conv-item-tag"
              style={{ "--tag-color": tag.color }}
            >
              {tag.label}
            </span>
          ))}
        </div>
      )}

      <div className="conv-item-info-row">
        {conversation.source === "telegram" && (
          <div className="conv-item-telegram-indicator" title="Telegram chat">
            <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11.944 0A12 12 0 0 0 0 12a12 12 0 0 0 12 12 12 12 0 0 0 12-12A12 12 0 0 0 12 0a12 12 0 0 0-.056 0zm4.962 7.224c.1-.002.321.023.465.14a.506.506 0 0 1 .171.325c.016.093.036.306.02.472-.18 1.898-.962 6.502-1.36 8.627-.168.9-.499 1.201-.82 1.23-.696.065-1.225-.46-1.9-.902-1.056-.693-1.653-1.124-2.678-1.8-1.185-.78-.417-1.21.258-1.91.177-.184 3.247-2.977 3.307-3.23.007-.032.014-.15-.056-.212s-.174-.041-.249-.024c-.106.024-1.793 1.14-5.061 3.345-.48.33-.913.49-1.302.48-.428-.008-1.252-.241-1.865-.44-.752-.245-1.349-.374-1.297-.789.027-.216.325-.437.893-.663 3.498-1.524 5.83-2.529 6.998-3.014 3.332-1.386 4.025-1.627 4.476-1.635z"/>
            </svg>
            Telegram
          </div>
        )}
        {conversation.isCompare && (
          <div className="conv-item-compare-indicator" title={`Compared: ${conversation.compareModels?.join(', ') || ''}`}>
            Compare
          </div>
        )}
        {conversation.model && !conversation.isCompare && (
          <div className="conv-item-model">
            {conversation.model.includes("/")
              ? conversation.model.split("/").pop()
              : conversation.model}
          </div>
        )}
        {conversation.childBranchCount > 0 && (
          <div className="conv-item-branch-indicator">
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="6" y1="3" x2="6" y2="15"/>
              <circle cx="18" cy="6" r="3"/>
              <circle cx="6" cy="18" r="3"/>
              <path d="M18 9a9 9 0 0 1-9 9"/>
            </svg>
            <span>{conversation.childBranchCount}</span>
          </div>
        )}
      </div>
      <div className="conv-item-meta">
        <span>{formatDate(conversation.updatedAt)}</span>
        <span className="conv-item-count">
          {conversation.messageCount ?? 0} messages
        </span>
      </div>
    </div>
  );
}
