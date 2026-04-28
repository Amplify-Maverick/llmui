import { useState, useRef, useEffect } from "react";
import Button from "../shared/Button.jsx";
import "./MessageInput.css";

export default function MessageInput({
  onSend,
  onStop,
  onInputChange,
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
      onInputChange?.("");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  return (
    <div className="message-input">
      <textarea
        ref={textareaRef}
        className="message-input-textarea"
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          onInputChange?.(e.target.value);
        }}
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
