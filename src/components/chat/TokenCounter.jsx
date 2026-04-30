import { useEffect, useMemo, useState } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import { useSettingsStore } from "../../stores/settingsStore.js";
import { useModelsStore } from "../../stores/modelsStore.js";
import {
  estimateConversationTokens,
  estimateTokens,
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

function getStatusLevel(percentage) {
  if (percentage >= 100) return "exceeded";
  if (percentage >= 90) return "danger";
  if (percentage >= 75) return "warning";
  return "ok";
}

export default function TokenCounter({ inputValue = "" }) {
  const { messages, streamingContent, isStreaming, getActiveConversationSettings } = useChatStore();
  const { defaultModel, systemPrompt: globalSystemPrompt } = useSettingsStore();
  const { fetchModelInfo, modelInfoCache } = useModelsStore();
  const [contextLength, setContextLength] = useState(null);

  // Use per-conversation system prompt if set, otherwise fall back to global
  const convSettings = getActiveConversationSettings();
  const systemPrompt = convSettings?.systemPrompt ?? globalSystemPrompt;

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
      // Don't cap at 100 — we need to know when context is exceeded
      const pct = contextLength ? (total / contextLength) * 100 : 0;

      return {
        conversationTokens: convTokens,
        inputTokens: inpTokens,
        totalTokens: total,
        percentage: pct,
      };
    }, [messages, streamingContent, isStreaming, inputValue, systemPrompt, contextLength]);

  if (!defaultModel) return null;

  const barColor = getBarColor(percentage);
  const statusLevel = getStatusLevel(percentage);
  const barWidth = Math.min(percentage, 100); // visual bar caps at 100%
  const exceeded = percentage >= 100;

  return (
    <div className={`token-bar ${exceeded ? "token-bar--exceeded" : ""}`}>
      {/* Left: token count label */}
      <span
        className="token-label"
        title={`Estimated tokens used in this conversation${exceeded ? " — context window exceeded, older messages may be truncated" : ""}`}
      >
        <span className="token-dot" style={{ background: barColor }} />
        <span className="token-label-value">
          {totalTokens.toLocaleString()}
        </span>
        {contextLength && (
          <span className="token-label-limit">
            / {contextLength.toLocaleString()}
          </span>
        )}
        <span className="token-label-unit">tokens</span>
      </span>

      {/* Middle: progress bar */}
      {contextLength && (
        <div
          className={`token-progress-track ${statusLevel === "exceeded" ? "token-progress-track--exceeded" : ""}`}
          title={`${percentage.toFixed(1)}% of context window used`}
        >
          <div
            className={`token-progress-fill ${exceeded ? "token-progress-fill--exceeded" : ""}`}
            style={{
              width: `${barWidth}%`,
              background: barColor,
              boxShadow: getBarGlow(percentage),
            }}
          />
        </div>
      )}

      {/* Right: percentage / status */}
      {contextLength && (
        <span
          className={`token-label token-status token-status--${statusLevel}`}
        >
          {exceeded
            ? `${Math.round(percentage)}% — overflowing`
            : `${percentage.toFixed(0)}%`}
        </span>
      )}

      {/* Pending input tokens */}
      {inputTokens > 0 && (
        <span className="token-label token-pending" title="Tokens from your current input">
          +{inputTokens.toLocaleString()} pending
        </span>
      )}

      {/* Truncation warning */}
      {exceeded && (
        <span className="token-truncation-warning" title="The model's context window has been exceeded. Ollama will silently drop older messages to fit within num_ctx.">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          Truncating
        </span>
      )}
    </div>
  );
}
