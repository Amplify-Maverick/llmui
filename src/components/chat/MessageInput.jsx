import { useState, useRef, useEffect, useCallback } from "react";
import Button from "../shared/Button.jsx";
import MessageTemplates from "./MessageTemplates.jsx";
import {
  ACCEPTED_TEXT_EXTENSIONS,
  MAX_TEXT_FILE_SIZE,
  composePrompt,
  isTextFile,
  languageForFile,
} from "../../utils/textFiles.js";
import { formatBytes } from "../../utils/formatters.js";
import "./MessageInput.css";

const ACCEPTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const ACCEPTED_FILE_TYPES = [...ACCEPTED_IMAGE_TYPES, ...ACCEPTED_TEXT_EXTENSIONS];

export default function MessageInput({
  onSend,
  onStop,
  onInputChange,
  disabled = false,
  isStreaming = false,
}) {
  const [value, setValue] = useState("");
  const [images, setImages] = useState([]);
  const [textFiles, setTextFiles] = useState([]);
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

  // Keep the token counter honest: attachments are part of the prompt even
  // though they live outside the textarea.
  useEffect(() => {
    onInputChange?.(composePrompt(value, textFiles));
  }, [value, textFiles, onInputChange]);

  const hasContent = value.trim() || images.length > 0 || textFiles.length > 0;

  const handleSubmit = () => {
    if (hasContent && !disabled && !isStreaming) {
      onSend(composePrompt(value.trim(), textFiles), images);
      setValue("");
      setImages([]);
      setTextFiles([]);
    }
  };

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSubmit();
    }
  };

  const processImage = async (file) => {
    if (file.size > MAX_FILE_SIZE) {
      alert(`${file.name} is larger than 10MB`);
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

  const processTextFile = async (file) => {
    if (file.size > MAX_TEXT_FILE_SIZE) {
      alert(`${file.name} is larger than 1MB — too large to fit in a prompt`);
      return null;
    }

    return {
      name: file.name,
      size: file.size,
      language: languageForFile(file.name),
      text: await file.text(),
    };
  };

  /** Route each file to the image or text pipeline, rejecting anything else. */
  const addFiles = async (files) => {
    const imageFiles = files.filter((f) => ACCEPTED_IMAGE_TYPES.includes(f.type));
    const codeFiles = files.filter((f) => !imageFiles.includes(f) && isTextFile(f));
    const rejected = files.filter((f) => !imageFiles.includes(f) && !codeFiles.includes(f));

    if (rejected.length > 0) {
      alert(
        `Unsupported file${rejected.length > 1 ? "s" : ""}: ${rejected
          .map((f) => f.name)
          .join(", ")}\n\nAttach images (JPEG, PNG, GIF, WebP) or text/code files.`
      );
    }

    const [processedImages, processedText] = await Promise.all([
      Promise.all(imageFiles.map(processImage)),
      Promise.all(codeFiles.map(processTextFile)),
    ]);

    if (processedImages.some(Boolean)) {
      setImages((prev) => [...prev, ...processedImages.filter(Boolean)]);
    }
    if (processedText.some(Boolean)) {
      setTextFiles((prev) => [...prev, ...processedText.filter(Boolean)]);
    }
  };

  const handleFileSelect = async (e) => {
    await addFiles(Array.from(e.target.files));
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

  const handleDrop = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const files = Array.from(e.dataTransfer.files);
    const textData = e.dataTransfer.getData("text/plain");

    // Dropped selection text goes straight into the textarea; dropped files
    // become attachments.
    if (textData && files.length === 0) {
      setValue((prev) => prev + textData);
      return;
    }

    await addFiles(files);
  };

  const removeImage = (index) => {
    setImages((prev) => prev.filter((_, i) => i !== index));
  };

  const removeTextFile = (index) => {
    setTextFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const handleTemplateSelect = (prompt) => {
    setValue(prompt);
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

      {/* Attached code / text files */}
      {textFiles.length > 0 && (
        <div className="message-input-files">
          {textFiles.map((file, idx) => (
            <div key={idx} className="file-chip" title={`${file.name} (${formatBytes(file.size)})`}>
              <span className="file-chip-name">{file.name}</span>
              <span className="file-chip-size">{formatBytes(file.size)}</span>
              <button
                className="file-chip-remove"
                onClick={() => removeTextFile(idx)}
                title="Remove file"
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
            title="Attach image or code file"
            disabled={disabled || isStreaming}
          >
            +
          </button>
          <input
            ref={fileInputRef}
            type="file"
            accept={ACCEPTED_FILE_TYPES.join(",")}
            multiple
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
        </div>

        <textarea
          ref={textareaRef}
          className="message-input-textarea"
          value={value}
          onChange={(e) => setValue(e.target.value)}
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
            disabled={!hasContent || disabled}
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
