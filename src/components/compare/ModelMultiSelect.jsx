import { useState, useRef, useEffect } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { formatBytes } from "../../utils/formatters.js";
import "./ModelMultiSelect.css";

export default function ModelMultiSelect({
  value = [],
  onChange,
  maxSelections = 4,
  minSelections = 2,
  disabled = false,
}) {
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef(null);
  const { localModels } = useModelsStore();

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (e) => {
      if (containerRef.current && !containerRef.current.contains(e.target)) {
        setIsOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleToggle = (modelName) => {
    if (value.includes(modelName)) {
      onChange(value.filter((v) => v !== modelName));
    } else if (value.length < maxSelections) {
      onChange([...value, modelName]);
    }
  };

  const handleRemove = (modelName, e) => {
    e.stopPropagation();
    onChange(value.filter((v) => v !== modelName));
  };

  const isValid = value.length >= minSelections && value.length <= maxSelections;

  return (
    <div
      ref={containerRef}
      className={`model-multi-select ${isOpen ? "open" : ""} ${disabled ? "disabled" : ""}`}
    >
      <div
        className="model-multi-select-trigger"
        onClick={() => !disabled && setIsOpen(!isOpen)}
      >
        {value.length === 0 ? (
          <span className="model-multi-select-placeholder">
            Select {minSelections}-{maxSelections} models
          </span>
        ) : (
          <div className="model-multi-select-tags">
            {value.map((modelName) => (
              <span key={modelName} className="model-multi-select-tag">
                {modelName.split(":")[0]}
                <button
                  className="model-multi-select-tag-remove"
                  onClick={(e) => handleRemove(modelName, e)}
                  disabled={disabled}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}
        <span className="model-multi-select-arrow">{isOpen ? "▲" : "▼"}</span>
      </div>

      {isOpen && (
        <div className="model-multi-select-dropdown">
          {localModels.map((model) => {
            const isSelected = value.includes(model.name);
            const isDisabled = !isSelected && value.length >= maxSelections;

            return (
              <div
                key={model.name}
                className={`model-multi-select-option ${isSelected ? "selected" : ""} ${isDisabled ? "disabled" : ""}`}
                onClick={() => !isDisabled && handleToggle(model.name)}
              >
                <span className="model-multi-select-checkbox">
                  {isSelected && "✓"}
                </span>
                <div className="model-multi-select-option-info">
                  <span className="model-multi-select-option-name">
                    {model.name}
                  </span>
                  <span className="model-multi-select-option-size">
                    {formatBytes(model.size)}
                  </span>
                </div>
              </div>
            );
          })}
          {localModels.length === 0 && (
            <div className="model-multi-select-empty">No models available</div>
          )}
        </div>
      )}

      {!isValid && value.length > 0 && value.length < minSelections && (
        <div className="model-multi-select-hint">
          Select at least {minSelections} models
        </div>
      )}
    </div>
  );
}
