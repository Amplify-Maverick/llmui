import { useCallback, useEffect, useRef, useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useOllamaStream } from "../../hooks/useOllamaStream.js";
import MessageBubble from "./MessageBubble.jsx";
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
    deleteMessage,
    editMessageAndTruncate,
    removeLastAssistantMessage,
    getLastUserMessage,
  } = useChatStore();

  const { defaultModel, updateSetting } = useSettingsStore();
  const { localModels, fetchModels, modelInfoCache, fetchModelInfo } = useModelsStore();
  const { sendMessage, stopStreaming, regenerateLastMessage } = useOllamaStream();

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

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

  const handleEditMessage = (id, newContent) => {
    editMessageAndTruncate(id, newContent);
    // Auto-regenerate after edit
    sendMessage(newContent, defaultModel);
  };

  const handleDeleteMessage = () => {
    if (deleteConfirm) {
      deleteMessage(deleteConfirm);
      setDeleteConfirm(null);
    }
  };

  const handleRegenerate = () => {
    regenerateLastMessage(defaultModel);
  };

  // Calculate real-time tokens/sec during streaming
  const currentTokensPerSec = (() => {
    if (!isStreaming || !streamingStartTime || streamingTokenCount === 0) return null;
    const elapsed = (Date.now() - streamingStartTime) / 1000;
    if (elapsed <= 0) return null;
    return (streamingTokenCount / elapsed).toFixed(1);
  })();

  // Combine messages with streaming content for display
  const displayMessages = [...messages];
  if (isStreaming && displayMessages.length > 0) {
    const lastMsg = displayMessages[displayMessages.length - 1];
    if (lastMsg.role === "assistant") {
      displayMessages[displayMessages.length - 1] = {
        ...lastMsg,
        content: streamingContent,
      };
    }
  }

  // Find last assistant message index
  const lastAssistantIndex = displayMessages.reduce(
    (acc, msg, idx) => (msg.role === "assistant" ? idx : acc),
    -1
  );

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
            className={`gpu-toggle ${showGpu ? "active" : ""}`}
            onClick={() => setShowGpu((v) => !v)}
            title={showGpu ? "Hide GPU stats" : "Show GPU stats"}
          >
            GPU
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
        {displayMessages.length === 0 ? (
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
                isStreaming={
                  isStreaming &&
                  idx === displayMessages.length - 1 &&
                  msg.role === "assistant"
                }
                onEdit={handleEditMessage}
                onDelete={setDeleteConfirm}
                onRegenerate={handleRegenerate}
                isLastAssistant={idx === lastAssistantIndex && !isStreaming}
              />
            ))}
            {isStreaming && streamingContent === "" && <StreamingIndicator />}
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
