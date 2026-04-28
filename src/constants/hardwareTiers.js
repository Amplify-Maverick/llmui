export const MODEL_TIERS = [
  {
    name: "Entry Level",
    vram: "4-6 GB",
    color: "#fcd34d",
    gpus: "GTX 1650, RTX 3050, RX 6500 XT",
    models: ["tinyllama", "phi3:mini", "gemma:2b", "qwen2:0.5b"],
    notes: "Small models, good for basic tasks and testing",
  },
  {
    name: "Mid Range",
    vram: "8 GB",
    color: "#6ee7b7",
    gpus: "RTX 3060, RTX 4060, RX 6600, RX 7600",
    models: ["llama3.2:3b", "mistral:7b-q4", "gemma2:9b-q4", "qwen2.5:7b-q4"],
    notes: "7B parameter models with 4-bit quantization work well",
  },
  {
    name: "High End",
    vram: "12-16 GB",
    color: "#60a5fa",
    gpus: "RTX 3080, RTX 4070, RTX 4080, RX 7800 XT",
    models: ["llama3.1:8b", "mistral:7b", "codellama:13b-q4", "gemma2:9b"],
    notes: "Run 7B-13B models at higher quality quantization",
  },
  {
    name: "Enthusiast",
    vram: "24+ GB",
    color: "#c4b5fd",
    gpus: "RTX 3090, RTX 4090, A5000, A6000",
    models: ["llama3.1:70b-q4", "codellama:34b", "mixtral:8x7b", "qwen2.5:32b"],
    notes: "Run large 30B-70B models, multiple models simultaneously",
  },
];
