import { useState } from "react";
import "./MessageTemplates.css";

const DEFAULT_TEMPLATES = [
  {
    id: "explain",
    name: "Explain",
    prompt: "Explain this concept in simple terms: ",
    icon: "?",
  },
  {
    id: "code-review",
    name: "Code Review",
    prompt: "Review this code and suggest improvements:\n\n```\n",
    icon: "</>",
  },
  {
    id: "summarize",
    name: "Summarize",
    prompt: "Summarize the following text:\n\n",
    icon: "=",
  },
  {
    id: "translate",
    name: "Translate",
    prompt: "Translate the following to English:\n\n",
    icon: "A",
  },
  {
    id: "debug",
    name: "Debug",
    prompt: "Help me debug this issue:\n\n",
    icon: "!",
  },
  {
    id: "brainstorm",
    name: "Brainstorm",
    prompt: "Help me brainstorm ideas for: ",
    icon: "*",
  },
];

export default function MessageTemplates({ onSelect, isOpen, onClose }) {
  if (!isOpen) return null;

  return (
    <div className="templates-panel">
      <div className="templates-header">
        <span>Quick Prompts</span>
        <button className="templates-close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="templates-grid">
        {DEFAULT_TEMPLATES.map((template) => (
          <button
            key={template.id}
            className="template-btn"
            onClick={() => {
              onSelect(template.prompt);
              onClose();
            }}
          >
            <span className="template-icon">{template.icon}</span>
            <span className="template-name">{template.name}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
