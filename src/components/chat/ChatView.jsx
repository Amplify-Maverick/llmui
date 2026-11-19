import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore, modelStatusLabel } from "../../stores/modelsStore.js";
import { useChatStream } from "../../hooks/useChatStream.js";
import MessageBubble from "./MessageBubble.jsx";
import StreamingBubble from "./StreamingBubble.jsx";
import MessageInput from "./MessageInput.jsx";
import StreamingIndicator from "./StreamingIndicator.jsx";
import TokenCounter from "./TokenCounter.jsx";
import BranchRow from "./BranchRow.jsx";
import GpuMini from "../stats/GpuMini.jsx";
import ModelSwitchModal from "./ModelSwitchModal.jsx";
import ConversationSettingsPopover from "./ConversationSettingsPopover.jsx";
import CompareView from "../compare/CompareView.jsx";
import ModelMultiSelect from "../compare/ModelMultiSelect.jsx";
import { Select } from "../shared/Input.jsx";
import { ConfirmModal } from "../shared/Modal.jsx";
import { liveTokensPerSec } from "../../utils/streamSpeed.js";
import "./ChatView.css";

export default function ChatView({ onBack }) {
  const messagesEndRef = useRef(null);
  const [inputValue, setInputValue] = useState("");
  const [showGpu, setShowGpu] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState(null);
  const [modelSwitchPending, setModelSwitchPending] = useState(null);
  const [compareMode, setCompareMode] = useState(false);
  const [compareModels, setCompareModels] = useState([]);
  const [showConvSettings, setShowConvSettings] = useState(false);

  const {
    messages,
    isStreaming,
    streamingContent,
    streamingTokenCount,
    streamingFirstTokenTime,
    streamingToolCalls,
    deleteMessage,
    editMessageAndTruncate,
    removeLastAssistantMessage,
    getLastUserMessage,
    createConversation,
    addMessage,
    createBranch,
    getBranchCountForMessage,
    conversations,
    activeConversationId,
  } = useChatStore();

  const { defaultModel: savedDefaultModel, enableThinking, enableTools, updateSetting } = useSettingsStore();
  const { models, modelsLoaded, fetchModels, refreshModels, modelInfoCache, fetchModelInfo } = useModelsStore();
  const { sendMessage, stopStreaming, regenerateLastMessage } = useChatStream();

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  // Keep load status fresh (a model loads on first request, others get
  // evicted under --models-max). Paused while the tab is hidden.
  useEffect(() => {
    const id = setInterval(() => {
      if (document.visibilityState === "visible") refreshModels();
    }, 5000);
    return () => clearInterval(id);
  }, [refreshModels]);

  useEffect(() => {
    if (!isStreaming) refreshModels();
  }, [isStreaming, refreshModels]);

  const isServed = useCallback((name) => models.some((m) => m.name === name), [models]);

  // A saved default that the /v1 server doesn't serve (e.g. an old Ollama
  // model name) counts as "no model selected" rather than being sent upstream.
  const defaultModel = !modelsLoaded || isServed(savedDefaultModel) ? savedDefaultModel : "";

  // Conversations whose model isn't served by the /v1 server (typically chats
  // from the Ollama era) open read-only: history renders, but nothing can be
  // sent, edited, regenerated, branched or deleted. Only decided once the
  // model list has actually loaded, so a slow/failed fetch doesn't lock chats.
  const activeConversation = conversations.find((c) => c.id === activeConversationId);
  const conversationModel = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "assistant" && messages[i].model) return messages[i].model;
    }
    return activeConversation?.model || null;
  }, [messages, activeConversation]);
  const isReadOnly =
    modelsLoaded && !isStreaming && messages.length > 0 &&
    !!conversationModel && !isServed(conversationModel);

  // Fetch model info when model changes
  useEffect(() => {
    if (defaultModel && !modelInfoCache[defaultModel]) {
      fetchModelInfo(defaultModel);
    }
  }, [defaultModel, models, modelInfoCache, fetchModelInfo]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const modelOptions = models.map((m) => ({
    value: m.name,
    label: `${m.name} — ${modelStatusLabel(m)}`,
  }));
  const selectedModelEntry = models.find((m) => m.name === defaultModel);

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
  const handleEditMessage = useCallback(async (id, newContent) => {
    if (!defaultModel) return;
    // Create a branch instead of truncating the conversation
    const branchId = await createBranch(id, newContent);
    if (branchId) {
      // Auto-regenerate in the new branch
      sendMessage(newContent, defaultModel);
    }
  }, [createBranch, sendMessage, defaultModel]);

  const handleDeleteMessage = useCallback(() => {
    if (deleteConfirm) {
      deleteMessage(deleteConfirm);
      setDeleteConfirm(null);
    }
  }, [deleteConfirm, deleteMessage]);

  const handleRegenerate = useCallback(() => {
    if (!defaultModel) return;
    regenerateLastMessage(defaultModel);
  }, [regenerateLastMessage, defaultModel]);

  const handleSetDeleteConfirm = useCallback((id) => {
    setDeleteConfirm(id);
  }, []);

  // Create a branch from a specific message without editing
  const handleBranch = useCallback(async (messageId) => {
    await createBranch(messageId);
  }, [createBranch]);

  // Handle "Pick this one" from Compare mode - creates a new conversation
  const handlePickResponse = useCallback(async (model, content, userPrompt, stats) => {
    // Create new conversation with the picked model
    await createConversation(model);

    // Add the user message (the comparison prompt)
    addMessage({ role: "user", content: userPrompt });

    // Add the assistant message with metadata
    addMessage({
      role: "assistant",
      content,
      model,
      duration: stats?.duration ? parseFloat(stats.duration) : undefined,
      tokensPerSec: stats?.avgTokPerSec ? parseFloat(stats.avgTokPerSec) : undefined,
      promptPerSec: stats?.readTokPerSec ? parseFloat(stats.readTokPerSec) : undefined,
    });

    // Exit compare mode
    setCompareMode(false);
    setCompareModels([]);
  }, [createConversation, addMessage]);

  // Live tokens/sec while streaming, measured from the first generated token
  // (the final figure comes from llama.cpp's own timings).
  const currentTokensPerSec = (() => {
    if (!isStreaming) return null;
    const tps = liveTokensPerSec(streamingTokenCount, streamingFirstTokenTime);
    return tps ? tps.toFixed(1) : null;
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
          <button className="chat-back-btn" onClick={onBack} title="Back to conversations">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <span className="chat-header-title">Chat</span>
          <div className="conv-settings-wrapper">
            <button
              className={`conv-settings-btn ${showConvSettings ? 'active' : ''}`}
              onClick={() => setShowConvSettings(v => !v)}
              title="Conversation settings"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
            </button>
            <ConversationSettingsPopover
              isOpen={showConvSettings}
              onClose={() => setShowConvSettings(false)}
            />
          </div>
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
            className={`compare-toggle ${compareMode ? "active" : ""}`}
            onClick={() => setCompareMode((v) => !v)}
            title={compareMode ? "Switch to single model" : "Compare two models side by side"}
          >
            Compare
          </button>
          {compareMode ? (
            <ModelMultiSelect
              value={compareModels}
              onChange={setCompareModels}
              maxSelections={2}
              minSelections={2}
            />
          ) : (
            <>
              {selectedModelEntry && (
                <span
                  className={`model-status-pill status-${selectedModelEntry.failed ? "failed" : selectedModelEntry.status}`}
                  title={
                    selectedModelEntry.status === "unloaded"
                      ? "Loads automatically on the first message (can take a while)"
                      : `Model is ${modelStatusLabel(selectedModelEntry)}`
                  }
                >
                  {modelStatusLabel(selectedModelEntry)}
                </span>
              )}
              <Select
                value={defaultModel}
                onChange={(e) => handleModelChange(e.target.value)}
                options={modelOptions}
                placeholder={modelsLoaded && models.length === 0 ? "No models on server" : "Select a model"}
                disabled={isReadOnly}
                style={{ width: "240px" }}
              />
            </>
          )}
        </div>
      </div>

      {/* GPU Stats - available in both modes */}
      {showGpu && <GpuMini />}

      {compareMode ? (
        /* Compare Mode View */
        <CompareView
          models={compareModels}
          onPickResponse={handlePickResponse}
          onSaveComplete={() => {
            setCompareMode(false);
            setCompareModels([]);
          }}
        />
      ) : (
        /* Regular Chat View */
        <>
          {/* Model Info Bar */}
          {currentModelInfo && (currentModelInfo.parameters || currentModelInfo.quantization) && (
            <div className="model-info-bar">
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

          <TokenCounter inputValue={inputValue} />

          <BranchRow />

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
                    onEdit={isReadOnly ? undefined : handleEditMessage}
                    onDelete={isReadOnly ? undefined : handleSetDeleteConfirm}
                    onRegenerate={isReadOnly ? undefined : handleRegenerate}
                    onBranch={isReadOnly ? undefined : handleBranch}
                    isLastAssistant={idx === lastAssistantIndex}
                    branchCount={getBranchCountForMessage(msg.id)}
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

          {isReadOnly ? (
            <div className="chat-readonly-banner" role="status">
              <span>
                Read-only — this conversation used <code>{conversationModel}</code>,
                which the model server doesn&apos;t provide.
              </span>
              <button
                className="chat-readonly-new"
                onClick={() => createConversation(defaultModel)}
              >
                New chat
              </button>
            </div>
          ) : (
            <MessageInput
              onSend={handleSend}
              onStop={stopStreaming}
              onInputChange={handleInputChange}
              disabled={!defaultModel}
              isStreaming={isStreaming}
            />
          )}
        </>
      )}

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
