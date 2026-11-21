import { useImageStore } from "../../stores/imageStore.js";
import { useMachinesStore } from "../../stores/machinesStore.js";
import { useOtherMachineModels } from "../../stores/otherMachineModelsStore.js";
import "./GenerationSettings.css";

// SD 1.5 is trained at 512×512; larger sizes need an SDXL-class checkpoint.
const RESOLUTION_PRESETS = [
  { label: "512×512", w: 512, h: 512 },
  { label: "512×768", w: 512, h: 768 },
  { label: "768×512", w: 768, h: 512 },
  { label: "768×768", w: 768, h: 768 },
  { label: "1024×1024", w: 1024, h: 1024 },
  { label: "768×1344", w: 768, h: 1344 },
  { label: "1344×768", w: 1344, h: 768 },
];

export default function GenerationSettings() {
  const {
    params,
    checkpoints,
    samplers,
    schedulers,
    isConnected,
    isGenerating,
    progress,
    progressStep,
    progressTotalSteps,
    stage,
    stageMessage,
    error,
    updateParam,
    updateParams,
    generate,
    cancelGeneration,
    clearError,
    interruptedJob,
    retryInterrupted,
    dismissInterrupted,
  } = useImageStore();

  const imageMachine = useMachinesStore((s) => s.machines.find((m) => m.id === s.effective.image));
  // Checkpoints on the other machine(s): greyed, can't be picked here.
  const otherModels = useOtherMachineModels("image", checkpoints);
  const noModelsHere = isConnected && checkpoints.length === 0;
  const machineName = imageMachine?.name || "this machine";

  const handleRandomSeed = () => {
    updateParam("seed", -1);
  };

  const currentRes = `${params.width}×${params.height}`;

  return (
    <div className="gen-settings">
      {/* Prompt */}
      <div className="gen-field">
        <label className="gen-label">Prompt</label>
        <textarea
          className="gen-textarea"
          value={params.prompt}
          onChange={(e) => updateParam("prompt", e.target.value)}
          placeholder="A beautiful landscape, masterpiece, best quality..."
          rows={4}
          disabled={isGenerating}
        />
      </div>

      {/* Negative Prompt */}
      <div className="gen-field">
        <label className="gen-label">Negative Prompt</label>
        <textarea
          className="gen-textarea gen-textarea-sm"
          value={params.negativePrompt}
          onChange={(e) => updateParam("negativePrompt", e.target.value)}
          placeholder="low quality, blurry, deformed..."
          rows={2}
          disabled={isGenerating}
        />
      </div>

      <div className="gen-divider" />

      {/* Checkpoint */}
      <div className="gen-field">
        <label className="gen-label">Model</label>
        <select
          className="gen-select"
          value={params.checkpoint}
          onChange={(e) => updateParam("checkpoint", e.target.value)}
          disabled={isGenerating || (checkpoints.length === 0 && otherModels.length === 0)}
        >
          <option value="" disabled>
            {noModelsHere ? `No image models on ${machineName}` : "Select checkpoint..."}
          </option>
          {checkpoints.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
          {otherModels.map(({ machine, names }) => (
            <optgroup key={machine.id} label={`On ${machine.name}: select it on the System page`} disabled>
              {names.map((n) => (
                <option key={n} value={`other:${machine.id}:${n}`} disabled>{n}</option>
              ))}
            </optgroup>
          ))}
        </select>
        {noModelsHere && (
          <p className="gen-empty">
            No image models on {machineName}. Install one under Models → Image
            {otherModels.length > 0 && `, or select ${otherModels[0].machine.name} on the System page`}.
          </p>
        )}
      </div>

      {/* Sampler + Scheduler row */}
      <div className="gen-row">
        <div className="gen-field gen-field-half">
          <label className="gen-label">Sampler</label>
          <select
            className="gen-select"
            value={params.sampler}
            onChange={(e) => updateParam("sampler", e.target.value)}
            disabled={isGenerating}
          >
            {samplers.length === 0 && <option value={params.sampler}>{params.sampler}</option>}
            {samplers.map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
        <div className="gen-field gen-field-half">
          <label className="gen-label">Scheduler</label>
          <select
            className="gen-select"
            value={params.scheduler}
            onChange={(e) => updateParam("scheduler", e.target.value)}
            disabled={isGenerating}
          >
            <option value="">default</option>
            {schedulers.filter((s) => s !== "default").map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </div>
      </div>

      {/* Steps */}
      <div className="gen-field">
        <label className="gen-label">
          Steps: <span className="gen-value">{params.steps}</span>
        </label>
        <input
          type="range"
          className="gen-slider"
          min={1}
          max={150}
          value={params.steps}
          onChange={(e) => updateParam("steps", parseInt(e.target.value))}
          disabled={isGenerating}
        />
      </div>

      {/* CFG Scale */}
      <div className="gen-field">
        <label className="gen-label">
          CFG Scale: <span className="gen-value">{params.cfgScale}</span>
        </label>
        <input
          type="range"
          className="gen-slider"
          min={1}
          max={30}
          step={0.5}
          value={params.cfgScale}
          onChange={(e) => updateParam("cfgScale", parseFloat(e.target.value))}
          disabled={isGenerating}
        />
      </div>

      {/* Resolution */}
      <div className="gen-field">
        <label className="gen-label">Resolution</label>
        <div className="gen-resolution-grid">
          {RESOLUTION_PRESETS.map((r) => (
            <button
              key={r.label}
              className={`gen-resolution-btn ${currentRes === r.label ? "active" : ""}`}
              onClick={() => updateParams({ width: r.w, height: r.h })}
              disabled={isGenerating}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Seed */}
      <div className="gen-field">
        <label className="gen-label">Seed</label>
        <div className="gen-seed-row">
          <input
            type="number"
            className="gen-input"
            value={params.seed}
            onChange={(e) => {
            const v = parseInt(e.target.value, 10);
            updateParam("seed", Number.isNaN(v) ? -1 : v);
          }}
            disabled={isGenerating}
          />
          <button
            className="gen-seed-random"
            onClick={handleRandomSeed}
            disabled={isGenerating}
            title="Random seed"
          >
            🎲
          </button>
        </div>
        <span className="gen-hint">-1 for random</span>
      </div>

      {/* Batch Count */}
      <div className="gen-field">
        <label className="gen-label">
          Batch Count: <span className="gen-value">{params.batchCount}</span>
        </label>
        <input
          type="range"
          className="gen-slider"
          min={1}
          max={4}
          value={params.batchCount}
          onChange={(e) => updateParam("batchCount", parseInt(e.target.value))}
          disabled={isGenerating}
        />
      </div>

      <div className="gen-divider" />

      {/* Error */}
      {error && (
        <div className="gen-error">
          <span>{error}</span>
          <button className="gen-error-close" onClick={clearError}>×</button>
        </div>
      )}

      {/* A job cut off by a server restart */}
      {interruptedJob && !isGenerating && (
        <div className="gen-interrupted" role="status">
          <span className="gen-interrupted-label">Interrupted</span>
          <span className="gen-interrupted-text" title={interruptedJob.params?.prompt}>
            The server restarted while generating{interruptedJob.params?.prompt ? ` “${interruptedJob.params.prompt.slice(0, 60)}”` : ""}.
          </span>
          <div className="gen-interrupted-actions">
            <button className="gen-interrupted-retry" onClick={retryInterrupted} disabled={!interruptedJob.params || !isConnected}>
              Retry
            </button>
            <button className="gen-error-close" onClick={dismissInterrupted} aria-label="Dismiss">×</button>
          </div>
        </div>
      )}

      {/* Generate / Cancel */}
      {isGenerating ? (
        <div className="gen-progress-area">
          <div className="gen-progress-bar">
            <div
              className="gen-progress-fill"
              style={{ width: `${Math.round(progress * 100)}%` }}
            />
          </div>
          <span className="gen-progress-text">{progressLabel({ stage, stageMessage, progressStep, progressTotalSteps })}</span>
          <button className="gen-btn gen-btn-cancel" onClick={cancelGeneration}>
            Cancel
          </button>
        </div>
      ) : (
        <button
          className="gen-btn gen-btn-generate"
          onClick={generate}
          disabled={!isConnected || !params.prompt.trim() || !params.checkpoint || !checkpoints.includes(params.checkpoint)}
          title={noModelsHere ? `No image models on ${machineName}` : undefined}
        >
          ▶ Generate
        </button>
      )}
    </div>
  );
}

const STAGE_LABELS = {
  starting: "Starting…",
  freeing_gpu: "Unloading chat models…",
  loading_model: "Loading SD model…",
  queued: "Queued…",
  waiting: "Waiting for the GPU…",
  preparing: "Preparing…",
  conditioning: "Encoding prompt…",
  vae_decode: "Decoding image…",
  encoding: "Encoding PNG…",
};

export function progressLabel({ stage, stageMessage, progressStep, progressTotalSteps }) {
  if (stage === "sampling" && progressTotalSteps) return `Step ${progressStep}/${progressTotalSteps}`;
  return stageMessage || STAGE_LABELS[stage] || "Working…";
}
