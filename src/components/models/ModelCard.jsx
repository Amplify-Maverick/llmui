import Button from "../shared/Button.jsx";
import { formatBytes } from "../../utils/formatters.js";
import "./ModelCard.css";

/** A model served by the OpenAI-compatible /v1 server. */
export default function ModelCard({ model, modelInfo, onSelect, isSelected }) {
  return (
    <div className={`model-card ${isSelected ? "selected" : ""}`}>
      <div className="model-card-header">
        <h3 className="model-card-name">{model.name}</h3>
        <div className="model-card-tags">
          {modelInfo?.supportsTools && (
            <span className="model-card-tag tools">Tools</span>
          )}
        </div>
      </div>

      {model.size > 0 && (
        <div className="model-card-detail">
          <span>Size</span>
          <span>{formatBytes(model.size)}</span>
        </div>
      )}

      {model.contextLength && (
        <div className="model-card-detail">
          <span>Context</span>
          <span>{model.contextLength.toLocaleString()} tokens</span>
        </div>
      )}

      {model.ownedBy && (
        <div className="model-card-detail">
          <span>Owned by</span>
          <span>{model.ownedBy}</span>
        </div>
      )}

      <div className="model-card-actions">
        <Button
          variant={isSelected ? "primary" : "secondary"}
          onClick={() => onSelect(model.name)}
          style={{ flex: 1 }}
        >
          {isSelected ? "Selected" : "Use Model"}
        </Button>
      </div>
    </div>
  );
}
