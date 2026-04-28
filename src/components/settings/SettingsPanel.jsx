import { useEffect } from "react";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import Input, { TextArea, Select } from "../shared/Input.jsx";
import Button from "../shared/Button.jsx";

const containerStyle = {
  padding: "20px",
  maxWidth: "600px",
};

const titleStyle = {
  fontSize: "20px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: "0 0 24px 0",
};

const sectionStyle = {
  marginBottom: "24px",
};

const labelStyle = {
  display: "block",
  fontSize: "14px",
  fontWeight: "500",
  color: "#e8e8f0",
  marginBottom: "8px",
};

const descriptionStyle = {
  fontSize: "13px",
  color: "#8a8a9a",
  marginTop: "6px",
};

const sliderContainerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "16px",
};

const sliderStyle = {
  flex: 1,
  height: "4px",
  appearance: "none",
  background: "rgba(255,255,255,0.1)",
  borderRadius: "2px",
  outline: "none",
};

const sliderValueStyle = {
  fontFamily: "'DM Mono', monospace",
  fontSize: "14px",
  color: "#6ee7b7",
  minWidth: "40px",
  textAlign: "right",
};

const dividerStyle = {
  height: "1px",
  background: "rgba(255,255,255,0.06)",
  margin: "32px 0",
};

export default function SettingsPanel() {
  const {
    ollamaBaseUrl,
    defaultModel,
    systemPrompt,
    temperature,
    maxTokens,
    updateSetting,
    resetSettings,
  } = useSettingsStore();

  const { localModels, fetchModels } = useModelsStore();

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  const modelOptions = localModels.map((m) => ({
    value: m.name,
    label: m.name,
  }));

  return (
    <div style={containerStyle}>
      <h2 style={titleStyle}>Settings</h2>

      <div style={sectionStyle}>
        <label style={labelStyle}>Ollama Server URL</label>
        <Input
          value={ollamaBaseUrl}
          onChange={(e) => updateSetting("ollamaBaseUrl", e.target.value)}
          placeholder="http://localhost:11434"
        />
        <p style={descriptionStyle}>
          The URL of your Ollama server. Default is http://localhost:11434
        </p>
      </div>

      <div style={sectionStyle}>
        <label style={labelStyle}>Default Model</label>
        <Select
          value={defaultModel}
          onChange={(e) => updateSetting("defaultModel", e.target.value)}
          options={modelOptions}
          placeholder="Select a model"
        />
        <p style={descriptionStyle}>
          The model to use for new conversations.
        </p>
      </div>

      <div style={sectionStyle}>
        <label style={labelStyle}>System Prompt</label>
        <TextArea
          value={systemPrompt}
          onChange={(e) => updateSetting("systemPrompt", e.target.value)}
          placeholder="You are a helpful assistant..."
          rows={4}
        />
        <p style={descriptionStyle}>
          Instructions that will be sent with every message.
        </p>
      </div>

      <div style={dividerStyle} />

      <div style={sectionStyle}>
        <label style={labelStyle}>Temperature: {temperature}</label>
        <div style={sliderContainerStyle}>
          <input
            type="range"
            min="0"
            max="2"
            step="0.1"
            value={temperature}
            onChange={(e) => updateSetting("temperature", parseFloat(e.target.value))}
            style={sliderStyle}
          />
          <span style={sliderValueStyle}>{temperature.toFixed(1)}</span>
        </div>
        <p style={descriptionStyle}>
          Controls randomness. Lower values are more focused, higher values are more creative.
        </p>
      </div>

      <div style={sectionStyle}>
        <label style={labelStyle}>Max Tokens</label>
        <Input
          type="number"
          value={maxTokens}
          onChange={(e) => updateSetting("maxTokens", parseInt(e.target.value) || 2048)}
          placeholder="2048"
        />
        <p style={descriptionStyle}>
          Maximum number of tokens to generate in a response.
        </p>
      </div>

      <div style={dividerStyle} />

      <Button variant="danger" onClick={resetSettings}>
        Reset to Defaults
      </Button>
    </div>
  );
}
