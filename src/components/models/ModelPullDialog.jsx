import { useState, useEffect } from "react";
import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import Input from "../shared/Input.jsx";
import "./ModelPullDialog.css";

export default function ModelPullDialog({
  isOpen,
  onClose,
  onPull,
  pullProgress,
  initialModelName = "",
}) {
  const [modelName, setModelName] = useState(initialModelName);

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
        <div className="pull-progress">
          <div className="pull-progress-bar">
            <div
              className="pull-progress-fill"
              style={{ width: `${pullProgress.progress}%` }}
            />
          </div>
          <p className="pull-status">
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
          <p className="pull-help">
            Enter a model name from{" "}
            <a
              href="https://ollama.com/library"
              target="_blank"
              rel="noopener noreferrer"
              className="pull-link"
            >
              ollama.com/library
            </a>
            . You can specify a tag like <code className="pull-code">llama3:8b</code>.
          </p>
        </>
      )}
    </Modal>
  );
}
