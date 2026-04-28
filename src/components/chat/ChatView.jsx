import { useEffect, useRef } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import { useOllamaStream } from "../../hooks/useOllamaStream.js";
import MessageBubble from "./MessageBubble.jsx";
import MessageInput from "./MessageInput.jsx";
import StreamingIndicator from "./StreamingIndicator.jsx";
import { Select } from "../shared/Input.jsx";

const containerStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100%",
  background: "rgba(255,255,255,0.02)",
  borderRadius: "12px",
  border: "1px solid rgba(255,255,255,0.06)",
  overflow: "hidden",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  padding: "16px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
};

const titleStyle = {
  fontSize: "16px",
  fontWeight: "600",
  color: "#e8e8f0",
};

const messagesContainerStyle = {
  flex: 1,
  overflow: "auto",
  padding: "16px",
};

const emptyStateStyle = {
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  height: "100%",
  color: "#8a8a9a",
  textAlign: "center",
  padding: "40px",
};

const emptyIconStyle = {
  fontSize: "48px",
  marginBottom: "16px",
  opacity: 0.5,
};

export default function ChatView() {
  const messagesEndRef = useRef(null);

  const { messages, isStreaming, streamingContent, activeConversationId } = useChatStore();
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
    <div style={containerStyle}>
      <div style={headerStyle}>
        <span style={titleStyle}>Chat</span>
        <Select
          value={defaultModel}
          onChange={(e) => updateSetting("defaultModel", e.target.value)}
          options={modelOptions}
          placeholder="Select a model"
          style={{ width: "200px" }}
        />
      </div>

      <div style={messagesContainerStyle}>
        {displayMessages.length === 0 ? (
          <div style={emptyStateStyle}>
            <div style={emptyIconStyle}>💬</div>
            <h3 style={{ margin: "0 0 8px 0", color: "#e8e8f0" }}>
              Start a conversation
            </h3>
            <p style={{ margin: 0 }}>
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
        disabled={!defaultModel}
        isStreaming={isStreaming}
      />
    </div>
  );
}
