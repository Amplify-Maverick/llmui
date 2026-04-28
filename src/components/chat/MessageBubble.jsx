import "./MessageBubble.css";

function formatDuration(seconds) {
  if (!seconds) return null;
  if (seconds < 1) return `${(seconds * 1000).toFixed(0)}ms`;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const mins = Math.floor(seconds / 60);
  const secs = (seconds % 60).toFixed(0);
  return `${mins}m ${secs}s`;
}

function formatContent(content) {
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3).replace(/^\w+\n/, "");
      return (
        <pre key={i} className="bubble-code-block">
          {code}
        </pre>
      );
    }
    const inlineParts = part.split(/(`[^`]+`)/g);
    return inlineParts.map((p, j) => {
      if (p.startsWith("`") && p.endsWith("`")) {
        return (
          <code key={`${i}-${j}`} className="bubble-inline-code">
            {p.slice(1, -1)}
          </code>
        );
      }
      return p;
    });
  });
}

export default function MessageBubble({ message, isStreaming = false }) {
  const isUser = message.role === "user";

  return (
    <div className="message-row">
      <div className={`bubble ${isUser ? "bubble-user" : "bubble-assistant"}`}>
        <div className={`bubble-role ${isUser ? "bubble-role-user" : "bubble-role-assistant"}`}>
          {isUser ? "You" : "Assistant"}
          {!isUser && message.model && (
            <span className="bubble-model">{message.model}</span>
          )}
          {!isUser && message.duration && (
            <span className="bubble-duration">{formatDuration(message.duration)}</span>
          )}
        </div>
        <div className="bubble-content">
          {formatContent(message.content)}
          {isStreaming && <span className="streaming-cursor" />}
        </div>
      </div>
    </div>
  );
}
