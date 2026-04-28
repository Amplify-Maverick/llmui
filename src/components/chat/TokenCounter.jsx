import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import {
  estimateConversationTokens,
  estimateTokens,
  formatTokenCount,
} from "../../utils/tokenEstimator.js";
import "./TokenCounter.css";

function getBarColor(percentage) {
  if (percentage < 50) return "#6ee7b7";
  if (percentage < 75) return "#fcd34d";
  if (percentage < 90) return "#fb923c";
  return "#ff6b6b";
}

function getBarGlow(percentage) {
  if (percentage < 50) return "0 0 6px rgba(110, 231, 183, 0.3)";
  if (percentage < 75) return "0 0 6px rgba(252, 211, 77, 0.3)";
  if (percentage < 90) return "0 0 6px rgba(251, 146, 60, 0.3)";
  return "0 0 8px rgba(255, 107, 107, 0.4)";
}

export default function TokenCounter({ inputValue = "" }) {
  const { messages, streamingContent, isStreaming } = useChatStore();
  const { defaultModel, systemPrompt } = useSettingsStore();
  const { fetchModelInfo, modelInfoCache } = useModelsStore();
  const [contextLength, setContextLength] = useState(null);

  useEffect(() => {
    if (defaultModel) {
      if (modelInfoCache[defaultModel]) {
        setContextLength(modelInfoCache[defaultModel].contextLength);
      } else {
        fetchModelInfo(defaultModel).then((info) => {
          if (info) setContextLength(info.contextLength);
        });
      }
    }
  }, [defaultModel, fetchModelInfo, modelInfoCache]);

  const { conversationTokens, inputTokens, totalTokens, percentage } =
    useMemo(() => {
      const effectiveMessages = [...messages];
      if (isStreaming && streamingContent && effectiveMessages.length > 0) {
        const last = effectiveMessages[effectiveMessages.length - 1];
        if (last.role === "assistant") {
          effectiveMessages[effectiveMessages.length - 1] = {
            ...last,
            content: streamingContent,
          };
        }
      }

      const convTokens = estimateConversationTokens(effectiveMessages, systemPrompt);
      const inpTokens = inputValue ? estimateTokens(inputValue) + 4 : 0;
      const total = convTokens + inpTokens;
      const pct = contextLength ? Math.min((total / contextLength) * 100, 100) : 0;

      return {
        conversationTokens: convTokens,
        inputTokens: inpTokens,
        totalTokens: total,
        percentage: pct,
      };
    }, [messages, streamingContent, isStreaming, inputValue, systemPrompt, contextLength]);

  if (!defaultModel) return null;

  const barColor = getBarColor(percentage);

  return (
    <div className="token-bar">
      <span className="token-label" title="Estimated tokens used in this conversation">
        <span className="token-dot" style={{ background: barColor }} />
        <span className="token-label-value">
          {formatTokenCount(totalTokens)}
        </span>
        {contextLength && (
          <span>/ {formatTokenCount(contextLength)}</span>
        )}
        <span style={{ marginLeft: "2px" }}>tokens</span>
      </span>

      {contextLength && (
        <div className="token-progress-track" title={`${percentage.toFixed(1)}% of context window used`}>
          <div
            className="token-progress-fill"
            style={{
              width: `${percentage}%`,
              background: barColor,
              boxShadow: getBarGlow(percentage),
            }}
          />
        </div>
      )}

      {contextLength && (
        <span className="token-label" style={{ color: percentage >= 90 ? "#ff6b6b" : undefined }}>
          {percentage >= 90 ? "Near limit" : `${percentage.toFixed(0)}%`}
        </span>
      )}

      {inputTokens > 0 && (
        <span className="token-label token-pending" title="Tokens from your current input">
          +{formatTokenCount(inputTokens)} pending
        </span>
      )}
    </div>
  );
}
