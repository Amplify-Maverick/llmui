export const MODEL_TIERS = [
  {
    name: "Entry Level",
    vram: "4-6 GB",
    color: "#fcd34d",
    gpus: "GTX 1650, RTX 3050, RX 6500 XT",
    notes: "Small models, good for basic tasks and testing",
  },
  {
    name: "Mid Range",
    vram: "8 GB",
    color: "#6ee7b7",
    gpus: "RTX 3060, RTX 4060, RX 6600, RX 7600",
    notes: "7B parameter models with 4-bit quantization work well",
  },
  {
    name: "High End",
    vram: "12-16 GB",
    color: "#60a5fa",
    gpus: "RTX 3080, RTX 4070, RTX 4080, RX 7800 XT",
    notes: "Run 7B-13B models at higher quality quantization",
  },
  {
    name: "Enthusiast",
    vram: "24+ GB",
    color: "#c4b5fd",
    gpus: "RTX 3090, RTX 4090, A5000, A6000",
    notes: "Run large 30B-70B models, multiple models simultaneously",
  },
];
