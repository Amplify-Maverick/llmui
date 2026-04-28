import { useChatStore } from "../../stores/chatStore.js";
import MarkdownRenderer from "./MarkdownRenderer.jsx";
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

  return (
    <div className="message-row">
      <div className="bubble bubble-assistant">
        <div className="bubble-role bubble-role-assistant">
          Assistant
          {model && <span className="bubble-model">{model}</span>}
        </div>

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
