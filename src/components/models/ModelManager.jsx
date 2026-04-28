import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import ModelCard from "./ModelCard.jsx";
import ModelPullDialog from "./ModelPullDialog.jsx";
import HardwareGuideModal from "./HardwareGuideModal.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";

const containerStyle = {
  padding: "20px",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "24px",
};

const titleStyle = {
  fontSize: "20px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: 0,
};

const gridStyle = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
  gap: "16px",
};

const emptyStateStyle = {
  textAlign: "center",
  padding: "60px 20px",
  color: "#8a8a9a",
};

const errorStyle = {
  background: "rgba(255, 107, 107, 0.1)",
  border: "1px solid rgba(255, 107, 107, 0.3)",
  borderRadius: "8px",
  padding: "12px 16px",
  color: "#ff6b6b",
  marginBottom: "16px",
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
};

export default function ModelManager() {
  const {
    localModels,
    isLoading,
    error,
    pullProgress,
    fetchModels,
    pullModel,
    deleteModel,
    clearError,
  } = useModelsStore();

  const { defaultModel, updateSetting } = useSettingsStore();

  const [showPullDialog, setShowPullDialog] = useState(false);
  const [showHardwareGuide, setShowHardwareGuide] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [pullModelName, setPullModelName] = useState("");

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

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
    <div style={containerStyle}>
      <div style={headerStyle}>
        <h2 style={titleStyle}>Models</h2>
        <div style={{ display: "flex", gap: "12px" }}>
          <Button variant="secondary" onClick={() => setShowHardwareGuide(true)}>
            Check Hardware
          </Button>
          <Button variant="ghost" onClick={fetchModels} disabled={isLoading}>
            Refresh
          </Button>
          <Button onClick={() => { setPullModelName(""); setShowPullDialog(true); }}>Pull Model</Button>
        </div>
      </div>

      {error && (
        <div style={errorStyle}>
          <span>{error}</span>
          <button
            onClick={clearError}
            style={{
              background: "none",
              border: "none",
              color: "#ff6b6b",
              cursor: "pointer",
              fontSize: "18px",
            }}
          >
            ×
          </button>
        </div>
      )}

      {isLoading && localModels.length === 0 ? (
        <div style={emptyStateStyle}>Loading models...</div>
      ) : localModels.length === 0 ? (
        <div style={emptyStateStyle}>
          <p style={{ fontSize: "48px", marginBottom: "16px" }}>📦</p>
          <h3 style={{ color: "#e8e8f0", margin: "0 0 8px 0" }}>No models found</h3>
          <p>Pull a model to get started.</p>
        </div>
      ) : (
        <div style={gridStyle}>
          {localModels.map((model) => (
            <ModelCard
              key={model.name}
              model={model}
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
        initialModelName={pullModelName}
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
        onInstallModel={(model) => {
          setShowHardwareGuide(false);
          setPullModelName(model);
          setShowPullDialog(true);
        }}
      />
    </div>
  );
}
