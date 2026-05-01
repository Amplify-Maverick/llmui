import { useEffect, useState, useRef } from "react";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useChatStore } from "../../stores/chatStore.js";
import { AVAILABLE_TOOLS } from "../../constants/config.js";
import { TextArea, Select } from "../shared/Input.jsx";
import "./SettingsPanel.css";

export default function SettingsPanel() {
  const {
    systemPrompt,
    temperature,
    maxTokens,
    ollamaUrl,
    ollamaUrlLoading,
    ollamaUrlError,
    comfyuiUrl,
    comfyuiUrlLoading,
    comfyuiUrlError,
    comfyModelsPath,
    comfyModelsPathLoading,
    comfyModelsPathError,
    defaultModel,
    enableThinking,
    enableTools,
    enabledTools,
    theme,
    updateSetting,
    updateOllamaUrl,
    updateComfyuiUrl,
    updateComfyModelsPath,
  } = useSettingsStore();

  const { localModels, fetchModels } = useModelsStore();
  const { loadConversations } = useChatStore();

  // Local state for the URL inputs so we can edit without saving on every keystroke
  const [urlInput, setUrlInput] = useState(ollamaUrl);
  const [urlSaved, setUrlSaved] = useState(false);
  const [comfyUrlInput, setComfyUrlInput] = useState(comfyuiUrl);
  const [comfyUrlSaved, setComfyUrlSaved] = useState(false);
  const [modelsPathInput, setModelsPathInput] = useState(comfyModelsPath);
  const [modelsPathSaved, setModelsPathSaved] = useState(false);
  const [importStatus, setImportStatus] = useState(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    setUrlInput(ollamaUrl);
  }, [ollamaUrl]);

  useEffect(() => {
    setComfyUrlInput(comfyuiUrl);
  }, [comfyuiUrl]);

  useEffect(() => {
    setModelsPathInput(comfyModelsPath);
  }, [comfyModelsPath]);

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const handleUrlSave = async () => {
    if (urlInput === ollamaUrl) return;
    setUrlSaved(false);
    try {
      await updateOllamaUrl(urlInput);
      setUrlSaved(true);
      // Refresh models from the new URL
      fetchModels();
      setTimeout(() => setUrlSaved(false), 2000);
    } catch {
      // Error is set in the store
    }
  };

  const modelOptions = localModels.map((m) => ({
    value: m.name,
    label: m.name,
  }));

  const handleImport = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;

    setImportStatus({ loading: true });

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const data = JSON.parse(event.target.result);

        // Handle both formats: { conversations: [...] } or direct array
        const conversations = data.conversations || (Array.isArray(data) ? data : null);

        if (!conversations || !Array.isArray(conversations)) {
          throw new Error('Invalid format: expected conversations array');
        }

        const response = await fetch('/api/import', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('llmui_token')}`
          },
          body: JSON.stringify({ conversations })
        });

        if (!response.ok) {
          throw new Error('Import failed');
        }

        const result = await response.json();
        setImportStatus({
          success: true,
          message: `Imported ${result.imported} conversation${result.imported !== 1 ? 's' : ''}${result.errors?.length > 0 ? ` (${result.errors.length} failed)` : ''}`
        });

        // Refresh conversation list
        loadConversations();

        // Clear status after 3 seconds
        setTimeout(() => setImportStatus(null), 3000);
      } catch (err) {
        setImportStatus({ error: err.message });
        setTimeout(() => setImportStatus(null), 3000);
      }
    };

    reader.onerror = () => {
      setImportStatus({ error: 'Failed to read file' });
      setTimeout(() => setImportStatus(null), 3000);
    };

    reader.readAsText(file);

    // Reset file input
    e.target.value = '';
  };

  return (
    <div className="settings">
      <h2 className="settings-title">Settings</h2>

      <div className="settings-section">
        <label className="settings-label">Theme</label>
        <div className="settings-theme-toggle">
          <button
            className={`settings-theme-btn ${theme === 'light' ? 'active' : ''}`}
            onClick={() => updateSetting('theme', 'light')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            Light
          </button>
          <button
            className={`settings-theme-btn ${theme === 'dark' ? 'active' : ''}`}
            onClick={() => updateSetting('theme', 'dark')}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
            Dark
          </button>
        </div>
        <p className="settings-description">
          Choose between light and dark appearance.
        </p>
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <label className="settings-label">Ollama Server URL</label>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1 }}
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleUrlSave()}
            placeholder="http://localhost:11434"
            disabled={ollamaUrlLoading}
          />
          <button
            className="btn btn-sm"
            onClick={handleUrlSave}
            disabled={ollamaUrlLoading || urlInput === ollamaUrl}
            style={{ whiteSpace: "nowrap" }}
          >
            {ollamaUrlLoading ? "Saving..." : "Save"}
          </button>
        </div>
        {ollamaUrlError && (
          <p className="settings-description" style={{ color: "#f87171" }}>
            Error: {ollamaUrlError}
          </p>
        )}
        {urlSaved && (
          <p className="settings-description" style={{ color: "#6ee7b7" }}>
            Ollama URL updated successfully.
          </p>
        )}
        <p className="settings-description">
          The URL where your Ollama server is running. This is configured on the
          server and all API calls are proxied through the authenticated backend.
        </p>
      </div>

      <div className="settings-section">
        <label className="settings-label">ComfyUI Server URL</label>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1 }}
            value={comfyUrlInput}
            onChange={(e) => setComfyUrlInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && comfyUrlInput !== comfyuiUrl) {
                setComfyUrlSaved(false);
                updateComfyuiUrl(comfyUrlInput)
                  .then(() => {
                    setComfyUrlSaved(true);
                    setTimeout(() => setComfyUrlSaved(false), 2000);
                  })
                  .catch(() => {});
              }
            }}
            placeholder="http://localhost:8188"
            disabled={comfyuiUrlLoading}
          />
          <button
            className="btn btn-sm"
            onClick={async () => {
              if (comfyUrlInput === comfyuiUrl) return;
              setComfyUrlSaved(false);
              try {
                await updateComfyuiUrl(comfyUrlInput);
                setComfyUrlSaved(true);
                setTimeout(() => setComfyUrlSaved(false), 2000);
              } catch {
                // Error is set in the store
              }
            }}
            disabled={comfyuiUrlLoading || comfyUrlInput === comfyuiUrl}
            style={{ whiteSpace: "nowrap" }}
          >
            {comfyuiUrlLoading ? "Saving..." : "Save"}
          </button>
        </div>
        {comfyuiUrlError && (
          <p className="settings-description" style={{ color: "#f87171" }}>
            Error: {comfyuiUrlError}
          </p>
        )}
        {comfyUrlSaved && (
          <p className="settings-description" style={{ color: "#6ee7b7" }}>
            ComfyUI URL updated successfully.
          </p>
        )}
        <p className="settings-description">
          The URL where your ComfyUI server is running for image generation.
          ComfyUI must be installed and running separately.
        </p>
      </div>

      <div className="settings-section">
        <label className="settings-label">ComfyUI Models Path</label>
        <div style={{ display: "flex", gap: "0.5rem", alignItems: "center" }}>
          <input
            className="input"
            style={{ flex: 1 }}
            value={modelsPathInput}
            onChange={(e) => setModelsPathInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && modelsPathInput !== comfyModelsPath) {
                setModelsPathSaved(false);
                updateComfyModelsPath(modelsPathInput)
                  .then(() => {
                    setModelsPathSaved(true);
                    setTimeout(() => setModelsPathSaved(false), 2000);
                  })
                  .catch(() => {});
              }
            }}
            placeholder="/path/to/ComfyUI/models"
            disabled={comfyModelsPathLoading}
          />
          <button
            className="btn btn-sm"
            onClick={async () => {
              if (modelsPathInput === comfyModelsPath) return;
              setModelsPathSaved(false);
              try {
                await updateComfyModelsPath(modelsPathInput);
                setModelsPathSaved(true);
                setTimeout(() => setModelsPathSaved(false), 2000);
              } catch {
                // Error is set in the store
              }
            }}
            disabled={comfyModelsPathLoading || modelsPathInput === comfyModelsPath}
            style={{ whiteSpace: "nowrap" }}
          >
            {comfyModelsPathLoading ? "Saving..." : "Save"}
          </button>
        </div>
        {comfyModelsPathError && (
          <p className="settings-description" style={{ color: "#f87171" }}>
            Error: {comfyModelsPathError}
          </p>
        )}
        {modelsPathSaved && (
          <p className="settings-description" style={{ color: "#6ee7b7" }}>
            Models path updated successfully.
          </p>
        )}
        <p className="settings-description">
          The absolute path to your ComfyUI models directory (e.g., /home/user/ComfyUI/models).
          Required for downloading models from Civitai. The server must have write access to this directory.
        </p>
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <label className="settings-label">Default Model</label>
        <Select
          value={defaultModel}
          onChange={(e) => updateSetting("defaultModel", e.target.value)}
          options={modelOptions}
          placeholder="Select a default model"
        />
        <p className="settings-description">
          The model to use for new conversations.
        </p>
      </div>

      <div className="settings-section">
        <label className="settings-label">System Prompt</label>
        <TextArea
          value={systemPrompt}
          onChange={(e) => updateSetting("systemPrompt", e.target.value)}
          placeholder="You are a helpful assistant..."
          rows={4}
        />
        <p className="settings-description">
          This prompt is sent at the beginning of every conversation.
        </p>
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <label className="settings-label">Temperature: {temperature}</label>
        <div className="settings-slider-row">
          <input
            className="settings-slider"
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) =>
              updateSetting("temperature", parseFloat(e.target.value))
            }
          />
          <span className="settings-slider-value">{temperature}</span>
        </div>
        <p className="settings-description">
          Lower values make responses more focused; higher values make them more creative.
        </p>
      </div>

      <div className="settings-section">
        <label className="settings-label">Max Tokens: {maxTokens}</label>
        <div className="settings-slider-row">
          <input
            className="settings-slider"
            type="range"
            min="256"
            max="32768"
            step="256"
            value={maxTokens}
            onChange={(e) =>
              updateSetting("maxTokens", parseInt(e.target.value))
            }
          />
          <span className="settings-slider-value">{maxTokens}</span>
        </div>
        <p className="settings-description">
          Maximum number of tokens for each response.
        </p>
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={enableThinking}
            onChange={(e) => updateSetting("enableThinking", e.target.checked)}
            className="settings-checkbox"
          />
          <span className="settings-label">Enable Thinking Mode</span>
        </label>
        <p className="settings-description">
          Enables extended reasoning for models that support it (e.g., DeepSeek-R1, QwQ).
          The model will show its thought process before answering.
        </p>
      </div>

      <div className="settings-divider" />

      <div className="settings-section">
        <label className="settings-toggle-row">
          <input
            type="checkbox"
            checked={enableTools}
            onChange={(e) => updateSetting("enableTools", e.target.checked)}
            className="settings-checkbox"
          />
          <span className="settings-label">Enable Tool Calling</span>
        </label>
        <p className="settings-description">
          Allow models to use tools like web search, URL fetching, and calculations.
          Only works with models that support tool calling (Llama 3.1+, Qwen 2.5+, Mistral, etc.).
        </p>
      </div>

      {enableTools && (
        <div className="settings-section">
          <label className="settings-label">Enabled Tools</label>
          <div className="settings-tools-list">
            {AVAILABLE_TOOLS.map((tool) => (
              <label key={tool.name} className="settings-toggle-row settings-tool-item">
                <input
                  type="checkbox"
                  checked={enabledTools?.includes(tool.name) ?? false}
                  onChange={(e) => {
                    const newTools = e.target.checked
                      ? [...(enabledTools || []), tool.name]
                      : (enabledTools || []).filter((t) => t !== tool.name);
                    updateSetting("enabledTools", newTools);
                  }}
                  className="settings-checkbox"
                />
                <div className="settings-tool-info">
                  <span className="settings-tool-name">{tool.displayName}</span>
                  <span className="settings-tool-desc">{tool.description}</span>
                </div>
              </label>
            ))}
          </div>
        </div>
      )}

      <div className="settings-divider" />

      <div className="settings-section">
        <label className="settings-label">Import Conversations</label>
        <input
          type="file"
          accept=".json"
          onChange={handleImport}
          ref={fileInputRef}
          style={{ display: 'none' }}
        />
        <button
          className="btn"
          onClick={() => fileInputRef.current?.click()}
          disabled={importStatus?.loading}
        >
          {importStatus?.loading ? 'Importing...' : 'Choose JSON File'}
        </button>
        {importStatus?.success && (
          <p className="settings-description" style={{ color: '#6ee7b7' }}>
            {importStatus.message}
          </p>
        )}
        {importStatus?.error && (
          <p className="settings-description" style={{ color: '#f87171' }}>
            Error: {importStatus.error}
          </p>
        )}
        <p className="settings-description">
          Import conversations from a previously exported JSON file. All imported conversations
          will be assigned new IDs to avoid conflicts.
        </p>
      </div>
    </div>
  );
}
