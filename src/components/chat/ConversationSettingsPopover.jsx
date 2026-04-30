import { useState, useEffect, useRef } from 'react';
import { useChatStore } from '../../stores/chatStore.js';
import { useSettingsStore } from '../../stores/settingsStore.js';
import { AVAILABLE_TOOLS } from '../../constants/config.js';
import './ConversationSettingsPopover.css';

export default function ConversationSettingsPopover({ isOpen, onClose }) {
  const popoverRef = useRef(null);

  const { conversations, activeConversationId, updateConversationSettings } = useChatStore();
  const globalSettings = useSettingsStore();

  const conv = conversations.find(c => c.id === activeConversationId);

  // Local state for form fields
  const [temperature, setTemperature] = useState(conv?.temperature ?? null);
  const [maxTokens, setMaxTokens] = useState(conv?.maxTokens ?? null);
  const [systemPrompt, setSystemPrompt] = useState(conv?.systemPrompt ?? null);
  const [enableThinking, setEnableThinking] = useState(conv?.enableThinking ?? null);
  const [enabledTools, setEnabledTools] = useState(conv?.enabledTools ?? null);

  // Update local state when conversation changes
  useEffect(() => {
    if (conv) {
      setTemperature(conv.temperature ?? null);
      setMaxTokens(conv.maxTokens ?? null);
      setSystemPrompt(conv.systemPrompt ?? null);
      setEnableThinking(conv.enableThinking ?? null);
      setEnabledTools(conv.enabledTools ?? null);
    }
  }, [conv, activeConversationId]);

  // Close on click outside
  useEffect(() => {
    if (!isOpen) return;

    const handleClickOutside = (e) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target)) {
        onClose();
      }
    };

    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose();
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [isOpen, onClose]);

  if (!isOpen || !conv) return null;

  const isUsingGlobal = (field) => {
    switch (field) {
      case 'temperature': return temperature === null;
      case 'maxTokens': return maxTokens === null;
      case 'systemPrompt': return systemPrompt === null;
      case 'enableThinking': return enableThinking === null;
      case 'enabledTools': return enabledTools === null;
      default: return true;
    }
  };

  const getEffectiveValue = (field) => {
    switch (field) {
      case 'temperature': return temperature ?? globalSettings.temperature;
      case 'maxTokens': return maxTokens ?? globalSettings.maxTokens;
      case 'systemPrompt': return systemPrompt ?? globalSettings.systemPrompt;
      case 'enableThinking': return enableThinking ?? globalSettings.enableThinking;
      case 'enabledTools': return enabledTools ?? globalSettings.enabledTools;
      default: return null;
    }
  };

  const handleSave = () => {
    updateConversationSettings({
      temperature,
      max_tokens: maxTokens,
      system_prompt: systemPrompt,
      enable_thinking: enableThinking,
      enabledTools,
    });
    onClose();
  };

  const handleReset = () => {
    setTemperature(null);
    setMaxTokens(null);
    setSystemPrompt(null);
    setEnableThinking(null);
    setEnabledTools(null);
    updateConversationSettings({
      temperature: null,
      max_tokens: null,
      system_prompt: null,
      enable_thinking: null,
      enabledTools: null,
    });
  };

  const handleTemperatureChange = (value) => {
    setTemperature(value === '' ? null : parseFloat(value));
  };

  const handleMaxTokensChange = (value) => {
    setMaxTokens(value === '' ? null : parseInt(value, 10));
  };

  const handleToolToggle = (toolName) => {
    const current = getEffectiveValue('enabledTools') || [];
    let next;
    if (current.includes(toolName)) {
      next = current.filter(t => t !== toolName);
    } else {
      next = [...current, toolName];
    }
    setEnabledTools(next);
  };

  const handleToolsResetToGlobal = () => {
    setEnabledTools(null);
  };

  return (
    <div className="conv-settings-popover" ref={popoverRef}>
      <div className="conv-settings-header">
        <h3>Conversation Settings</h3>
        <button className="conv-settings-close" onClick={onClose}>
          &times;
        </button>
      </div>

      <div className="conv-settings-content">
        <div className="conv-settings-field">
          <label>
            Temperature
            {isUsingGlobal('temperature') && <span className="global-badge">Global</span>}
          </label>
          <div className="conv-settings-slider-row">
            <input
              type="range"
              min="0"
              max="2"
              step="0.1"
              value={getEffectiveValue('temperature')}
              onChange={(e) => handleTemperatureChange(e.target.value)}
            />
            <span className="conv-settings-value">{getEffectiveValue('temperature')}</span>
          </div>
        </div>

        <div className="conv-settings-field">
          <label>
            Max Tokens
            {isUsingGlobal('maxTokens') && <span className="global-badge">Global</span>}
          </label>
          <input
            type="number"
            min="1"
            max="128000"
            value={getEffectiveValue('maxTokens')}
            onChange={(e) => handleMaxTokensChange(e.target.value)}
            className="conv-settings-input"
          />
        </div>

        <div className="conv-settings-field">
          <label>
            System Prompt
            {isUsingGlobal('systemPrompt') && <span className="global-badge">Global</span>}
          </label>
          <textarea
            value={getEffectiveValue('systemPrompt') || ''}
            onChange={(e) => setSystemPrompt(e.target.value || null)}
            placeholder="Enter system prompt..."
            className="conv-settings-textarea"
            rows={4}
          />
        </div>

        <div className="conv-settings-field conv-settings-toggle-field">
          <label>
            Enable Thinking
            {isUsingGlobal('enableThinking') && <span className="global-badge">Global</span>}
          </label>
          <button
            className={`conv-settings-toggle ${getEffectiveValue('enableThinking') ? 'active' : ''}`}
            onClick={() => setEnableThinking(!getEffectiveValue('enableThinking'))}
          >
            {getEffectiveValue('enableThinking') ? 'On' : 'Off'}
          </button>
        </div>

        <div className="conv-settings-field">
          <label>
            Enabled Tools
            {isUsingGlobal('enabledTools') && <span className="global-badge">Global</span>}
            {!isUsingGlobal('enabledTools') && (
              <button
                className="conv-settings-reset-link"
                onClick={handleToolsResetToGlobal}
              >
                Use global
              </button>
            )}
          </label>
          <div className="conv-settings-tools-list">
            {AVAILABLE_TOOLS.map(tool => {
              const effectiveTools = getEffectiveValue('enabledTools') || [];
              const checked = effectiveTools.includes(tool.name);
              return (
                <label key={tool.name} className="conv-settings-tool-item">
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => handleToolToggle(tool.name)}
                  />
                  <div className="conv-settings-tool-info">
                    <span className="conv-settings-tool-name">{tool.displayName}</span>
                    <span className="conv-settings-tool-desc">{tool.description}</span>
                  </div>
                </label>
              );
            })}
          </div>
        </div>
      </div>

      <div className="conv-settings-actions">
        <button className="conv-settings-reset" onClick={handleReset}>
          Reset to Defaults
        </button>
        <button className="conv-settings-save" onClick={handleSave}>
          Save
        </button>
      </div>
    </div>
  );
}
