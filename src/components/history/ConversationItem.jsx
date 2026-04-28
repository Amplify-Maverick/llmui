import { formatDate } from "../../utils/formatters.js";
import "./ConversationItem.css";

export default function ConversationItem({
  conversation,
  isActive,
  onClick,
  onDelete,
}) {
  return (
    <div
      className={`conv-item ${isActive ? "active" : ""}`}
      onClick={onClick}
    >
      <div className="conv-item-title">{conversation.title}</div>
      {conversation.model && (
        <div className="conv-item-model">
          {conversation.model.includes("/")
            ? conversation.model.split("/").pop()
            : conversation.model}
        </div>
      )}
      <div className="conv-item-meta">
        <span>{formatDate(conversation.updatedAt)}</span>
        <button
          className="conv-item-delete"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(conversation.id);
          }}
          title="Delete conversation"
        >
          Delete
        </button>
      </div>
    </div>
  );
}
