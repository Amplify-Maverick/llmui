import { useState, useRef, useEffect } from "react";
import Button from "../shared/Button.jsx";

const containerStyle = {
  display: "flex",
  gap: "12px",
  padding: "16px",
  background: "rgba(255,255,255,0.02)",
  borderTop: "1px solid rgba(255,255,255,0.06)",
  borderRadius: "0 0 12px 12px",
};

const textareaStyle = {
  flex: 1,
  background: "rgba(255,255,255,0.06)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "8px",
  padding: "12px",
  color: "#e8e8f0",
  fontSize: "14px",
  fontFamily: "'DM Sans', sans-serif",
  outline: "none",
  resize: "none",
  minHeight: "48px",
  maxHeight: "200px",
  transition: "border-color 0.2s ease",
};

export default function MessageInput({
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "48px";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleSubmit = () => {
    if (value.trim() && !disabled && !isStreaming) {
      onSend(value.trim());
      setValue("");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div style={containerStyle}>
      <textarea
        ref={textareaRef}
        style={{
          ...textareaStyle,
          borderColor: disabled ? "rgba(255,255,255,0.05)" : "rgba(255,255,255,0.1)",
        }}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="Type a message... (Enter to send, Shift+Enter for new line)"
        disabled={disabled || isStreaming}
      />
      {isStreaming ? (
        <Button variant="danger" onClick={onStop} style={{ alignSelf: "flex-end" }}>
          Stop
        </Button>
      ) : (
        <Button
          onClick={handleSubmit}
          disabled={!value.trim() || disabled}
          style={{ alignSelf: "flex-end" }}
        >
          Send
        </Button>
      )}
    </div>
  );
}
