import { useState, useRef, useCallback } from "react";
import { ollamaApi } from "../services/ollamaApi.js";
import { useSettingsStore } from "../stores/settingsStore.js";

/**
 * Hook for managing parallel model streams in Compare mode.
 * Uses local state (not chatStore) to keep comparisons ephemeral.
 */
export function useCompareStreams() {
  const [streams, setStreams] = useState(new Map());
  const abortControllersRef = useRef(new Map());

  const { systemPrompt, temperature, maxTokens } = useSettingsStore();

  const updateStream = useCallback((model, updates) => {
    setStreams((prev) => {
      const updated = new Map(prev);
      const current = updated.get(model) || {};
      updated.set(model, { ...current, ...updates });
      return updated;
    });
  }, []);

  const runSingleStream = useCallback(
    async (model, prompt) => {
      const abortController = new AbortController();
      abortControllersRef.current.set(model, abortController);

      const messages = [];
      if (systemPrompt) {
        messages.push({ role: "system", content: systemPrompt });
      }
      messages.push({ role: "user", content: prompt });

      try {
        for await (const chunk of ollamaApi.chatStream(model, messages, {
          temperature,
          maxTokens,
          signal: abortController.signal,
        })) {
          if (chunk.message?.content) {
            setStreams((prev) => {
              const updated = new Map(prev);
              const current = updated.get(model);
              if (current) {
                updated.set(model, {
                  ...current,
                  content: current.content + chunk.message.content,
                  tokenCount: current.tokenCount + 1,
                });
              }
              return updated;
            });
          }

          if (chunk.done) {
            break;
          }
        }

        // Mark complete
        updateStream(model, {
          status: "complete",
          endTime: Date.now(),
        });
      } catch (error) {
        if (error.name !== "AbortError") {
          updateStream(model, {
            status: "error",
            error: error.message,
            endTime: Date.now(),
          });
        } else {
          // Aborted - mark as complete with current content
          updateStream(model, {
            status: "aborted",
            endTime: Date.now(),
          });
        }
      }
    },
    [systemPrompt, temperature, maxTokens, updateStream]
  );

  const startCompare = useCallback(
    async (prompt, models) => {
      // Clear previous state
      abortControllersRef.current.forEach((controller) => controller.abort());
      abortControllersRef.current.clear();

      // Initialize all stream states
      const initialStates = new Map();
      models.forEach((model) => {
        initialStates.set(model, {
          modelName: model,
          status: "streaming",
          content: "",
          tokenCount: 0,
          startTime: Date.now(),
          endTime: null,
          error: null,
        });
      });
      setStreams(initialStates);

      // Fire all streams in parallel
      await Promise.allSettled(
        models.map((model) => runSingleStream(model, prompt))
      );
    },
    [runSingleStream]
  );

  const stopAll = useCallback(() => {
    abortControllersRef.current.forEach((controller) => controller.abort());
  }, []);

  const stopOne = useCallback((model) => {
    abortControllersRef.current.get(model)?.abort();
  }, []);

  const reset = useCallback(() => {
    stopAll();
    setStreams(new Map());
    abortControllersRef.current.clear();
  }, [stopAll]);

  // Computed properties
  const allComplete = Array.from(streams.values()).every(
    (s) => s.status === "complete" || s.status === "error" || s.status === "aborted"
  );

  const anyStreaming = Array.from(streams.values()).some(
    (s) => s.status === "streaming"
  );

  return {
    streams,
    startCompare,
    stopAll,
    stopOne,
    reset,
    allComplete,
    anyStreaming,
  };
}
