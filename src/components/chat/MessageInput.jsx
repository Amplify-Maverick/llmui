import { useState, useRef, useEffect, useCallback } from "react";
import Button from "../shared/Button.jsx";
import MessageTemplates from "./MessageTemplates.jsx";
import "./MessageInput.css";

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

export default function MessageInput({
  onSend,
  onStop,
  onInputChange,
  disabled = false,
  isStreaming = false,
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState([]);
  const [showTemplates, setShowTemplates] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const textareaRef = useRef(null);
  const fileInputRef = useRef(null);

  useEffect(() => {
    if (textareaRef.current) {
      textareaRef.current.style.height = "48px";
      textareaRef.current.style.height = `${Math.min(textareaRef.current.scrollHeight, 200)}px`;
    }
  }, [value]);

  const handleSubmit = () => {
    if ((value.trim() || images.length > 0) && !disabled && !isStreaming) {
      onSend(value.trim(), images);
      setValue("");
      setImages([]);
      onInputChange?.("");
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const processFile = async (file) => {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
      alert("Only images (JPEG, PNG, GIF, WebP) are supported");
      return null;
    }

    if (file.size > MAX_FILE_SIZE) {
      alert("File size must be less than 10MB");
      return null;
    }

    return new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = (e) => {
        // Extract base64 data (remove data URL prefix)
        const base64 = e.target.result.split(",")[1];
        resolve({
          name: file.name,
          type: file.type,
          size: file.size,
          data: base64,
          preview: e.target.result,
        });
      };
      reader.readAsDataURL(file);
    });
  };

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    const processedImages = await Promise.all(files.map(processFile));
    setImages((prev) => [...prev, ...processedImages.filter(Boolean)]);
    // Reset input
    if (fileInputRef.current) {
      fileInputRef.current.value = "";
    }
  };

  const handleDragOver = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const textData = e.dataTransfer.getData("text/plain");

    // Handle dropped text
    if (textData && files.length === 0) {
      setValue((prev) => prev + textData);
      onInputChange?.((prev) => prev + textData);
      return;
    }

    // Handle dropped files
    const imageFiles = files.filter((f) => f.type.startsWith("image/"));
    const textFiles = files.filter((f) => f.type === "text/plain" || f.name.endsWith(".txt"));

    // Process images
    if (imageFiles.length > 0) {
      const processedImages = await Promise.all(imageFiles.map(processFile));
      setImages((prev) => [...prev, ...processedImages.filter(Boolean)]);
    }

    // Process text files
    for (const file of textFiles) {
      const text = await file.text();
      setValue((prev) => prev + `\n${text}`);
      onInputChange?.((prev) => prev + `\n${text}`);
    }
  }, [onInputChange]);

  const removeImage = (index) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const handleTemplateSelect = (prompt) => {
    setValue(prompt);
    onInputChange?.(prompt);
    textareaRef.current?.focus();
  };

  return (
    <div
      className={`message-input-wrapper ${isDragging ? "dragging" : ""}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <MessageTemplates
        isOpen={showTemplates}
        onClose={() => setShowTemplates(false)}
        onSelect={handleTemplateSelect}
      />

      {/* Image Preview */}
      {images.length > 0 && (
        <div className="message-input-images">
          {images.map((img, idx) => (
            <div key={idx} className="image-preview">
              <img src={img.preview} alt={img.name} />
              <button
                className="image-remove"
                onClick={() => removeImage(idx)}
                title="Remove image"
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="message-input">
        <div className="message-input-actions">
          <button
            className="input-action-btn"
            onClick={() => setShowTemplates(!showTemplates)}
            title="Quick prompts"
            disabled={disabled || isStreaming}
          >
            /
          </button>
          <button
            className="input-action-btn"
            onClick={() => fileInputRef.current?.click()}
            title="Attach image"
            disabled={disabled || isStreaming}
          >
            +
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_IMAGE_TYPES.join(",")}
            multiple
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
        </div>

        <textarea
          ref={textareaRef}
          className="message-input-textarea"
          value={value}
          onChange={(e) => {
            setValue(e.target.value);
            onInputChange?.(e.target.value);
          }}
          onKeyDown={handleKeyDown}
          placeholder={isDragging ? "Drop files here..." : "Type a message... (Enter to send, Shift+Enter for new line)"}
          disabled={disabled || isStreaming}
        />

        {isStreaming ? (
          <Button variant="danger" onClick={onStop} style={{ alignSelf: "flex-end" }}>
            Stop
          </Button>
        ) : (
          <Button
            onClick={handleSubmit}
            disabled={(!value.trim() && images.length === 0) || disabled}
            style={{ alignSelf: "flex-end" }}
          >
            Send
          </Button>
        )}
      </div>

      {isDragging && (
        <div className="drag-overlay">
          <div className="drag-overlay-content">
            <span>Drop files or text here</span>
          </div>
        </div>
      )}
    </div>
  );
}
