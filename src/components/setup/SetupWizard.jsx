import { useState } from "react";
import { getAuthToken } from "../../services/auth.js";
import "./SetupWizard.css";

const TOTAL_STEPS = 3; // ollama · gpu · done

async function authFetch(path, options = {}) {
  const token = await getAuthToken();
  return fetch(path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
      ...(options.headers ?? {}),
    },
  });
}

// ── Step 1: Ollama ────────────────────────────────────────────────────────────

function StepOllama({ onNext }) {
  const [mode, setMode] = useState("local"); // "local" | "remote"
  const [url, setUrl] = useState("http://");
  const [testState, setTestState] = useState(null); // null | "testing" | {ok, message}
  const [saving, setSaving] = useState(false);

  const effectiveUrl = mode === "local" ? "http://localhost:11434" : url;

  async function testConnection() {
    setTestState("testing");
    try {
      const res = await authFetch("/api/setup/test-ollama", {
        method: "POST",
        body: JSON.stringify({ url: effectiveUrl }),
      });
      const data = await res.json();
      setTestState(data.ok
        ? { ok: true, message: `Connected — ${data.modelCount} model(s) available` }
        : { ok: false, message: data.error });
    } catch {
      setTestState({ ok: false, message: "Request failed — is the server running?" });
    }
  }

  async function handleNext() {
    setSaving(true);
    try {
      await authFetch("/ollama/config", {
        method: "PUT",
        body: JSON.stringify({ ollamaUrl: effectiveUrl }),
      });
      onNext({ ollamaUrl: effectiveUrl });
    } catch {
      // proceed anyway — user can fix in settings
      onNext({ ollamaUrl: effectiveUrl });
    } finally {
      setSaving(false);
    }
  }

  const canProceed = mode === "local" || (mode === "remote" && url.startsWith("http") && url.length > 8);

  return (
    <div className="setup-step">
      <h2 className="setup-step-title">Where is Ollama running?</h2>
      <p className="setup-step-desc">
        LLMUI needs to reach an Ollama instance to list and chat with models.
      </p>

      <div className="setup-options">
        <label className={`setup-option ${mode === "local" ? "selected" : ""}`}>
          <input type="radio" name="ollama-mode" value="local"
            checked={mode === "local"} onChange={() => { setMode("local"); setTestState(null); }} />
          <div className="setup-option-body">
            <span className="setup-option-label">This machine</span>
            <span className="setup-option-hint">Ollama is running locally — http://localhost:11434</span>
          </div>
        </label>

        <label className={`setup-option ${mode === "remote" ? "selected" : ""}`}>
          <input type="radio" name="ollama-mode" value="remote"
            checked={mode === "remote"} onChange={() => { setMode("remote"); setTestState(null); }} />
          <div className="setup-option-body">
            <span className="setup-option-label">Another server</span>
            <span className="setup-option-hint">Ollama is on a different machine (e.g. your GPU workstation)</span>
          </div>
        </label>
      </div>

      {mode === "remote" && (
        <div className="setup-url-row">
          <input
            className="setup-url-input"
            type="url"
            placeholder="http://100.x.x.x:11434"
            value={url}
            onChange={(e) => { setUrl(e.target.value); setTestState(null); }}
          />
          <button
            className="setup-test-btn"
            onClick={testConnection}
            disabled={testState === "testing" || !url.startsWith("http")}
          >
            {testState === "testing" ? "Testing…" : "Test"}
          </button>
        </div>
      )}

      {mode === "local" && (
        <div className="setup-url-row">
          <button
            className="setup-test-btn"
            style={{ marginLeft: "auto" }}
            onClick={testConnection}
            disabled={testState === "testing"}
          >
            {testState === "testing" ? "Testing…" : "Test connection"}
          </button>
        </div>
      )}

      {testState && testState !== "testing" && (
        <div className={`setup-status ${testState.ok ? "ok" : "error"}`}>
          {testState.ok ? "✓" : "✗"} {testState.message}
        </div>
      )}
      {testState === "testing" && (
        <div className="setup-status testing">Connecting…</div>
      )}

      <div className="setup-actions">
        <button
          className="setup-btn setup-btn-primary"
          onClick={handleNext}
          disabled={!canProceed || saving}
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

// ── Step 2: GPU stats ─────────────────────────────────────────────────────────

function StepGpu({ onNext, onBack }) {
  const [mode, setMode] = useState("none"); // "local" | "remote" | "none"
  const [url, setUrl] = useState("http://");
  const [testState, setTestState] = useState(null);
  const [saving, setSaving] = useState(false);

  async function testConnection() {
    setTestState("testing");
    try {
      const res = await authFetch("/api/setup/test-gpu", {
        method: "POST",
        body: JSON.stringify({ url }),
      });
      const data = await res.json();
      setTestState(data.ok
        ? { ok: true, message: `Connected — ${data.gpuCount ?? "?"} GPU(s) detected` }
        : { ok: false, message: data.error });
    } catch {
      setTestState({ ok: false, message: "Request failed" });
    }
  }

  async function handleNext() {
    setSaving(true);
    const remoteGpuUrl = mode === "remote" ? url : null;
    try {
      await authFetch("/api/gpu-config", {
        method: "PUT",
        body: JSON.stringify({ remoteGpuUrl }),
      });
    } catch {
      // proceed anyway
    } finally {
      setSaving(false);
    }
    onNext({ remoteGpuUrl });
  }

  const canProceed =
    mode === "local" ||
    mode === "none" ||
    (mode === "remote" && url.startsWith("http") && url.length > 8);

  return (
    <div className="setup-step">
      <h2 className="setup-step-title">GPU monitoring</h2>
      <p className="setup-step-desc">
        LLMUI can show live GPU utilization and VRAM usage. Where is the GPU?
      </p>

      <div className="setup-options">
        <label className={`setup-option ${mode === "local" ? "selected" : ""}`}>
          <input type="radio" name="gpu-mode" value="local"
            checked={mode === "local"} onChange={() => { setMode("local"); setTestState(null); }} />
          <div className="setup-option-body">
            <span className="setup-option-label">This machine</span>
            <span className="setup-option-hint">GPU is in this server — nvidia-smi runs locally</span>
          </div>
        </label>

        <label className={`setup-option ${mode === "remote" ? "selected" : ""}`}>
          <input type="radio" name="gpu-mode" value="remote"
            checked={mode === "remote"} onChange={() => { setMode("remote"); setTestState(null); }} />
          <div className="setup-option-body">
            <span className="setup-option-label">Another server</span>
            <span className="setup-option-hint">
              GPU is on a remote machine. Run the GPU stats server there first:
            </span>
          </div>
        </label>

        {mode === "remote" && (
          <>
            <pre className="setup-code">npm run gpu-stats   # on the GPU machine</pre>
            <div className="setup-url-row">
              <input
                className="setup-url-input"
                type="url"
                placeholder="http://100.x.x.x:3002"
                value={url}
                onChange={(e) => { setUrl(e.target.value); setTestState(null); }}
              />
              <button
                className="setup-test-btn"
                onClick={testConnection}
                disabled={testState === "testing" || !url.startsWith("http")}
              >
                {testState === "testing" ? "Testing…" : "Test"}
              </button>
            </div>
          </>
        )}

        <label className={`setup-option ${mode === "none" ? "selected" : ""}`}>
          <input type="radio" name="gpu-mode" value="none"
            checked={mode === "none"} onChange={() => { setMode("none"); setTestState(null); }} />
          <div className="setup-option-body">
            <span className="setup-option-label">Skip for now</span>
            <span className="setup-option-hint">You can configure this later in Settings</span>
          </div>
        </label>
      </div>

      {testState && testState !== "testing" && (
        <div className={`setup-status ${testState.ok ? "ok" : "error"}`}>
          {testState.ok ? "✓" : "✗"} {testState.message}
        </div>
      )}
      {testState === "testing" && (
        <div className="setup-status testing">Connecting…</div>
      )}

      <div className="setup-actions">
        <button className="setup-btn setup-btn-secondary" onClick={onBack}>Back</button>
        <button
          className="setup-btn setup-btn-primary"
          onClick={handleNext}
          disabled={!canProceed || saving}
        >
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </div>
  );
}

// ── Step 3: Done ──────────────────────────────────────────────────────────────

function StepDone({ config, onFinish, finishing }) {
  return (
    <div className="setup-step">
      <div className="setup-done-icon">✓</div>
      <h2 className="setup-step-title">You're all set</h2>
      <p className="setup-step-desc">
        LLMUI is configured. Here's a summary of your setup:
      </p>

      <div className="setup-summary">
        <div className="setup-summary-row">
          <span className="setup-summary-label">Ollama</span>
          <span className="setup-summary-value">{config.ollamaUrl}</span>
        </div>
        <div className="setup-summary-row">
          <span className="setup-summary-label">GPU stats</span>
          <span className="setup-summary-value">
            {config.remoteGpuUrl ? config.remoteGpuUrl : "local / not configured"}
          </span>
        </div>
      </div>

      <p className="setup-step-desc" style={{ marginTop: 0 }}>
        You can change these any time in the Settings tab.
      </p>

      <div className="setup-actions">
        <button
          className="setup-btn setup-btn-primary"
          onClick={onFinish}
          disabled={finishing}
        >
          {finishing ? "Loading…" : "Open LLMUI"}
        </button>
      </div>
    </div>
  );
}

// ── Wizard shell ──────────────────────────────────────────────────────────────

export default function SetupWizard({ onComplete }) {
  const [step, setStep] = useState(0); // 0 = ollama, 1 = gpu, 2 = done
  const [config, setConfig] = useState({});
  const [finishing, setFinishing] = useState(false);

  function handleOllamaNext(data) {
    setConfig((c) => ({ ...c, ...data }));
    setStep(1);
  }

  function handleGpuNext(data) {
    setConfig((c) => ({ ...c, ...data }));
    setStep(2);
  }

  async function handleFinish() {
    setFinishing(true);
    try {
      await authFetch("/api/setup/complete", { method: "POST" });
    } catch {
      // mark complete failed — proceed anyway, user can re-run if needed
    }
    onComplete();
  }

  const progress = (step) => {
    const dots = [0, 1, 2].map((i) => {
      let cls = "setup-progress-dot";
      if (i < step) cls += " done";
      else if (i === step) cls += " active";
      return <div key={i} className={cls} />;
    });
    return (
      <div className="setup-progress">
        {dots[0]}
        <div className="setup-progress-line" />
        {dots[1]}
        <div className="setup-progress-line" />
        {dots[2]}
      </div>
    );
  };

  return (
    <div className="setup-wizard">
      <div className="setup-card">
        <div>
          <div className="setup-logo">
            <div className="setup-logo-icon" />
            <span className="setup-logo-text">LLMUI Setup</span>
          </div>
        </div>

        {progress(step)}

        {step === 0 && <StepOllama onNext={handleOllamaNext} />}
        {step === 1 && (
          <StepGpu
            onNext={handleGpuNext}
            onBack={() => setStep(0)}
          />
        )}
        {step === 2 && (
          <StepDone
            config={config}
            onFinish={handleFinish}
            finishing={finishing}
          />
        )}
      </div>
    </div>
  );
}
