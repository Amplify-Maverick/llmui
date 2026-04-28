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
import { Select } from "../shared/Input.jsx";
import "./ChatView.css";

export default function ChatView() {
  const messagesEndRef = useRef(null);
  const [inputValue, setInputValue] = useState("");
  const [showGpu, setShowGpu] = useState(false);

  const { messages, isStreaming, streamingContent } = useChatStore();
  const { defaultModel, updateSetting } = useSettingsStore();
  const { localModels, fetchModels } = useModelsStore();
  const { sendMessage, stopStreaming } = useOllamaStream();

  useEffect(() => {
    fetchModels();
  }, [fetchModels]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const modelOptions = localModels.map((m) => ({
    value: m.name,
    label: m.name,
  }));

  const handleSend = (content) => {
    sendMessage(content, defaultModel);
  };

  const handleInputChange = useCallback((value) => {
    setInputValue(value);
  }, []);

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

  return (
    <div className="chat-container">
      <div className="chat-header">
        <span className="chat-header-title">Chat</span>
        <div className="chat-header-actions">
          <button
            className={`gpu-toggle ${showGpu ? "active" : ""}`}
            onClick={() => setShowGpu((v) => !v)}
            title={showGpu ? "Hide GPU stats" : "Show GPU stats"}
          >
            GPU
          </button>
          <Select
            value={defaultModel}
            onChange={(e) => updateSetting("defaultModel", e.target.value)}
            options={modelOptions}
            placeholder="Select a model"
            style={{ width: "200px" }}
          />
        </div>
      </div>

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
    </div>
  );
}
