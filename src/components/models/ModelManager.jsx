import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useImageStore } from "../../stores/imageStore.js";
import TextModelManager from "./TextModelManager.jsx";
import CivitaiModelBrowser from "./CivitaiModelBrowser.jsx";
import Button from "../shared/Button.jsx";
import "./ModelManager.css";

export default function ModelManager() {
  const { isLoading, error, fetchModels, clearError } = useModelsStore();

  const {
    checkpoints,
    loras,
    isConnected: comfyConnected,
    fetchAll: fetchImageModels,
    checkConnection: checkComfyConnection,
  } = useImageStore();

  const { comfyModelsPath } = useSettingsStore();

  const [subTab, setSubTab] = useState("text"); // "text" | "image"
  const [showCivitaiBrowser, setShowCivitaiBrowser] = useState(false);

  // Fetch image models when switching to image sub-tab
  useEffect(() => {
    if (subTab === "image") {
      fetchImageModels();
    }
  }, [subTab, fetchImageModels]);

  return (
    <div className="model-manager">
      <div className="model-manager-header">
        <div className="model-manager-header-left">
          <h2 className="model-manager-title">Models</h2>
          <div className="model-manager-subtabs">
            <button
              className={`model-subtab ${subTab === "text" ? "active" : ""}`}
              onClick={() => setSubTab("text")}
            >
              Text (llama.cpp)
            </button>
            <button
              className={`model-subtab ${subTab === "image" ? "active" : ""}`}
              onClick={() => setSubTab("image")}
            >
              Image (ComfyUI)
            </button>
          </div>
        </div>
        <div className="model-manager-actions">
          {subTab === "text" && (
            <>
              <Button variant="ghost" onClick={fetchModels} disabled={isLoading}>
                Refresh
              </Button>
            </>
          )}
          {subTab === "image" && (
            <>
              <Button variant="ghost" onClick={fetchImageModels}>
                Refresh
              </Button>
              <Button onClick={() => setShowCivitaiBrowser(true)}>
                Download Model
              </Button>
            </>
          )}
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

      {/* ── Text Models (llama.cpp router) ────────── */}
      {subTab === "text" && <TextModelManager />}

      {/* ── Image Models (ComfyUI) ───────────────────────────── */}
      {subTab === "image" && (
        <>
          {!comfyConnected ? (
            <div className="model-manager-empty">
              <h3>ComfyUI Not Connected</h3>
              <p>
                Configure the ComfyUI URL in Settings to manage image generation
                models.
              </p>
              <Button
                variant="secondary"
                onClick={checkComfyConnection}
                style={{ marginTop: 12 }}
              >
                Retry Connection
              </Button>
            </div>
          ) : (
            <div className="image-models-sections">
              {/* Checkpoints */}
              <div className="image-models-section">
                <h3 className="image-models-section-title">
                  Checkpoints
                  <span className="image-models-count">{checkpoints.length}</span>
                </h3>
                {checkpoints.length === 0 ? (
                  <p className="image-models-none">
                    No checkpoints found. Place .safetensors files in your ComfyUI
                    models/checkpoints directory.
                  </p>
                ) : (
                  <div className="image-models-list">
                    {checkpoints.map((name) => (
                      <div key={name} className="image-model-item">
                        <div className="image-model-icon">🖼️</div>
                        <div className="image-model-name">{name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* LoRAs */}
              <div className="image-models-section">
                <h3 className="image-models-section-title">
                  LoRAs
                  <span className="image-models-count">{loras.length}</span>
                </h3>
                {loras.length === 0 ? (
                  <p className="image-models-none">
                    No LoRAs found. Place .safetensors files in your ComfyUI
                    models/loras directory.
                  </p>
                ) : (
                  <div className="image-models-list">
                    {loras.map((name) => (
                      <div key={name} className="image-model-item">
                        <div className="image-model-icon">🎨</div>
                        <div className="image-model-name">{name}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}
        </>
      )}

      <CivitaiModelBrowser
        isOpen={showCivitaiBrowser}
        onClose={() => {
          setShowCivitaiBrowser(false);
          // Refresh image models after closing browser (in case new models were downloaded)
          if (comfyConnected) fetchImageModels();
        }}
        modelsPath={comfyModelsPath}
      />
    </div>
  );
}
