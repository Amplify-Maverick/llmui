import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useOllamaStream } from "../../hooks/useOllamaStream.js";
import MessageBubble from "./MessageBubble.jsx";
import StreamingBubble from "./StreamingBubble.jsx";
import MessageInput from "./MessageInput.jsx";
import StreamingIndicator from "./StreamingIndicator.jsx";
import TokenCounter from "./TokenCounter.jsx";
import GpuMini from "../stats/GpuMini.jsx";
import ConnectionStatus from "./ConnectionStatus.jsx";
import ModelSwitchModal from "./ModelSwitchModal.jsx";
import { Select } from "../shared/Input.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import "./ChatView.css";

export default function ChatView() {
  const messagesEndRef = useRef(null);
  const [inputValue, setInputValue] = useState("");
  const [showGpu, setShowGpu] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [modelSwitchPending, setModelSwitchPending] = useState(null);

  const {
    messages,
    isStreaming,
    streamingContent,
    streamingTokenCount,
    streamingStartTime,
    streamingToolCalls,
    deleteMessage,
    editMessageAndTruncate,
    removeLastAssistantMessage,
    getLastUserMessage,
  } = useChatStore();

  const { defaultModel, enableThinking, enableTools, updateSetting } = useSettingsStore();
  const { localModels, fetchModels, modelInfoCache, fetchModelInfo, runningModels, fetchRunningModels, unloadModel } = useModelsStore();
  const { sendMessage, stopStreaming, regenerateLastMessage } = useOllamaStream();
  const [isUnloading, setIsUnloading] = useState(false);

  useEffect(() => {
    fetchModels();
    fetchRunningModels();
    const id = setInterval(fetchRunningModels, 5000);
    return () => clearInterval(id);
  }, [fetchModels, fetchRunningModels]);

  const isModelRunning = runningModels.some((m) => m.name === defaultModel);

  const handleUnloadModel = async () => {
    if (!defaultModel || isUnloading) return;
    setIsUnloading(true);
    try {
      await unloadModel(defaultModel);
    } catch (err) {
      console.error("Failed to unload model:", err);
    } finally {
      setIsUnloading(false);
    }
  };

  // Fetch model info when model changes
  useEffect(() => {
    if (defaultModel && !modelInfoCache[defaultModel]) {
      fetchModelInfo(defaultModel);
    }
  }, [defaultModel, modelInfoCache, fetchModelInfo]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const modelOptions = localModels.map((m) => ({
    value: m.name,
    label: m.name,
  }));

  const currentModelInfo = modelInfoCache[defaultModel];

  const handleSend = (content, images = []) => {
    sendMessage(content, defaultModel, images);
  };

  const handleInputChange = useCallback((value) => {
    setInputValue(value);
  }, []);

  const handleModelChange = (newModel) => {
    // If there are messages, show warning modal
    if (messages.length > 0) {
      setModelSwitchPending(newModel);
    } else {
      updateSetting("defaultModel", newModel);
    }
  };

  const confirmModelSwitch = () => {
    if (modelSwitchPending) {
      updateSetting("defaultModel", modelSwitchPending);
      setModelSwitchPending(null);
    }
  };

  // Stable callback refs — these don't change between renders so
  // memoized MessageBubble children won't re-render.
  const handleEditMessage = useCallback((id, newContent) => {
    editMessageAndTruncate(id, newContent);
    // Auto-regenerate after edit
    sendMessage(newContent, defaultModel);
  }, [editMessageAndTruncate, sendMessage, defaultModel]);

  const handleDeleteMessage = useCallback(() => {
    if (deleteConfirm) {
      deleteMessage(deleteConfirm);
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, deleteMessage]);

  const handleRegenerate = useCallback(() => {
    regenerateLastMessage(defaultModel);
  }, [regenerateLastMessage, defaultModel]);

  const handleSetDeleteConfirm = useCallback((id) => {
    setDeleteConfirm(id);
  }, []);

  // Calculate real-time tokens/sec during streaming
  const currentTokensPerSec = (() => {
    if (!isStreaming || !streamingStartTime || streamingTokenCount === 0) return null;
    const elapsed = (Date.now() - streamingStartTime) / 1000;
    if (elapsed <= 0) return null;
    return (streamingTokenCount / elapsed).toFixed(1);
  })();

  // When streaming, exclude the placeholder assistant message (last
  // message, which has empty content) from the rendered list.  The
  // StreamingBubble component takes over rendering the in-progress
  // response and subscribes to streamingContent directly — so
  // completed messages stay referentially stable and memo'd
  // MessageBubble instances never re-render.
  const displayMessages = useMemo(() => {
    if (isStreaming && messages.length > 0) {
      const last = messages[messages.length - 1];
      if (last.role === "assistant" && !last.content) {
        return messages.slice(0, -1);
      }
    }
    return messages;
  }, [messages, isStreaming]);

  // Find last assistant message index (for the regenerate button) —
  // only relevant when NOT streaming.
  const lastAssistantIndex = useMemo(() => {
    if (isStreaming) return -1;
    return displayMessages.reduce(
      (acc, msg, idx) => (msg.role === "assistant" ? idx : acc),
      -1
    );
  }, [displayMessages, isStreaming]);

  // The model for the streaming bubble — grab from the placeholder
  // assistant message that the stream hook creates.
  const streamingModel = useMemo(() => {
    if (!isStreaming || messages.length === 0) return defaultModel;
    const last = messages[messages.length - 1];
    return last.role === "assistant" ? (last.model || defaultModel) : defaultModel;
  }, [isStreaming, messages, defaultModel]);

  return (
    <div className="chat-container">
      <div className="chat-header">
        <div className="chat-header-left">
          <span className="chat-header-title">Chat</span>
          <ConnectionStatus />
        </div>
        <div className="chat-header-actions">
          {isStreaming && currentTokensPerSec && (
            <span className="streaming-speed">{currentTokensPerSec} tok/s</span>
          )}
          <button
            className={`think-toggle ${enableThinking ? "active" : ""}`}
            onClick={() => updateSetting("enableThinking", !enableThinking)}
            title={enableThinking ? "Disable thinking mode" : "Enable thinking mode for reasoning models"}
          >
            Think
          </button>
          <button
            className={`tools-toggle ${enableTools ? "active" : ""}`}
            onClick={() => updateSetting("enableTools", !enableTools)}
            title={
              enableTools
                ? "Disable tool calling"
                : "Enable tool calling (web search, calculator, etc.)"
            }
          >
            Tools
            {enableTools && currentModelInfo && !currentModelInfo.supportsTools && (
              <span className="tools-warning" title="Model may not support tool calling">!</span>
            )}
          </button>
          <button
            className={`gpu-toggle ${showGpu ? "active" : ""}`}
            onClick={() => setShowGpu((v) => !v)}
            title={showGpu ? "Hide GPU stats" : "Show GPU stats"}
          >
            GPU
          </button>
          <button
            className={`unload-btn ${isModelRunning ? "active" : ""}`}
            onClick={handleUnloadModel}
            disabled={!isModelRunning || isUnloading || isStreaming}
            title={isModelRunning ? "Unload model from VRAM" : "Model not loaded in VRAM"}
          >
            {isUnloading ? "Unloading..." : "Unload"}
          </button>
          <Select
            value={defaultModel}
            onChange={(e) => handleModelChange(e.target.value)}
            options={modelOptions}
            placeholder="Select a model"
            style={{ width: "200px" }}
          />
        </div>
      </div>

      {/* Model Info Bar */}
      {currentModelInfo && (
        <div className="model-info-bar">
          <span className="model-info-item">
            <strong>Context:</strong> {currentModelInfo.contextLength?.toLocaleString() || "?"} tokens
          </span>
          {currentModelInfo.parameters && (
            <span className="model-info-item">
              <strong>Parameters:</strong> {currentModelInfo.parameters}
            </span>
          )}
          {currentModelInfo.quantization && (
            <span className="model-info-item">
              <strong>Quantization:</strong> {currentModelInfo.quantization}
            </span>
          )}
        </div>
      )}

      {showGpu && <GpuMini />}

      <TokenCounter inputValue={inputValue} />

      <div className="chat-messages">
        {displayMessages.length === 0 && !isStreaming ? (
          <div className="chat-empty">
            <div className="chat-empty-icon"></div>
            <h3>Start a conversation</h3>
            <p>
              {defaultModel
                ? `Using ${defaultModel}. Type a message below to begin.`
                : "Select a model above to get started."}
            </p>
          </div>
        ) : (
          <>
            {displayMessages.map((msg, idx) => (
              <MessageBubble
                key={msg.id || idx}
                message={msg}
                onEdit={handleEditMessage}
                onDelete={handleSetDeleteConfirm}
                onRegenerate={handleRegenerate}
                isLastAssistant={idx === lastAssistantIndex}
              />
            ))}
            {/* Isolated streaming bubble — only this re-renders per token */}
            {isStreaming && (
              streamingContent === "" && (!streamingToolCalls || streamingToolCalls.length === 0)
                ? <StreamingIndicator />
                : <StreamingBubble model={streamingModel} />
            )}
          </>
        )}
        <div ref={messagesEndRef} />
      </div>

      <MessageInput
        onSend={handleSend}
        onStop={stopStreaming}
        onInputChange={handleInputChange}
        disabled={!defaultModel}
        isStreaming={isStreaming}
      />

      {/* Delete Confirmation Modal */}
      <ConfirmModal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        onConfirm={handleDeleteMessage}
        title="Delete Message"
        message="Are you sure you want to delete this message?"
        confirmText="Delete"
      />

      {/* Model Switch Warning Modal */}
      <ModelSwitchModal
        isOpen={modelSwitchPending !== null}
        onClose={() => setModelSwitchPending(null)}
        onConfirm={confirmModelSwitch}
        newModel={modelSwitchPending}
        currentModel={defaultModel}
      />
    </div>
  );
}
