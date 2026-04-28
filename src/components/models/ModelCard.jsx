import Button from "../shared/Button.jsx";
import { formatBytes } from "../../utils/formatters.js";
import "./ModelCard.css";

export default function ModelCard({ model, onDelete, onSelect, isSelected }) {
  const modifiedDate = model.modified_at
    ? new Date(model.modified_at).toLocaleDateString()
    : "Unknown";

  return (
    <div className={`model-card ${isSelected ? "selected" : ""}`}>
      <div className="model-card-header">
        <h3 className="model-card-name">{model.name}</h3>
        {model.details?.family && (
          <span className="model-card-tag">{model.details.family}</span>
        )}
      </div>

      <div className="model-card-detail">
        <span>Size</span>
        <span>{formatBytes(model.size)}</span>
      </div>

      {model.details?.parameter_size && (
        <div className="model-card-detail">
          <span>Parameters</span>
          <span>{model.details.parameter_size}</span>
        </div>
      )}

      {model.details?.quantization_level && (
        <div className="model-card-detail">
          <span>Quantization</span>
          <span>{model.details.quantization_level}</span>
        </div>
      )}

      <div className="model-card-detail">
        <span>Modified</span>
        <span>{modifiedDate}</span>
      </div>

      <div className="model-card-actions">
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
