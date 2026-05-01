import { useEffect } from "react";
import { useImageStore } from "../../stores/imageStore.js";
import GenerationSettings from "./GenerationSettings.jsx";
import ImageDisplay from "./ImageDisplay.jsx";
import ImageHistory from "./ImageHistory.jsx";
import GpuMini from "../stats/GpuMini.jsx";
import "./ImageGenerationView.css";

export default function ImageGenerationView() {
  const { isConnected, fetchAll, loadHistory } = useImageStore();

  useEffect(() => {
    fetchAll();
    loadHistory();
  }, [fetchAll, loadHistory]);

  return (
    <div className="image-gen-container">
      <div className="image-gen-header">
        <div className="image-gen-header-left">
          <span className="image-gen-header-title">Image Generation</span>
          <span className={`image-gen-status ${isConnected ? "connected" : "disconnected"}`}>
            <span className="image-gen-status-dot" />
            {isConnected ? "ComfyUI Connected" : "ComfyUI Disconnected"}
          </span>
        </div>
        <div className="image-gen-header-gpu">
          <GpuMini />
        </div>
      </div>

      <div className="image-gen-body">
        <aside className="image-gen-sidebar">
          <GenerationSettings />
        </aside>
        <main className="image-gen-main">
          <ImageDisplay />
        </main>
      </div>

      <div className="image-gen-history-bar">
        <ImageHistory />
      </div>
    </div>
  );
}
