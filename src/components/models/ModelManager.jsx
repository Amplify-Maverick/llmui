import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useImageStore } from "../../stores/imageStore.js";
import TextModelManager from "./TextModelManager.jsx";
import Button from "../shared/Button.jsx";
import "./ModelManager.css";

export default function ModelManager() {
  const { isLoading, error, fetchModels, clearError } = useModelsStore();

  const {
    checkpoints,
    serverUrl,
    connectionError,
    isConnected: sdConnected,
    fetchAll: fetchImageModels,
  } = useImageStore();

  const [subTab, setSubTab] = useState("text"); // "text" | "image"

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
              Image (sd-server)
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

      {/* ── Image Models (stable-diffusion.cpp sd-server) ───── */}
      {subTab === "image" && (
        <>
          {!sdConnected ? (
            <div className="model-manager-empty">
              <h3>sd-server Not Reachable</h3>
              <p>
                {connectionError || "Check the url in ~/.llmui/sd_config.json on the LLMUI server."}
              </p>
              <Button
                variant="secondary"
                onClick={fetchImageModels}
                style={{ marginTop: 12 }}
              >
                Retry Connection
              </Button>
            </div>
          ) : (
            <div className="image-models-sections">
              <div className="image-models-section">
                <h3 className="image-models-section-title">
                  Checkpoints
                  <span className="image-models-count">{checkpoints.length}</span>
                </h3>
                {checkpoints.length === 0 ? (
                  <p className="image-models-none">
                    No checkpoints found. Place .safetensors or .gguf files in
                    checkpoints/ under sd-server's --model-dir.
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
                <p className="image-models-none">
                  Served by {serverUrl || "sd-server"}. The SD model is loaded only for
                  the length of each image job, after chat models are unloaded.
                </p>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
