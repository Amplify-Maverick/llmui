import { useEffect } from "react";
import Button from "./Button.jsx";

const overlayStyle = {
  position: "fixed",
  top: 0,
  left: 0,
  right: 0,
  bottom: 0,
  background: "rgba(0, 0, 0, 0.7)",
  backdropFilter: "blur(4px)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  zIndex: 1000,
};

const modalStyle = {
  background: "linear-gradient(145deg, #1a1a2e 0%, #16213e 100%)",
  border: "1px solid rgba(255,255,255,0.1)",
  borderRadius: "16px",
  padding: "24px",
  minWidth: "400px",
  maxWidth: "90vw",
  maxHeight: "90vh",
  overflow: "auto",
};

const headerStyle = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "center",
  marginBottom: "20px",
};

const titleStyle = {
  fontSize: "18px",
  fontWeight: "600",
  color: "#e8e8f0",
  margin: 0,
};

const closeButtonStyle = {
  background: "transparent",
  border: "none",
  color: "#8a8a9a",
  fontSize: "24px",
  cursor: "pointer",
  padding: "0",
  lineHeight: 1,
};

const footerStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: "12px",
  marginTop: "24px",
};

export default function Modal({
  isOpen,
  onClose,
  title,
  children,
  footer,
  showCloseButton = true,
}) {
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === "Escape" && isOpen) {
        onClose();
      }
    };
    document.addEventListener("keydown", handleEscape);
    return () => document.removeEventListener("keydown", handleEscape);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div style={overlayStyle} onClick={onClose}>
      <div style={modalStyle} onClick={(e) => e.stopPropagation()}>
        <div style={headerStyle}>
          <h2 style={titleStyle}>{title}</h2>
          {showCloseButton && (
            <button style={closeButtonStyle} onClick={onClose}>
              ×
            </button>
          )}
        </div>
        {children}
        {footer && <div style={footerStyle}>{footer}</div>}
      </div>
    </div>
  );
}

export function ConfirmModal({
  isOpen,
  onClose,
  onConfirm,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  variant = "danger",
}) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            {cancelText}
          </Button>
          <Button variant={variant} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <p style={{ color: "#8a8a9a", margin: 0 }}>{message}</p>
    </Modal>
  );
}
