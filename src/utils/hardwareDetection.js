// GPU detection using WebGL
// This provides renderer info which usually contains the GPU name

const GPU_VRAM_DATABASE = {
  // NVIDIA GeForce RTX 40 Series
  "rtx 4090": 24,
  "rtx 4080 super": 16,
  "rtx 4080": 16,
  "rtx 4070 ti super": 16,
  "rtx 4070 ti": 12,
  "rtx 4070 super": 12,
  "rtx 4070": 12,
  "rtx 4060 ti": 8,
  "rtx 4060": 8,

  // NVIDIA GeForce RTX 30 Series
  "rtx 3090 ti": 24,
  "rtx 3090": 24,
  "rtx 3080 ti": 12,
  "rtx 3080": 10,
  "rtx 3070 ti": 8,
  "rtx 3070": 8,
  "rtx 3060 ti": 8,
  "rtx 3060": 12,
  "rtx 3050": 8,

  // NVIDIA GeForce RTX 20 Series
  "rtx 2080 ti": 11,
  "rtx 2080 super": 8,
  "rtx 2080": 8,
  "rtx 2070 super": 8,
  "rtx 2070": 8,
  "rtx 2060 super": 8,
  "rtx 2060": 6,

  // NVIDIA GeForce GTX 16 Series
  "gtx 1660 ti": 6,
  "gtx 1660 super": 6,
  "gtx 1660": 6,
  "gtx 1650 super": 4,
  "gtx 1650": 4,

  // NVIDIA GeForce GTX 10 Series
  "gtx 1080 ti": 11,
  "gtx 1080": 8,
  "gtx 1070 ti": 8,
  "gtx 1070": 8,
  "gtx 1060": 6,
  "gtx 1050 ti": 4,
  "gtx 1050": 2,

  // NVIDIA Professional
  "a100": 80,
  "a6000": 48,
  "a5000": 24,
  "a4000": 16,
  "a2000": 6,
  "rtx 6000": 48,
  "rtx 5000": 16,
  "rtx 4000": 8,
  "quadro rtx 8000": 48,
  "quadro rtx 6000": 24,
  "quadro rtx 5000": 16,

  // AMD Radeon RX 7000 Series
  "rx 7900 xtx": 24,
  "rx 7900 xt": 20,
  "rx 7900 gre": 16,
  "rx 7800 xt": 16,
  "rx 7700 xt": 12,
  "rx 7600 xt": 16,
  "rx 7600": 8,

  // AMD Radeon RX 6000 Series
  "rx 6950 xt": 16,
  "rx 6900 xt": 16,
  "rx 6800 xt": 16,
  "rx 6800": 16,
  "rx 6750 xt": 12,
  "rx 6700 xt": 12,
  "rx 6700": 10,
  "rx 6650 xt": 8,
  "rx 6600 xt": 8,
  "rx 6600": 8,
  "rx 6500 xt": 4,
  "rx 6400": 4,

  // AMD Radeon RX 5000 Series
  "rx 5700 xt": 8,
  "rx 5700": 8,
  "rx 5600 xt": 6,
  "rx 5500 xt": 8,

  // Apple Silicon (unified memory, estimate usable for ML)
  "apple m1": 8,
  "apple m1 pro": 16,
  "apple m1 max": 32,
  "apple m1 ultra": 64,
  "apple m2": 8,
  "apple m2 pro": 16,
  "apple m2 max": 32,
  "apple m2 ultra": 64,
  "apple m3": 8,
  "apple m3 pro": 18,
  "apple m3 max": 36,
  "apple m4": 16,
  "apple m4 pro": 24,
  "apple m4 max": 48,

  // Intel Arc
  "arc a770": 16,
  "arc a750": 8,
  "arc a580": 8,
  "arc a380": 6,
};

export function detectGPU() {
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl") || canvas.getContext("experimental-webgl");

    if (!gl) {
      return {
        detected: false,
        error: "WebGL not supported",
        renderer: null,
        vendor: null,
        vram: null,
      };
    }

    const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");

    let renderer = "Unknown";
    let vendor = "Unknown";

    if (debugInfo) {
      renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
      vendor = gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL);
    } else {
      renderer = gl.getParameter(gl.RENDERER);
      vendor = gl.getParameter(gl.VENDOR);
    }

    // Try to estimate VRAM from GPU name
    const vram = estimateVRAM(renderer);
    const tier = vram ? getModelTier(vram) : null;

    return {
      detected: true,
      renderer,
      vendor,
      vram,
      tier,
    };
  } catch (error) {
    return {
      detected: false,
      error: error.message,
      renderer: null,
      vendor: null,
      vram: null,
    };
  }
}

function estimateVRAM(renderer) {
  if (!renderer) return null;

  const normalized = renderer.toLowerCase();

  // Check against known GPUs
  for (const [gpu, vram] of Object.entries(GPU_VRAM_DATABASE)) {
    if (normalized.includes(gpu)) {
      return vram;
    }
  }

  // Try to extract from ANGLE strings like "ANGLE (NVIDIA, NVIDIA GeForce RTX 3080 Direct3D11...)"
  const angleMatch = normalized.match(/angle.*?(gtx|rtx|rx|radeon|geforce|arc|apple m\d)/i);
  if (angleMatch) {
    for (const [gpu, vram] of Object.entries(GPU_VRAM_DATABASE)) {
      if (normalized.includes(gpu)) {
        return vram;
      }
    }
  }

  return null;
}

function getModelTier(vram) {
  if (vram >= 24) {
    return {
      name: "Enthusiast",
      color: "#c4b5fd",
      description: "Can run 30B-70B models",
      models: ["llama3.1:70b-q4", "codellama:34b", "mixtral:8x7b", "qwen2.5:32b"],
    };
  } else if (vram >= 12) {
    return {
      name: "High End",
      color: "#60a5fa",
      description: "Can run 7B-13B models at high quality",
      models: ["llama3.1:8b", "mistral:7b", "codellama:13b-q4", "gemma2:9b"],
    };
  } else if (vram >= 8) {
    return {
      name: "Mid Range",
      color: "#6ee7b7",
      description: "Can run 7B models with quantization",
      models: ["llama3.2:3b", "mistral:7b-q4", "gemma2:9b-q4", "qwen2.5:7b-q4"],
    };
  } else if (vram >= 4) {
    return {
      name: "Entry Level",
      color: "#fcd34d",
      description: "Best for small models",
      models: ["tinyllama", "phi3:mini", "gemma:2b", "qwen2:0.5b"],
    };
  } else {
    return {
      name: "Limited",
      color: "#ff6b6b",
      description: "Very small models only",
      models: ["tinyllama", "qwen2:0.5b"],
    };
  }
}

export function parseGPUName(renderer) {
  if (!renderer) return "Unknown GPU";

  // Clean up ANGLE wrapper strings
  let cleaned = renderer
    .replace(/ANGLE \([^,]+,\s*/i, "")
    .replace(/\s*Direct3D\d+.*$/i, "")
    .replace(/\s*vs_\d+.*$/i, "")
    .replace(/\)$/, "")
    .trim();

  // If still has ANGLE prefix, try another pattern
  if (cleaned.toLowerCase().startsWith("angle")) {
    const match = renderer.match(/ANGLE.*?(GeForce|Radeon|Intel|Apple|Arc)[\w\s]+/i);
    if (match) {
      cleaned = match[0].replace(/ANGLE \([^,]+,\s*/i, "").trim();
    }
  }

  return cleaned || renderer;
}
