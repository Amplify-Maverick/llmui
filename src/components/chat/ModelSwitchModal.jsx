import Modal from "../shared/Modal.jsx";
import Button from "../shared/Button.jsx";
import "./ModelSwitchModal.css";

export default function ModelSwitchModal({
  isOpen,
  onClose,
  onConfirm,
  currentModel,
  newModel,
}) {
  if (!isOpen) return null;

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Switch Model?"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" onClick={onConfirm}>
            Switch Model
          </Button>
        </>
      }
    >
      <div className="model-switch-content">
        <p className="model-switch-warning">
          You're about to switch models mid-conversation. The new model will continue
          the conversation but may have different capabilities and response styles.
        </p>
        <div className="model-switch-comparison">
          <div className="model-switch-item">
            <span className="model-switch-label">Current</span>
            <span className="model-switch-value">{currentModel || "None"}</span>
          </div>
          <span className="model-switch-arrow">→</span>
          <div className="model-switch-item">
            <span className="model-switch-label">New</span>
            <span className="model-switch-value new">{newModel}</span>
          </div>
        </div>
      </div>
    </Modal>
  );
}
