import { useCallback, useRef } from "react";
import { useChatStore } from "../stores/chatStore.js";
import { useSettingsStore } from "../stores/settingsStore.js";
import { ollamaApi } from "../services/ollamaApi.js";

export function useOllamaStream() {
  const abortControllerRef = useRef(null);

  const {
    messages,
    activeConversationId,
    isStreaming,
    streamingContent,
    addMessage,
    setStreaming,
    appendStreamContent,
    finalizeStream,
    createConversation,
    updateConversationModel,
  } = useChatStore();

  const { ollamaBaseUrl, defaultModel, systemPrompt, temperature, maxTokens } =
    useSettingsStore();

  const sendMessage = useCallback(
    async (content, model) => {
      const selectedModel = model || defaultModel;
      if (!selectedModel) {
        throw new Error("No model selected");
      }

      // Update API base URL if changed
      ollamaApi.setBaseUrl(ollamaBaseUrl);

      // Create conversation if none exists, or update model if changed
      let convId = activeConversationId;
      if (!convId) {
        convId = createConversation(selectedModel);
      } else {
        updateConversationModel(selectedModel);
      }

      // Add user message
      addMessage({ role: "user", content });

      // Add placeholder for assistant
      addMessage({ role: "assistant", content: "" });

      setStreaming(true, "");

      // Build messages array for API
      const chatMessages = [];
      if (systemPrompt) {
        chatMessages.push({ role: "system", content: systemPrompt });
      }
      // Get current messages (including the one we just added)
      const currentMessages = useChatStore.getState().messages;
      for (const msg of currentMessages.slice(0, -1)) {
        // Exclude the empty assistant placeholder
        chatMessages.push({ role: msg.role, content: msg.content });
      }

      abortControllerRef.current = new AbortController();

      try {
        for await (const chunk of ollamaApi.chatStream(
          selectedModel,
          chatMessages,
          { temperature, maxTokens }
        )) {
          if (chunk.message?.content) {
            appendStreamContent(chunk.message.content);
          }

          if (chunk.done) {
            break;
          }
        }

        finalizeStream();
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Streaming error:", error);
          // Update the last message with error
          const state = useChatStore.getState();
          const lastMsg = state.messages[state.messages.length - 1];
          if (lastMsg && lastMsg.role === "assistant") {
            useChatStore.getState().updateMessage(
              lastMsg.id,
              `Error: ${error.message}`
            );
          }
        }
        setStreaming(false, "");
      }
    },
    [
      activeConversationId,
      ollamaBaseUrl,
      defaultModel,
      systemPrompt,
      temperature,
      maxTokens,
      addMessage,
      setStreaming,
      appendStreamContent,
      finalizeStream,
      createConversation,
      updateConversationModel,
    ]
  );

  const stopStreaming = useCallback(() => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
    }
    finalizeStream();
  }, [finalizeStream]);

  return {
    sendMessage,
    stopStreaming,
    isStreaming,
    streamingContent,
  };
}
