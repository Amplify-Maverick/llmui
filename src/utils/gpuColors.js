/**
 * Shared GPU metric color functions used by GpuStats and GpuMini.
 */

export function tempColor(temp) {
  if (temp < 50) return "#6ee7b7";
  if (temp < 70) return "#fcd34d";
  if (temp < 85) return "#fb923c";
  return "#ff6b6b";
}

export function utilizationColor(pct) {
  if (pct < 30) return "#6ee7b7";
  if (pct < 70) return "#60a5fa";
  if (pct < 90) return "#fcd34d";
  return "#fb923c";
}

export function vramColor(pct) {
  if (pct < 50) return "#60a5fa";
  if (pct < 80) return "#fcd34d";
  return "#fb923c";
}
