import { useEffect, useState } from "react";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useImageStore } from "../../stores/imageStore.js";
import { useMachinesStore } from "../../stores/machinesStore.js";
import TextModelManager from "./TextModelManager.jsx";
import ImageModelManager from "./ImageModelManager.jsx";
import Button from "../shared/Button.jsx";
import "./ModelManager.css";

export default function ModelManager() {
  const { isLoading, error, fetchModels, clearError } = useModelsStore();

  const {
    connectionError,
    isConnected: sdConnected,
    fetchAll: fetchImageModels,
  } = useImageStore();

  const [subTab, setSubTab] = useState("text"); // "text" | "image"
  const [imageKey, setImageKey] = useState(0); // bump to reload the image tab

  // Everything on this page acts on the machine that kind of request goes to.
  // The managers remount when it changes, so nothing from the other machine
  // stays on screen (or gets acted on).
  const machineId = useMachinesStore((s) => s.effective[subTab === "image" ? "image" : "chat"]);
  const machine = useMachinesStore((s) => s.machines.find((m) => m.id === machineId));
  const fallingBack = useMachinesStore((s) => !!s.fallback[subTab === "image" ? "image" : "chat"]);

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
          {machine && (
            <span
              className={`model-manager-machine ${fallingBack ? "is-fallback" : ""}`}
              title={fallingBack ? "The selected machine is unreachable; showing the default machine" : "Change the machine on the System page"}
            >
              on <strong>{machine.name}</strong>
              <span className="model-manager-machine-gpu">{machine.gpuLabel}</span>
            </span>
          )}
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
              <Button
                variant="ghost"
                onClick={() => {
                  fetchImageModels();
                  setImageKey((k) => k + 1);
                }}
              >
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
      {subTab === "text" && <TextModelManager key={machineId || "none"} />}

      {/* ── Image Models (stable-diffusion.cpp sd-server) ───── */}
      {subTab === "image" && (
        <>
          {!sdConnected ? (
            <div className="model-manager-empty">
              <h3>{machine ? `${machine.name}'s sd-server is not reachable` : "sd-server not reachable"}</h3>
              <p>
                {connectionError || "Check that sd-server is running on that machine."}
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
            <ImageModelManager key={`${machineId}:${imageKey}`} />
          )}
        </>
      )}
    </div>
  );
}
