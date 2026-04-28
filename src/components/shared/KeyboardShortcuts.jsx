import { useEffect, useState, useCallback } from "react";
import Modal from "./Modal.jsx";
import "./KeyboardShortcuts.css";

const SHORTCUTS = [
  { keys: ["Ctrl", "N"], action: "New conversation", category: "General" },
  { keys: ["Ctrl", "/"], action: "Open shortcuts panel", category: "General" },
  { keys: ["Ctrl", ","], action: "Open settings", category: "General" },
  { keys: ["Escape"], action: "Close modal / Cancel edit", category: "General" },
  { keys: ["Enter"], action: "Send message", category: "Chat" },
  { keys: ["Shift", "Enter"], action: "New line in message", category: "Chat" },
  { keys: ["Ctrl", "Enter"], action: "Save edit", category: "Chat" },
  { keys: ["Ctrl", "1"], action: "Switch to Chat tab", category: "Navigation" },
  { keys: ["Ctrl", "2"], action: "Switch to Models tab", category: "Navigation" },
  { keys: ["Ctrl", "3"], action: "Switch to System tab", category: "Navigation" },
  { keys: ["Ctrl", "4"], action: "Switch to Settings tab", category: "Navigation" },
];

export function useKeyboardShortcuts(handlers) {
  useEffect(() => {
    const handleKeyDown = (e) => {
      // Ignore if user is typing in an input/textarea
      const isTyping = ["INPUT", "TEXTAREA"].includes(e.target.tagName);

      // Ctrl+N - New conversation
      if (e.ctrlKey && e.key === "n") {
        e.preventDefault();
        handlers.onNewConversation?.();
        return;
      }

      // Ctrl+/ - Open shortcuts
      if (e.ctrlKey && e.key === "/") {
        e.preventDefault();
        handlers.onToggleShortcuts?.();
        return;
      }

      // Ctrl+, - Open settings
      if (e.ctrlKey && e.key === ",") {
        e.preventDefault();
        handlers.onOpenSettings?.();
        return;
      }

      // Tab shortcuts (Ctrl+1-4)
      if (e.ctrlKey && !isTyping) {
        if (e.key === "1") {
          e.preventDefault();
          handlers.onSwitchTab?.("chat");
          return;
        }
        if (e.key === "2") {
          e.preventDefault();
          handlers.onSwitchTab?.("models");
          return;
        }
        if (e.key === "3") {
          e.preventDefault();
          handlers.onSwitchTab?.("stats");
          return;
        }
        if (e.key === "4") {
          e.preventDefault();
          handlers.onSwitchTab?.("settings");
          return;
        }
      }
    };

    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handlers]);
}

export default function KeyboardShortcutsPanel({ isOpen, onClose }) {
  const categories = [...new Set(SHORTCUTS.map((s) => s.category))];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Keyboard Shortcuts">
      <div className="shortcuts-panel">
        {categories.map((category) => (
          <div key={category} className="shortcuts-category">
            <h4 className="shortcuts-category-title">{category}</h4>
            <div className="shortcuts-list">
              {SHORTCUTS.filter((s) => s.category === category).map((shortcut, idx) => (
                <div key={idx} className="shortcut-item">
                  <span className="shortcut-action">{shortcut.action}</span>
                  <span className="shortcut-keys">
                    {shortcut.keys.map((key, kidx) => (
                      <span key={kidx}>
                        <kbd className="shortcut-key">{key}</kbd>
                        {kidx < shortcut.keys.length - 1 && " + "}
                      </span>
                    ))}
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Modal>
  );
}
