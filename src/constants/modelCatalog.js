/**
 * Curated catalog of popular Ollama models with VRAM requirements.
 *
 * VRAM estimates use the formula:
 *   Q4_K_M ≈ 0.6 GB per billion params + ~0.5 GB overhead
 *   Q8     ≈ 1.1 GB per billion params + ~0.5 GB overhead
 *   FP16   ≈ 2.0 GB per billion params + ~0.5 GB overhead
 *
 * These are approximate and may vary by model architecture.
 */

export const MODEL_CATEGORIES = [
  { id: "all", label: "All Models" },
  { id: "general", label: "General" },
  { id: "code", label: "Code" },
  { id: "reasoning", label: "Reasoning" },
  { id: "vision", label: "Vision" },
  { id: "embedding", label: "Embedding" },
  { id: "small", label: "Small / Fast" },
];

export const MODEL_CATALOG = [
  // ── Llama 3.x ────────────────────────────────────────────
  {
    name: "llama3.2",
    displayName: "Llama 3.2",
    description: "Meta's latest compact models. Great balance of size and capability.",
    categories: ["general", "small"],
    toolSupport: true,
    variants: [
      { tag: "1b", params: "1B", vramGb: 1.2, quantization: "Q4_K_M", diskGb: 1.3 },
      { tag: "3b", params: "3B", vramGb: 2.3, quantization: "Q4_K_M", diskGb: 2.0 },
    ],
  },
  {
    name: "llama3.1",
    displayName: "Llama 3.1",
    description: "Meta's powerful open-weight model family with tool use support.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "8b", params: "8B", vramGb: 5.5, quantization: "Q4_K_M", diskGb: 4.7 },
      { tag: "70b", params: "70B", vramGb: 43, quantization: "Q4_K_M", diskGb: 40 },
      { tag: "405b", params: "405B", vramGb: 244, quantization: "Q4_K_M", diskGb: 231 },
    ],
  },
  {
    name: "llama3.3",
    displayName: "Llama 3.3",
    description: "Meta's Llama 3.3 70B — performance competitive with larger models.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "70b", params: "70B", vramGb: 43, quantization: "Q4_K_M", diskGb: 40 },
    ],
  },

  // ── Qwen ─────────────────────────────────────────────────
  {
    name: "qwen3",
    displayName: "Qwen 3",
    description: "Alibaba's latest flagship model series. Excellent multilingual and reasoning.",
    categories: ["general", "reasoning"],
    toolSupport: true,
    variants: [
      { tag: "0.6b", params: "0.6B", vramGb: 0.9, quantization: "Q4_K_M", diskGb: 0.5 },
      { tag: "1.7b", params: "1.7B", vramGb: 1.5, quantization: "Q4_K_M", diskGb: 1.1 },
      { tag: "4b", params: "4B", vramGb: 3.0, quantization: "Q4_K_M", diskGb: 2.6 },
      { tag: "8b", params: "8B", vramGb: 5.5, quantization: "Q4_K_M", diskGb: 4.9 },
      { tag: "14b", params: "14B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 8.7 },
      { tag: "30b", params: "30B", vramGb: 19, quantization: "Q4_K_M", diskGb: 18 },
      { tag: "32b", params: "32B", vramGb: 20, quantization: "Q4_K_M", diskGb: 19 },
      { tag: "235b", params: "235B", vramGb: 142, quantization: "Q4_K_M", diskGb: 135 },
    ],
  },
  {
    name: "qwen2.5",
    displayName: "Qwen 2.5",
    description: "Strong all-around model with excellent tool calling. Good for coding too.",
    categories: ["general", "code"],
    toolSupport: true,
    variants: [
      { tag: "0.5b", params: "0.5B", vramGb: 0.8, quantization: "Q4_K_M", diskGb: 0.4 },
      { tag: "1.5b", params: "1.5B", vramGb: 1.4, quantization: "Q4_K_M", diskGb: 1.0 },
      { tag: "3b", params: "3B", vramGb: 2.3, quantization: "Q4_K_M", diskGb: 2.0 },
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 4.4 },
      { tag: "14b", params: "14B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 8.7 },
      { tag: "32b", params: "32B", vramGb: 20, quantization: "Q4_K_M", diskGb: 19 },
      { tag: "72b", params: "72B", vramGb: 44, quantization: "Q4_K_M", diskGb: 42 },
    ],
  },
  {
    name: "qwen2.5-coder",
    displayName: "Qwen 2.5 Coder",
    description: "Purpose-built coding model. Excels at code generation, completion, and explanation.",
    categories: ["code"],
    toolSupport: true,
    variants: [
      { tag: "1.5b", params: "1.5B", vramGb: 1.4, quantization: "Q4_K_M", diskGb: 1.0 },
      { tag: "3b", params: "3B", vramGb: 2.3, quantization: "Q4_K_M", diskGb: 2.0 },
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 4.4 },
      { tag: "14b", params: "14B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 8.7 },
      { tag: "32b", params: "32B", vramGb: 20, quantization: "Q4_K_M", diskGb: 19 },
    ],
  },

  // ── Mistral / Mixtral ────────────────────────────────────
  {
    name: "mistral",
    displayName: "Mistral",
    description: "Mistral AI's efficient 7B model. Great performance for its size.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 4.1 },
    ],
  },
  {
    name: "mistral-small",
    displayName: "Mistral Small",
    description: "Mistral's 24B model optimized for efficiency and strong reasoning.",
    categories: ["general", "reasoning"],
    toolSupport: true,
    variants: [
      { tag: "24b", params: "24B", vramGb: 15, quantization: "Q4_K_M", diskGb: 14 },
    ],
  },
  {
    name: "mixtral",
    displayName: "Mixtral 8x7B",
    description: "Mixture-of-experts model. Uses only 2 experts per token for efficiency.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "8x7b", params: "47B (8×7B MoE)", vramGb: 26, quantization: "Q4_K_M", diskGb: 26 },
    ],
  },

  // ── Gemma ────────────────────────────────────────────────
  {
    name: "gemma3",
    displayName: "Gemma 3",
    description: "Google's latest Gemma models. Strong vision and text capabilities.",
    categories: ["general", "vision"],
    toolSupport: false,
    variants: [
      { tag: "1b", params: "1B", vramGb: 1.2, quantization: "Q4_K_M", diskGb: 0.8 },
      { tag: "4b", params: "4B", vramGb: 3.0, quantization: "Q4_K_M", diskGb: 2.5 },
      { tag: "12b", params: "12B", vramGb: 8.0, quantization: "Q4_K_M", diskGb: 7.6 },
      { tag: "27b", params: "27B", vramGb: 17, quantization: "Q4_K_M", diskGb: 16 },
    ],
  },
  {
    name: "gemma2",
    displayName: "Gemma 2",
    description: "Google's previous gen Gemma. Solid general-purpose performance.",
    categories: ["general"],
    toolSupport: false,
    variants: [
      { tag: "2b", params: "2B", vramGb: 1.8, quantization: "Q4_K_M", diskGb: 1.6 },
      { tag: "9b", params: "9B", vramGb: 6.0, quantization: "Q4_K_M", diskGb: 5.4 },
      { tag: "27b", params: "27B", vramGb: 17, quantization: "Q4_K_M", diskGb: 16 },
    ],
  },

  // ── DeepSeek ─────────────────────────────────────────────
  {
    name: "deepseek-r1",
    displayName: "DeepSeek R1",
    description: "DeepSeek's reasoning model with chain-of-thought. Strong at math and logic.",
    categories: ["reasoning"],
    toolSupport: false,
    variants: [
      { tag: "1.5b", params: "1.5B", vramGb: 1.4, quantization: "Q4_K_M", diskGb: 1.1 },
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 4.7 },
      { tag: "8b", params: "8B", vramGb: 5.5, quantization: "Q4_K_M", diskGb: 4.9 },
      { tag: "14b", params: "14B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 9.0 },
      { tag: "32b", params: "32B", vramGb: 20, quantization: "Q4_K_M", diskGb: 19 },
      { tag: "70b", params: "70B", vramGb: 43, quantization: "Q4_K_M", diskGb: 42 },
      { tag: "671b", params: "671B", vramGb: 404, quantization: "Q4_K_M", diskGb: 394 },
    ],
  },
  {
    name: "deepseek-coder-v2",
    displayName: "DeepSeek Coder V2",
    description: "Powerful open-source coding model from DeepSeek.",
    categories: ["code"],
    toolSupport: false,
    variants: [
      { tag: "16b", params: "16B", vramGb: 10, quantization: "Q4_K_M", diskGb: 8.9 },
    ],
  },

  // ── Phi ──────────────────────────────────────────────────
  {
    name: "phi4",
    displayName: "Phi-4",
    description: "Microsoft's latest small language model. Surprisingly capable for its size.",
    categories: ["general", "small"],
    toolSupport: false,
    variants: [
      { tag: "14b", params: "14B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 8.4 },
    ],
  },
  {
    name: "phi4-mini",
    displayName: "Phi-4 Mini",
    description: "Microsoft's ultra-compact model. Good for edge and resource-constrained use.",
    categories: ["general", "small", "reasoning"],
    toolSupport: true,
    variants: [
      { tag: "3.8b", params: "3.8B", vramGb: 2.8, quantization: "Q4_K_M", diskGb: 2.4 },
    ],
  },
  {
    name: "phi3",
    displayName: "Phi-3",
    description: "Microsoft's compact but powerful model. Great for resource-constrained setups.",
    categories: ["general", "small"],
    toolSupport: false,
    variants: [
      { tag: "mini", params: "3.8B", vramGb: 2.8, quantization: "Q4_K_M", diskGb: 2.3 },
      { tag: "medium", params: "14B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 7.9 },
    ],
  },

  // ── Code-focused models ──────────────────────────────────
  {
    name: "codellama",
    displayName: "Code Llama",
    description: "Meta's code-specialized Llama. Good for code generation and infilling.",
    categories: ["code"],
    toolSupport: false,
    variants: [
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 3.8 },
      { tag: "13b", params: "13B", vramGb: 8.5, quantization: "Q4_K_M", diskGb: 7.4 },
      { tag: "34b", params: "34B", vramGb: 21, quantization: "Q4_K_M", diskGb: 19 },
      { tag: "70b", params: "70B", vramGb: 43, quantization: "Q4_K_M", diskGb: 38 },
    ],
  },
  {
    name: "starcoder2",
    displayName: "StarCoder 2",
    description: "BigCode's code generation model trained on The Stack v2.",
    categories: ["code"],
    toolSupport: false,
    variants: [
      { tag: "3b", params: "3B", vramGb: 2.3, quantization: "Q4_K_M", diskGb: 1.7 },
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 4.0 },
      { tag: "15b", params: "15B", vramGb: 10, quantization: "Q4_K_M", diskGb: 8.9 },
    ],
  },

  // ── Vision Models ────────────────────────────────────────
  {
    name: "llava",
    displayName: "LLaVA",
    description: "Vision-language model. Can describe images and answer questions about them.",
    categories: ["vision"],
    toolSupport: false,
    variants: [
      { tag: "7b", params: "7B", vramGb: 5.5, quantization: "Q4_K_M", diskGb: 4.7 },
      { tag: "13b", params: "13B", vramGb: 9.0, quantization: "Q4_K_M", diskGb: 8.0 },
      { tag: "34b", params: "34B", vramGb: 22, quantization: "Q4_K_M", diskGb: 20 },
    ],
  },
  {
    name: "llama3.2-vision",
    displayName: "Llama 3.2 Vision",
    description: "Meta's multimodal model with image understanding capabilities.",
    categories: ["vision", "general"],
    toolSupport: false,
    variants: [
      { tag: "11b", params: "11B", vramGb: 8.0, quantization: "Q4_K_M", diskGb: 7.9 },
      { tag: "90b", params: "90B", vramGb: 55, quantization: "Q4_K_M", diskGb: 55 },
    ],
  },
  {
    name: "moondream",
    displayName: "Moondream",
    description: "Tiny but capable vision model. Great for image understanding on limited hardware.",
    categories: ["vision", "small"],
    toolSupport: false,
    variants: [
      { tag: "1.8b", params: "1.8B", vramGb: 1.6, quantization: "Q4_K_M", diskGb: 1.7 },
    ],
  },

  // ── Embedding Models ─────────────────────────────────────
  {
    name: "nomic-embed-text",
    displayName: "Nomic Embed Text",
    description: "High-performance text embedding model for RAG and semantic search.",
    categories: ["embedding"],
    toolSupport: false,
    variants: [
      { tag: "latest", params: "137M", vramGb: 0.3, quantization: "FP16", diskGb: 0.3 },
    ],
  },
  {
    name: "mxbai-embed-large",
    displayName: "MxBai Embed Large",
    description: "mixedbread.ai's large embedding model. State-of-the-art retrieval performance.",
    categories: ["embedding"],
    toolSupport: false,
    variants: [
      { tag: "latest", params: "335M", vramGb: 0.7, quantization: "FP16", diskGb: 0.7 },
    ],
  },
  {
    name: "all-minilm",
    displayName: "All-MiniLM",
    description: "Lightweight sentence embedding model. Fast and memory efficient.",
    categories: ["embedding", "small"],
    toolSupport: false,
    variants: [
      { tag: "latest", params: "23M", vramGb: 0.1, quantization: "FP16", diskGb: 0.05 },
    ],
  },

  // ── Other Popular Models ─────────────────────────────────
  {
    name: "command-r",
    displayName: "Command R",
    description: "Cohere's retrieval-augmented generation model with tool calling.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "35b", params: "35B", vramGb: 22, quantization: "Q4_K_M", diskGb: 20 },
    ],
  },
  {
    name: "command-r-plus",
    displayName: "Command R+",
    description: "Cohere's larger RAG model. Best-in-class retrieval and tool use.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "104b", params: "104B", vramGb: 63, quantization: "Q4_K_M", diskGb: 59 },
    ],
  },
  {
    name: "tinyllama",
    displayName: "TinyLlama",
    description: "Ultra-small 1.1B model. Perfect for testing and very limited hardware.",
    categories: ["small"],
    toolSupport: false,
    variants: [
      { tag: "latest", params: "1.1B", vramGb: 1.1, quantization: "Q4_K_M", diskGb: 0.6 },
    ],
  },
  {
    name: "orca-mini",
    displayName: "Orca Mini",
    description: "Compact instruction-following model. Good for simple tasks on limited hardware.",
    categories: ["general", "small"],
    toolSupport: false,
    variants: [
      { tag: "3b", params: "3B", vramGb: 2.3, quantization: "Q4_K_M", diskGb: 2.0 },
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 3.8 },
      { tag: "13b", params: "13B", vramGb: 8.5, quantization: "Q4_K_M", diskGb: 7.4 },
    ],
  },
  {
    name: "granite3.3",
    displayName: "Granite 3.3",
    description: "IBM's enterprise-grade model with strong tool calling support.",
    categories: ["general"],
    toolSupport: true,
    variants: [
      { tag: "2b", params: "2B", vramGb: 1.8, quantization: "Q4_K_M", diskGb: 1.6 },
      { tag: "8b", params: "8B", vramGb: 5.5, quantization: "Q4_K_M", diskGb: 4.9 },
    ],
  },
  {
    name: "falcon3",
    displayName: "Falcon 3",
    description: "TII's latest Falcon model family. Strong multilingual performance.",
    categories: ["general"],
    toolSupport: false,
    variants: [
      { tag: "1b", params: "1B", vramGb: 1.2, quantization: "Q4_K_M", diskGb: 0.8 },
      { tag: "3b", params: "3B", vramGb: 2.3, quantization: "Q4_K_M", diskGb: 2.0 },
      { tag: "7b", params: "7B", vramGb: 5.0, quantization: "Q4_K_M", diskGb: 4.3 },
      { tag: "10b", params: "10B", vramGb: 6.5, quantization: "Q4_K_M", diskGb: 6.1 },
    ],
  },
];

/**
 * Get compatibility status for a model variant given available VRAM.
 * Returns: "excellent" | "good" | "tight" | "insufficient" | "unknown"
 */
export function getCompatibility(vramRequired, vramAvailable) {
  if (vramAvailable == null) return "unknown";
  const ratio = vramAvailable / vramRequired;
  if (ratio >= 1.5) return "excellent";   // Plenty of room
  if (ratio >= 1.15) return "good";        // Comfortable fit
  if (ratio >= 0.9) return "tight";       // Might work with CPU offloading
  return "insufficient";                   // Won't fit
}

export const COMPAT_LABELS = {
  excellent: { label: "Excellent", color: "#6ee7b7", icon: "✓" },
  good: { label: "Good fit", color: "#60a5fa", icon: "✓" },
  tight: { label: "Tight fit", color: "#fcd34d", icon: "⚠" },
  insufficient: { label: "Insufficient", color: "#ff6b6b", icon: "✕" },
  unknown: { label: "Unknown", color: "#8a8a9a", icon: "?" },
};

// Sort order for surfacing the best-fitting models first (lower = better fit).
export const COMPAT_RANK = { excellent: 0, good: 1, tight: 2, insufficient: 3, unknown: 4 };

/**
 * Pick the largest variant of a model that comfortably fits the available
 * VRAM/RAM, falling back to the smallest variant if none fit (or if
 * available capacity is unknown).
 */
export function pickBestVariant(model, vramAvailable) {
  if (!vramAvailable) return model.variants[0];
  const fitting = model.variants.filter((v) => {
    const compat = getCompatibility(v.vramGb, vramAvailable);
    return compat === "excellent" || compat === "good";
  });
  return fitting.length > 0 ? fitting[fitting.length - 1] : model.variants[0];
}
