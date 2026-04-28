import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import {
  estimateConversationTokens,
  estimateTokens,
  formatTokenCount,
} from "../../utils/tokenEstimator.js";

const barContainerStyle = {
  display: "flex",
  alignItems: "center",
  gap: "10px",
  padding: "6px 16px",
  borderBottom: "1px solid rgba(255,255,255,0.06)",
  background: "rgba(255,255,255,0.01)",
  fontSize: "12px",
  fontFamily: "'DM Mono', monospace",
  color: "#8a8a9a",
  minHeight: "32px",
};

const progressBarOuterStyle = {
  flex: 1,
  height: "6px",
  background: "rgba(255,255,255,0.06)",
  borderRadius: "3px",
  overflow: "hidden",
  position: "relative",
};

const labelStyle = {
  whiteSpace: "nowrap",
  fontSize: "11px",
  display: "flex",
  alignItems: "center",
  gap: "4px",
};

const dotStyle = (color) => ({
  display: "inline-block",
  width: "6px",
  height: "6px",
  borderRadius: "50%",
  background: color,
  flexShrink: 0,
});

function getBarColor(percentage) {
  if (percentage < 50) return "#6ee7b7"; // green
  if (percentage < 75) return "#fcd34d"; // yellow
  if (percentage < 90) return "#fb923c"; // orange
  return "#ff6b6b"; // red
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

  // Fetch model info when model changes
  useEffect(() => {
    if (defaultModel) {
      // Check cache first
      if (modelInfoCache[defaultModel]) {
        setContextLength(modelInfoCache[defaultModel].contextLength);
      } else {
        fetchModelInfo(defaultModel).then((info) => {
          if (info) setContextLength(info.contextLength);
        });
      }
    }
  }, [defaultModel, fetchModelInfo, modelInfoCache]);

  // Calculate token counts
  const { conversationTokens, inputTokens, totalTokens, percentage } =
    useMemo(() => {
      // Build the effective messages list (with streaming content if active)
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

      const convTokens = estimateConversationTokens(
        effectiveMessages,
        systemPrompt
      );
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
    <div style={barContainerStyle}>
      {/* Token count */}
      <span style={labelStyle} title="Estimated tokens used in this conversation">
        <span style={dotStyle(barColor)} />
        <span style={{ color: "#e8e8f0", fontWeight: 500 }}>
          {formatTokenCount(totalTokens)}
        </span>
        {contextLength && (
          <span>/ {formatTokenCount(contextLength)}</span>
        )}
        <span style={{ marginLeft: "2px" }}>tokens</span>
      </span>

      {/* Progress bar */}
      {contextLength && (
        <div style={progressBarOuterStyle} title={`${percentage.toFixed(1)}% of context window used`}>
          <div
            style={{
              width: `${percentage}%`,
              height: "100%",
              background: barColor,
              borderRadius: "3px",
              transition: "width 0.3s ease, background 0.3s ease",
              boxShadow: getBarGlow(percentage),
            }}
          />
        </div>
      )}

      {/* Context window label */}
      {contextLength && (
        <span style={{ ...labelStyle, color: percentage >= 90 ? "#ff6b6b" : "#8a8a9a" }}>
          {percentage >= 90
            ? "Near limit"
            : `${percentage.toFixed(0)}%`}
        </span>
      )}

      {/* Breakdown tooltip-style info */}
      {inputTokens > 0 && (
        <span style={{ ...labelStyle, color: "#60a5fa" }} title="Tokens from your current input">
          +{formatTokenCount(inputTokens)} pending
        </span>
      )}
    </div>
  );
}
