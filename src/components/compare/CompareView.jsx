import { useState, useCallback, useMemo } from "react";
import { useCompareStreams } from "../../hooks/useCompareStreams.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { planCompare, shortModelName } from "../../utils/comparePlan.js";
import CompareColumn from "./CompareColumn.jsx";
import MessageInput from "../chat/MessageInput.jsx";
import "./CompareView.css";

export default function CompareView({ models, onPickResponse, onSaveComplete }) {
  const [userPrompt, setUserPrompt] = useState(null);
  const [isSaving, setIsSaving] = useState(false);
  const { streams, plan: runPlan, phase, startCompare, stopAll, stopOne, reset, anyStreaming, allComplete } =
    useCompareStreams();

  const { models: servedModels, gpu } = useModelsStore();
  const { saveCompareConversation } = useChatStore();

  // Preview of what will happen, from the store's latest router snapshot.
  // The run re-plans from a fresh snapshot when it starts.
  const previewPlan = useMemo(() => {
    if (models.length !== 2) return null;
    return planCompare(models.map((id) => servedModels.find((m) => m.name === id) || { name: id }), gpu);
  }, [models, servedModels, gpu]);
  const plan = runPlan || previewPlan;

  const handleSend = useCallback(
    (content) => {
      if (!content.trim() || models.length !== 2) return;
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
      {plan && <ComparePlanBanner plan={plan} models={models} phase={phase} />}

      {!hasStarted && models.length < 2 && (
        <div className="compare-empty">
          <div className="compare-empty-icon">⚖</div>
          <h3>Compare Models</h3>
          <p>Select 2 models from the dropdown above to compare their responses side by side.</p>
        </div>
      )}

      {!hasStarted && models.length === 2 && (
        <div className="compare-ready">
          <div className="compare-ready-icon">⚖</div>
          <h3>Ready to Compare</h3>
          <p>
            Comparing <strong>{shortModelName(models[0])}</strong> and <strong>{shortModelName(models[1])}</strong>
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
          disabled={models.length !== 2}
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

const GiB = 1024 ** 3;
const gib = (b) => (b == null ? "?" : `${(b / GiB).toFixed(1)} GiB`);

function ComparePlanBanner({ plan, models, phase }) {
  const [a, b] = models.map(shortModelName);
  const parallel = plan.mode === "parallel";
  return (
    <div className={`compare-plan ${parallel ? "parallel" : "sequential"}`}>
      <div className="compare-plan-head">
        <span className="compare-plan-mode">{parallel ? "Parallel" : "One at a time"}</span>
        <span className="compare-plan-reason">
          {plan.reason}
          {plan.total != null && (
            <>
              {": "}
              {gib(plan.needs[0])} + {gib(plan.needs[1])} = {gib(plan.total)} of {gib(plan.budget)} usable
            </>
          )}
        </span>
      </div>
      <div className="compare-plan-steps">
        {parallel
          ? `Load ${a} and ${b}, then run both at the same time. Each model's speed drops because they share the GPU.`
          : `Load ${a} and run it, unload it, then load ${b} and run it. Load time is shown separately and doesn't count toward each model's time.`}
      </div>
      {phase && <div className="compare-plan-phase">{phase}</div>}
    </div>
  );
}
