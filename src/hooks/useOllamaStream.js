import { useCallback, useRef } from "react";
import { useChatStore } from "../stores/chatStore.js";
import { useSettingsStore } from "../stores/settingsStore.js";
import { ollamaApi } from "../services/ollamaApi.js";

export function useOllamaStream() {
  const abortControllerRef = useRef(null);

  const {
    messages,
    activeConversationId,
    conversations,
    isStreaming,
    streamingContent,
    addMessage,
    setStreaming,
    appendStreamContent,
    appendToolCall,
    completeToolCall,
    clearToolCalls,
    finalizeStream,
    createConversation,
    updateConversationModel,
    removeLastAssistantMessage,
    getLastUserMessage,
  } = useChatStore();

  // Global settings as fallback
  const globalSettings = useSettingsStore();

  // Get current conversation for per-conversation settings
  const currentConv = conversations.find(c => c.id === activeConversationId);

  // Use per-conversation settings if set, otherwise fall back to global
  const defaultModel = globalSettings.defaultModel;
  const temperature = currentConv?.temperature ?? globalSettings.temperature;
  const maxTokens = currentConv?.maxTokens ?? globalSettings.maxTokens;
  const systemPrompt = currentConv?.systemPrompt ?? globalSettings.systemPrompt;
  const enableThinking = currentConv?.enableThinking ?? globalSettings.enableThinking;
  const enableTools = globalSettings.enableTools;
  const enabledTools = globalSettings.enabledTools;

  const sendMessage = useCallback(
    async (content, model, images = []) => {
      const selectedModel = model || defaultModel;
      if (!selectedModel) {
        throw new Error("No model selected");
      }

      // Create conversation if none exists, or update model if changed
      let convId = activeConversationId;
      if (!convId) {
        convId = await createConversation(selectedModel);
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

      // Clear any previous tool calls
      clearToolCalls();

      try {
        // Use tools endpoint if tools are enabled
        if (enableTools && enabledTools && enabledTools.length > 0) {
          for await (const event of ollamaApi.chatStreamWithTools(
            selectedModel,
            chatMessages,
            { temperature, maxTokens, enabledTools, signal: abortControllerRef.current.signal }
          )) {
            switch (event.type) {
              case "content":
                appendStreamContent(event.content);
                break;
              case "tool_call":
                appendToolCall({
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                });
                break;
              case "tool_result":
                completeToolCall(event.id, event.result, event.error);
                break;
              case "done":
                // Stream complete
                break;
              case "error":
                throw new Error(event.error);
            }
          }
        } else {
          // Regular chat without tools
          for await (const chunk of ollamaApi.chatStream(
            selectedModel,
            chatMessages,
            { temperature, maxTokens, enableThinking, signal: abortControllerRef.current.signal }
          )) {
            if (chunk.message?.content) {
              appendStreamContent(chunk.message.content);
            }

            if (chunk.done) {
              break;
            }
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
        clearToolCalls();
      }
    },
    [
      activeConversationId,
      currentConv,
      defaultModel,
      systemPrompt,
      temperature,
      maxTokens,
      enableThinking,
      enableTools,
      enabledTools,
      addMessage,
      setStreaming,
      appendStreamContent,
      appendToolCall,
      completeToolCall,
      clearToolCalls,
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

      // Clear any previous tool calls
      clearToolCalls();

      try {
        // Use tools endpoint if tools are enabled
        if (enableTools && enabledTools && enabledTools.length > 0) {
          for await (const event of ollamaApi.chatStreamWithTools(
            selectedModel,
            chatMessages,
            { temperature, maxTokens, enabledTools, signal: abortControllerRef.current.signal }
          )) {
            switch (event.type) {
              case "content":
                appendStreamContent(event.content);
                break;
              case "tool_call":
                appendToolCall({
                  id: event.id,
                  name: event.name,
                  arguments: event.arguments,
                });
                break;
              case "tool_result":
                completeToolCall(event.id, event.result, event.error);
                break;
              case "done":
                break;
              case "error":
                throw new Error(event.error);
            }
          }
        } else {
          for await (const chunk of ollamaApi.chatStream(
            selectedModel,
            chatMessages,
            { temperature, maxTokens, enableThinking, signal: abortControllerRef.current.signal }
          )) {
            if (chunk.message?.content) {
              appendStreamContent(chunk.message.content);
            }

            if (chunk.done) {
              break;
            }
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
        clearToolCalls();
      }
    },
    [
      currentConv,
      defaultModel,
      systemPrompt,
      temperature,
      maxTokens,
      enableThinking,
      enableTools,
      enabledTools,
      addMessage,
      setStreaming,
      appendStreamContent,
      appendToolCall,
      completeToolCall,
      clearToolCalls,
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
