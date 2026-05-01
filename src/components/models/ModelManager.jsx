import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import ModelCard from "./ModelCard.jsx";
import ModelPullDialog from "./ModelPullDialog.jsx";
import HardwareGuideModal from "./HardwareGuideModal.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import "./ModelManager.css";

export default function ModelManager() {
  const {
    localModels,
    isLoading,
    error,
    pullProgress,
    modelInfoCache,
    fetchModels,
    fetchModelInfo,
    pullModel,
    deleteModel,
    clearError,
  } = useModelsStore();

  const { defaultModel, updateSetting } = useSettingsStore();

  const [showPullDialog, setShowPullDialog] = useState(false);
  const [showHardwareGuide, setShowHardwareGuide] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Fetch model info for each model to get tool support status
  useEffect(() => {
    localModels.forEach((model) => {
      if (!modelInfoCache[model.name]) {
        fetchModelInfo(model.name);
      }
    });
  }, [localModels, modelInfoCache, fetchModelInfo]);

  const handlePull = async (name) => {
    try {
      await pullModel(name);
      setShowPullDialog(false);
    } catch (err) {
      // Error is handled in store
    }
  };

  const handleDelete = async () => {
    if (deleteConfirm) {
      await deleteModel(deleteConfirm);
      if (defaultModel === deleteConfirm) {
        updateSetting("defaultModel", "");
      }
      setDeleteConfirm(null);
    }
  };

  const handleSelect = (name) => {
    updateSetting("defaultModel", name);
  };

  return (
    <div className="model-manager">
      <div className="model-manager-header">
        <h2 className="model-manager-title">Models</h2>
        <div className="model-manager-actions">
          <Button variant="secondary" onClick={() => setShowHardwareGuide(true)}>
            Check Hardware
          </Button>
          <Button variant="ghost" onClick={fetchModels} disabled={isLoading}>
            Refresh
          </Button>
          <Button onClick={() => setShowPullDialog(true)}>
            Pull Model
          </Button>
        </div>
      </div>

      {error && (
        <div className="model-manager-error">
          <span>{error}</span>
          <button className="model-manager-error-close" onClick={clearError}>
            ×
          </button>
        </div>
      )}

      {isLoading && localModels.length === 0 ? (
        <div className="model-manager-empty">Loading models...</div>
      ) : localModels.length === 0 ? (
        <div className="model-manager-empty">
          <p className="model-manager-empty-icon"></p>
          <h3>No models found</h3>
          <p>Pull a model to get started.</p>
        </div>
      ) : (
        <div className="model-grid">
          {localModels.map((model) => (
            <ModelCard
              key={model.name}
              model={model}
              modelInfo={modelInfoCache[model.name]}
              isSelected={defaultModel === model.name}
              onSelect={handleSelect}
              onDelete={setDeleteConfirm}
            />
          ))}
        </div>
      )}

      <ModelPullDialog
        isOpen={showPullDialog}
        onClose={() => setShowPullDialog(false)}
        onPull={handlePull}
        pullProgress={pullProgress}
        localModels={localModels}
      />

      <ConfirmModal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDelete}
        title="Delete Model"
        message={`Are you sure you want to delete "${deleteConfirm}"? This cannot be undone.`}
        confirmText="Delete"
      />

      <HardwareGuideModal
        isOpen={showHardwareGuide}
        onClose={() => setShowHardwareGuide(false)}
      />
    </div>
  );
}
