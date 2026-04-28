import { useState } from "react";
import Button from "../shared/Button.jsx";
import { formatBytes } from "../../utils/storage.js";

const cardStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "12px",
  padding: "16px",
  transition: "all 0.2s ease",
};

const cardHoverStyle = {
  background: "rgba(255,255,255,0.05)",
  borderColor: "rgba(255,255,255,0.1)",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "flex-start",
  marginBottom: "12px",
};

const nameStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: 0,
  wordBreak: "break-word",
};

const tagStyle = {
  background: "rgba(96, 165, 250, 0.15)",
  border: "1px solid rgba(96, 165, 250, 0.3)",
  borderRadius: "4px",
  padding: "2px 8px",
  fontSize: "11px",
  color: "#60a5fa",
  fontWeight: "500",
};

const detailStyle = {
  display: "flex",
  justifyContent: "space-between",
  fontSize: "13px",
  color: "#8a8a9a",
  marginBottom: "4px",
};

const actionsStyle = {
  display: "flex",
  gap: "8px",
  marginTop: "16px",
};

export default function ModelCard({ model, onDelete, onSelect, isSelected }) {
  const [isHovered, setIsHovered] = useState(false);

  const modifiedDate = model.modified_at
    ? new Date(model.modified_at).toLocaleDateString()
    : "Unknown";

  return (
    <div
      style={{
        ...cardStyle,
        ...(isHovered ? cardHoverStyle : {}),
        ...(isSelected ? { borderColor: "rgba(110, 231, 183, 0.5)" } : {}),
      }}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
    >
      <div style={headerStyle}>
        <h3 style={nameStyle}>{model.name}</h3>
        {model.details?.family && <span style={tagStyle}>{model.details.family}</span>}
      </div>

      <div style={detailStyle}>
        <span>Size</span>
        <span>{formatBytes(model.size)}</span>
      </div>

      {model.details?.parameter_size && (
        <div style={detailStyle}>
          <span>Parameters</span>
          <span>{model.details.parameter_size}</span>
        </div>
      )}

      {model.details?.quantization_level && (
        <div style={detailStyle}>
          <span>Quantization</span>
          <span>{model.details.quantization_level}</span>
        </div>
      )}

      <div style={detailStyle}>
        <span>Modified</span>
        <span>{modifiedDate}</span>
      </div>

      <div style={actionsStyle}>
        <Button
          variant={isSelected ? "primary" : "secondary"}
          onClick={() => onSelect(model.name)}
          style={{ flex: 1 }}
        >
          {isSelected ? "Selected" : "Use Model"}
        </Button>
        <Button variant="danger" onClick={() => onDelete(model.name)}>
          Delete
        </Button>
      </div>
    </div>
  );
}
