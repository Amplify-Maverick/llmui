import { useSettingsStore } from "../../stores/settingsStore.js";
import { TextArea } from "../shared/Input.jsx";
import "./SettingsPanel.css";

export default function SettingsPanel() {
  const {
    systemPrompt,
    temperature,
    maxTokens,
    ollamaBaseUrl,
    enableThinking,
    updateSetting,
  } = useSettingsStore();

  return (
    <div className="settings">
      <h2 className="settings-title">Settings</h2>

      <div className="settings-section">
        <label className="settings-label">Ollama Server URL</label>
        <input
          className="input"
          value={ollamaBaseUrl}
          onChange={(e) => updateSetting("ollamaBaseUrl", e.target.value)}
          placeholder="http://localhost:11434"
        />
        <p className="settings-description">
          The URL where your Ollama server is running.
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
    </div>
  );
}
