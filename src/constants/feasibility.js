// Shared labels/icons for the good/slow/poor hardware-fit rating returned by
// GET /ollama/local-capability (server/index.js getModelFeasibility), so every
// UI surface that shows a feasibility rating renders it identically.
export const FEASIBILITY_LABEL = {
  good: "Runs well",
  slow: "Slow",
  poor: "Not recommended",
};

export const FEASIBILITY_ICON = {
  good: "✓",
  slow: "~",
  poor: "✗",
};
