const userBubbleStyle = {
  background: "rgba(110, 231, 183, 0.15)",
  border: "1px solid rgba(110, 231, 183, 0.3)",
  borderRadius: "16px 16px 4px 16px",
  padding: "12px 16px",
  maxWidth: "70%",
  alignSelf: "flex-end",
  marginLeft: "auto",
};

const assistantBubbleStyle = {
  background: "rgba(255,255,255,0.03)",
  border: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "16px 16px 16px 4px",
  padding: "12px 16px",
  maxWidth: "70%",
  alignSelf: "flex-start",
};

const roleStyle = {
  fontSize: "11px",
  fontWeight: "600",
  textTransform: "uppercase",
  letterSpacing: "0.5px",
  marginBottom: "6px",
};

const contentStyle = {
  fontSize: "14px",
  lineHeight: "1.6",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "'DM Sans', sans-serif",
};

const codeBlockStyle = {
  background: "rgba(0,0,0,0.3)",
  borderRadius: "6px",
  padding: "12px",
  fontFamily: "'DM Mono', monospace",
  fontSize: "13px",
  overflow: "auto",
  margin: "8px 0",
};

function formatContent(content) {
  // Simple code block detection
  const parts = content.split(/(```[\s\S]*?```)/g);

  return parts.map((part, i) => {
    if (part.startsWith("```") && part.endsWith("```")) {
      const code = part.slice(3, -3).replace(/^\w+\n/, ""); // Remove language identifier
      return (
        <pre key={i} style={codeBlockStyle}>
          {code}
        </pre>
      );
    }
    // Handle inline code
    const inlineParts = part.split(/(`[^`]+`)/g);
    return inlineParts.map((p, j) => {
      if (p.startsWith("`") && p.endsWith("`")) {
        return (
          <code
            key={`${i}-${j}`}
            style={{
              background: "rgba(0,0,0,0.3)",
              padding: "2px 6px",
              borderRadius: "4px",
              fontFamily: "'DM Mono', monospace",
              fontSize: "13px",
            }}
          >
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
  const bubbleStyle = isUser ? userBubbleStyle : assistantBubbleStyle;

  return (
    <div style={{ display: "flex", marginBottom: "16px" }}>
      <div style={bubbleStyle}>
        <div
          style={{
            ...roleStyle,
            color: isUser ? "#6ee7b7" : "#8a8a9a",
          }}
        >
          {isUser ? "You" : "Assistant"}
        </div>
        <div style={{ ...contentStyle, color: "#e8e8f0" }}>
          {formatContent(message.content)}
          {isStreaming && (
            <span
              style={{
                display: "inline-block",
                width: "8px",
                height: "16px",
                background: "#6ee7b7",
                marginLeft: "2px",
                animation: "blink 1s infinite",
              }}
            />
          )}
        </div>
      </div>
    </div>
  );
}
