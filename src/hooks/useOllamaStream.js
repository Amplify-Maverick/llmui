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
    removeLastAssistantMessage,
    getLastUserMessage,
  } = useChatStore();

  const { ollamaBaseUrl, defaultModel, systemPrompt, temperature, maxTokens } =
    useSettingsStore();

  const sendMessage = useCallback(
    async (content, model, images = []) => {
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

      // Add user message with optional images
      const userMessage = { role: "user", content };
      if (images.length > 0) {
        userMessage.images = images;
      }
      addMessage(userMessage);

      // Add placeholder for assistant with model info
      addMessage({ role: "assistant", content: "", model: selectedModel });

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
        const apiMsg = { role: msg.role, content: msg.content };
        // Include images for multimodal models
        if (msg.images && msg.images.length > 0) {
          apiMsg.images = msg.images.map((img) => img.data);
        }
        chatMessages.push(apiMsg);
      }

      abortControllerRef.current = new AbortController();

      const startTime = Date.now();

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

        const duration = (Date.now() - startTime) / 1000;
        finalizeStream({ duration });
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

  const regenerateLastMessage = useCallback(
    async (model) => {
      const selectedModel = model || defaultModel;
      if (!selectedModel) {
        throw new Error("No model selected");
      }

      // Remove the last assistant message
      removeLastAssistantMessage();

      // Get the last user message
      const lastUserMessage = getLastUserMessage();
      if (!lastUserMessage) {
        console.error("No user message to regenerate from");
        return;
      }

      // Update API base URL if changed
      ollamaApi.setBaseUrl(ollamaBaseUrl);

      // Add placeholder for assistant with model info
      addMessage({ role: "assistant", content: "", model: selectedModel });

      setStreaming(true, "");

      // Build messages array for API
      const chatMessages = [];
      if (systemPrompt) {
        chatMessages.push({ role: "system", content: systemPrompt });
      }
      // Get current messages
      const currentMessages = useChatStore.getState().messages;
      for (const msg of currentMessages.slice(0, -1)) {
        const apiMsg = { role: msg.role, content: msg.content };
        if (msg.images && msg.images.length > 0) {
          apiMsg.images = msg.images.map((img) => img.data);
        }
        chatMessages.push(apiMsg);
      }

      abortControllerRef.current = new AbortController();

      const startTime = Date.now();

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

        const duration = (Date.now() - startTime) / 1000;
        finalizeStream({ duration });
      } catch (error) {
        if (error.name !== "AbortError") {
          console.error("Streaming error:", error);
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
      ollamaBaseUrl,
      defaultModel,
      systemPrompt,
      temperature,
      maxTokens,
      addMessage,
      setStreaming,
      appendStreamContent,
      finalizeStream,
      removeLastAssistantMessage,
      getLastUserMessage,
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
    regenerateLastMessage,
    isStreaming,
    streamingContent,
  };
}
