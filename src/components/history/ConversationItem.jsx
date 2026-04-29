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
