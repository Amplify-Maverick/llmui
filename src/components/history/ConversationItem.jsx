import { useState } from "react";
import { formatDate } from "../../utils/storage.js";

const itemStyle = {
  padding: "12px",
  borderRadius: "8px",
  cursor: "pointer",
  transition: "all 0.2s ease",
  marginBottom: "4px",
};

const activeStyle = {
  background: "rgba(110, 231, 183, 0.1)",
  border: "1px solid rgba(110, 231, 183, 0.2)",
};

const inactiveStyle = {
  background: "transparent",
  border: "1px solid transparent",
};

const hoverStyle = {
  background: "rgba(255,255,255,0.05)",
};

const titleStyle = {
  fontSize: "14px",
  fontWeight: "500",
  color: "#e8e8f0",
  marginBottom: "4px",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const metaStyle = {
  fontSize: "12px",
  color: "#8a8a9a",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

const modelBadgeStyle = {
  display: "inline-block",
  fontSize: "11px",
  color: "#6ee7b7",
  background: "rgba(110, 231, 183, 0.10)",
  border: "1px solid rgba(110, 231, 183, 0.18)",
  borderRadius: "4px",
  padding: "2px 6px",
  marginBottom: "4px",
  maxWidth: "100%",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const deleteButtonStyle = {
  background: "none",
  border: "none",
  color: "#8a8a9a",
  cursor: "pointer",
  padding: "4px",
  fontSize: "14px",
  opacity: 0,
  transition: "opacity 0.2s ease",
};

export default function ConversationItem({
  conversation,
  isActive,
  onClick,
  onDelete,
}) {
  const [isHovered, setIsHovered] = useState(false);

  const baseStyle = isActive ? activeStyle : inactiveStyle;
  const computedStyle = {
    ...itemStyle,
    ...baseStyle,
    ...(isHovered && !isActive ? hoverStyle : {}),
  };

  return (
    <div
      style={computedStyle}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={titleStyle}>{conversation.title}</div>
      {conversation.model && (
        <div style={modelBadgeStyle}>
          🤖 {conversation.model.includes("/")
            ? conversation.model.split("/").pop()
            : conversation.model}
        </div>
      )}
      <div style={metaStyle}>
        <span>{formatDate(conversation.updatedAt)}</span>
        <button
          style={{
            ...deleteButtonStyle,
            opacity: isHovered ? 1 : 0,
          }}
          onClick={(e) => {
            e.stopPropagation();
            onDelete(conversation.id);
          }}
          title="Delete conversation"
        >
          🗑️
        </button>
      </div>
    </div>
  );
}
