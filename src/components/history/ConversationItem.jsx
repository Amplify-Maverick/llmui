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
      className={`conv-item ${isActive ? "active" : ""}`}
      onClick={onClick}
    >
      <div className="conv-item-header">
        <div className="conv-item-title">{conversation.title}</div>
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

      {conversation.model && (
        <div className="conv-item-model">
          {conversation.model.includes("/")
            ? conversation.model.split("/").pop()
            : conversation.model}
        </div>
      )}
      <div className="conv-item-meta">
        <span>{formatDate(conversation.updatedAt)}</span>
        <span className="conv-item-count">
          {conversation.messages?.length || 0} messages
        </span>
      </div>
    </div>
  );
}
