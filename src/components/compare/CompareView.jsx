import { useState, useEffect, useCallback } from "react";
import { useCompareStreams } from "../../hooks/useCompareStreams.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { fetchGpuStats } from "../../services/gpuApi.js";
import { fetchHardwareInfo, getAvailableCapacity } from "../../services/hardwareApi.js";
import { formatBytes } from "../../utils/formatters.js";
import CompareColumn from "./CompareColumn.jsx";
import MessageInput from "../chat/MessageInput.jsx";
import "./CompareView.css";

export default function CompareView({ models, onPickResponse, onSaveComplete }) {
  const [userPrompt, setUserPrompt] = useState(null);
  const [gpuVram, setGpuVram] = useState(null);
  const [hasGpu, setHasGpu] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const { streams, startCompare, stopAll, stopOne, reset, anyStreaming, allComplete } =
    useCompareStreams();

  const { localModels, runningModels } = useModelsStore();
  const { saveCompareConversation } = useChatStore();

  // Fetch available capacity on mount — the server actually running Ollama,
  // not the browser viewing this dashboard.
  useEffect(() => {
    const getCapacity = async () => {
      // Try live GPU stats first
      const stats = await fetchGpuStats();
      if (stats.ok && stats.gpus?.length > 0) {
        // Sum all GPU VRAM (MiB to bytes)
        const totalVram = stats.gpus.reduce((sum, gpu) => sum + gpu.memoryTotal, 0);
        setGpuVram(totalVram * 1024 * 1024);
        setHasGpu(true);
        return;
      }
      // No GPU on the server — fall back to its usable system RAM.
      const hardware = await fetchHardwareInfo();
      const capacityGb = getAvailableCapacity(hardware);
      if (capacityGb) {
        setGpuVram(capacityGb * 1024 ** 3);
      }
    };
    getCapacity();
  }, []);

  // Estimate VRAM for a model
  const estimateModelVram = useCallback(
    (modelName) => {
      // Check if model is currently running (has actual VRAM usage)
      const runningModel = runningModels.find((m) => m.name === modelName);
      if (runningModel?.size_vram) {
        return runningModel.size_vram;
      }
      // Fall back to disk size as estimate
      const localModel = localModels.find((m) => m.name === modelName);
      if (localModel?.size) {
        return localModel.size;
      }
      return 0;
    },
    [localModels, runningModels]
  );

  // Calculate total estimated VRAM
  const totalEstimatedVram = models.reduce(
    (sum, model) => sum + estimateModelVram(model),
    0
  );

  const showVramWarning = gpuVram && totalEstimatedVram > gpuVram;

  const handleSend = useCallback(
    (content) => {
      if (!content.trim() || models.length < 2) return;
      setUserPrompt(content.trim());
      startCompare(content.trim(), models);
    },
    [models, startCompare]
  );

  const handleStop = useCallback(() => {
    stopAll();
  }, [stopAll]);

  const handlePick = useCallback(
    (model, content, stats) => {
      if (onPickResponse) {
        onPickResponse(model, content, userPrompt, stats);
      }
    },
    [onPickResponse, userPrompt]
  );

  const handleNewComparison = useCallback(() => {
    reset();
    setUserPrompt(null);
  }, [reset]);

  const handleSave = useCallback(async () => {
    if (!userPrompt || streams.size === 0) return;
    setIsSaving(true);
    try {
      const id = await saveCompareConversation(userPrompt, streams, models);
      if (id && onSaveComplete) {
        onSaveComplete();
      }
    } finally {
      setIsSaving(false);
    }
  }, [userPrompt, streams, models, saveCompareConversation, onSaveComplete]);

  const hasStarted = userPrompt !== null;
  const canStartNew = allComplete && hasStarted;
  const canSave = allComplete && hasStarted && streams.size > 0;

  return (
    <div className="compare-view">
      {showVramWarning && (
        <div className="compare-vram-warning">
          <span className="compare-vram-warning-icon">!</span>
          <div className="compare-vram-warning-content">
            <strong>{hasGpu ? "VRAM" : "Memory"} Warning:</strong> Selected models may require{" "}
            {formatBytes(totalEstimatedVram)}, exceeding this server's{" "}
            {hasGpu ? "GPU VRAM" : "usable RAM"} of {formatBytes(gpuVram)}.{" "}
            {hasGpu
              ? "Ollama will swap models between GPU and RAM, reducing parallelism and speed."
              : "Running these together may be very slow or cause Ollama to swap models in and out."}
          </div>
        </div>
      )}

      {!hasStarted && models.length < 2 && (
        <div className="compare-empty">
          <div className="compare-empty-icon">⚖</div>
          <h3>Compare Models</h3>
          <p>Select at least 2 models from the dropdown above to compare their responses side by side.</p>
        </div>
      )}

      {!hasStarted && models.length >= 2 && (
        <div className="compare-ready">
          <div className="compare-ready-icon">⚖</div>
          <h3>Ready to Compare</h3>
          <p>
            Comparing <strong>{models.length}</strong> models:{" "}
            {models.map((m) => m.split(":")[0]).join(", ")}
          </p>
          <p className="compare-ready-hint">Type a prompt below to start the comparison</p>
        </div>
      )}

      {hasStarted && (
        <>
          <div className="compare-prompt">
            <div className="compare-prompt-label">Your prompt:</div>
            <div className="compare-prompt-content">{userPrompt}</div>
          </div>

          <div
            className="compare-columns"
            style={{ "--compare-column-count": models.length }}
          >
            {models.map((model) => (
              <CompareColumn
                key={model}
                model={model}
                streamState={streams.get(model)}
                onPick={handlePick}
                onStop={stopOne}
              />
            ))}
          </div>
        </>
      )}

      {canStartNew && (
        <div className="compare-new-section">
          <button
            className="compare-save-btn"
            onClick={handleSave}
            disabled={isSaving || !canSave}
          >
            {isSaving ? "Saving..." : "Save Comparison"}
          </button>
          <button className="compare-new-btn" onClick={handleNewComparison}>
            New Comparison
          </button>
        </div>
      )}

      {!hasStarted && (
        <MessageInput
          onSend={handleSend}
          onStop={handleStop}
          disabled={models.length < 2}
          isStreaming={anyStreaming}
        />
      )}

      {hasStarted && anyStreaming && (
        <div className="compare-stop-section">
          <button className="compare-stop-all-btn" onClick={handleStop}>
            Stop All
          </button>
        </div>
      )}
    </div>
  );
}
