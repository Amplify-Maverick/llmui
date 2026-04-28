import { useState, useEffect } from "react";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";

const progressContainerStyle = {
  marginTop: "16px",
};

const progressBarStyle = {
  width: "100%",
  height: "8px",
  background: "rgba(255,255,255,0.1)",
  borderRadius: "4px",
  overflow: "hidden",
};

const progressFillStyle = (progress) => ({
  width: `${progress}%`,
  height: "100%",
  background: "linear-gradient(90deg, #6ee7b7, #60a5fa)",
  borderRadius: "4px",
  transition: "width 0.3s ease",
});

const statusStyle = {
  fontSize: "13px",
  color: "#8a8a9a",
  marginTop: "8px",
  textAlign: "center",
};

const helpTextStyle = {
  fontSize: "13px",
  color: "#8a8a9a",
  marginTop: "12px",
};

const linkStyle = {
  color: "#60a5fa",
  textDecoration: "none",
};

export default function ModelPullDialog({
  isOpen,
  onClose,
  onPull,
  pullProgress,
  initialModelName = "",
}) {
  const [modelName, setModelName] = useState(initialModelName);

  // Update local state when initialModelName changes or dialog opens
  useEffect(() => {
    if (isOpen) {
      setModelName(initialModelName);
    }
  }, [isOpen, initialModelName]);

  const handlePull = () => {
    if (modelName.trim()) {
      onPull(modelName.trim());
    }
  };

  const isPulling = pullProgress !== null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={isPulling ? undefined : onClose}
      title="Pull Model"
      showCloseButton={!isPulling}
      footer={
        !isPulling && (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button onClick={handlePull} disabled={!modelName.trim()}>
              Pull Model
            </Button>
          </>
        )
      }
    >
      {isPulling ? (
        <div style={progressContainerStyle}>
          <div style={progressBarStyle}>
            <div style={progressFillStyle(pullProgress.progress)} />
          </div>
          <p style={statusStyle}>
            {pullProgress.status}
            {pullProgress.progress > 0 && ` (${pullProgress.progress}%)`}
          </p>
        </div>
      ) : (
        <>
          <Input
            value={modelName}
            onChange={(e) => setModelName(e.target.value)}
            placeholder="e.g., llama3, mistral, codellama:7b"
            onKeyDown={(e) => e.key === "Enter" && handlePull()}
          />
          <p style={helpTextStyle}>
            Enter a model name from{" "}
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noopener noreferrer"
              style={linkStyle}
            >
              ollama.com/library
            </a>
            . You can specify a tag like <code style={{ color: "#6ee7b7" }}>llama3:8b</code>.
          </p>
        </>
      )}
    </Modal>
  );
}
