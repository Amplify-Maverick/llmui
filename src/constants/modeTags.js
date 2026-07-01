// Well-known conversation tags auto-applied at creation time based on which
// Ollama target (activeTarget) was active — see src/constants/feasibility.js
// for the related hardware-fit ratings. IDs must stay in sync with the
// literal strings used in tui/App.jsx, which creates conversations without
// importing from src/.
export const MODE_TAG_IDS = {
  local: "mode-mini",
  remote: "mode-gpu",
};

export const MODE_TAGS = [
  { id: MODE_TAG_IDS.local, label: "Mini Mode", color: "#6ee7b7" },
  { id: MODE_TAG_IDS.remote, label: "GPU Mode", color: "#60a5fa" },
];
