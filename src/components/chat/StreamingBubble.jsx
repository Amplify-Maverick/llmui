import { useState, useEffect } from "react";
import { useChatStore } from "../../stores/chatStore.js";
import MarkdownRenderer from "./MarkdownRenderer.jsx";
import ToolCallCard from "./ToolCallCard.jsx";
import { formatDuration, formatTokensPerSec } from "./MessageBubble.jsx";
import "./MessageBubble.css";

/**
 * StreamingBubble — a dedicated component for the actively-streaming
 * assistant message.  It subscribes to `streamingContent` directly via
 * the Zustand store selector so that token-by-token updates only
 * re-render *this* component, leaving every other memoized
 * MessageBubble untouched.
 */
export default function StreamingBubble({ model }) {
  const streamingContent = useChatStore((s) => s.streamingContent);
  const streamingToolCalls = useChatStore((s) => s.streamingToolCalls);
  const streamingStartTime = useChatStore((s) => s.streamingStartTime);
  const streamingTokenCount = useChatStore((s) => s.streamingTokenCount);
  const [elapsed, setElapsed] = useState(0);

  // Update elapsed time every 100ms during streaming
  useEffect(() => {
    if (!streamingStartTime) {
      setElapsed(0);
      return;
    }
    const interval = setInterval(() => {
      setElapsed((Date.now() - streamingStartTime) / 1000);
    }, 100);
    return () => clearInterval(interval);
  }, [streamingStartTime]);

  const tokensPerSec = elapsed > 0 ? streamingTokenCount / elapsed : null;

  return (
    <div className="message-row">
      <div className="bubble bubble-assistant">
        <div className="bubble-role bubble-role-assistant">
          Assistant
          {model && <span className="bubble-model">{model}</span>}
          {elapsed > 0 && (
            <span className="bubble-duration">{formatDuration(elapsed)}</span>
          )}
          {tokensPerSec && (
            <span className="bubble-tokens-per-sec">{formatTokensPerSec(tokensPerSec)}</span>
          )}
        </div>

        {/* Tool calls display */}
        {streamingToolCalls && streamingToolCalls.length > 0 && (
          <div className="tool-calls-container">
            {streamingToolCalls.map((tc) => (
              <ToolCallCard key={tc.id} toolCall={tc} />
            ))}
          </div>
        )}

        <div className="bubble-content">
          {streamingContent ? (
            <MarkdownRenderer content={streamingContent} />
          ) : null}
          <span className="streaming-cursor" />
        </div>
      </div>
    </div>
  );
}
