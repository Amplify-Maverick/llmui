// Shared GPU stats module
// Used by both the /api/gpu HTTP endpoint and Telegram /hwinfo command

import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const NVIDIA_SMI_ARGS = [
  "--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,fan.speed,power.draw,power.limit,clocks.current.graphics,clocks.current.memory",
  "--format=csv,noheader,nounits",
];

const GPU_CACHE_TTL_MS = 1000;
let gpuCache = { data: null, timestamp: 0 };

/**
 * Get GPU stats from nvidia-smi
 * Results are cached for 1 second to avoid excessive calls.
 *
 * @returns {Promise<{ok: boolean, gpus?: Array, timestamp?: number, error?: string}>}
 */
export async function getGpuStats() {
  const now = Date.now();

  // Return cached data if still fresh
  if (gpuCache.data && now - gpuCache.timestamp < GPU_CACHE_TTL_MS) {
    return gpuCache.data;
  }

  try {
    const { stdout } = await execFileAsync("nvidia-smi", NVIDIA_SMI_ARGS, {
      timeout: 3000,
    });

    const raw = stdout.trim();
    const gpus = raw.split("\n").map((line) => {
      const parts = line.split(",").map((s) => s.trim());
      return {
        index: parseInt(parts[0], 10),
        name: parts[1],
        utilization: parseFloat(parts[2]),       // %
        memoryUsed: parseFloat(parts[3]),        // MiB
        memoryTotal: parseFloat(parts[4]),       // MiB
        temperature: parseFloat(parts[5]),       // °C
        fanSpeed: parseFloat(parts[6]),          // %
        powerDraw: parseFloat(parts[7]),         // W
        powerLimit: parseFloat(parts[8]),        // W
        clockGraphics: parseFloat(parts[9]),     // MHz
        clockMemory: parseFloat(parts[10]),      // MHz
      };
    });

    const response = { ok: true, gpus, timestamp: now };
    gpuCache = { data: response, timestamp: now };
    return response;
  } catch (err) {
    // Map errors to user-friendly messages
    let errorMessage;
    if (err.code === 'ENOENT') {
      errorMessage = 'nvidia-smi not found';
    } else if (err.code === 'ETIMEDOUT' || err.killed) {
      errorMessage = 'nvidia-smi timed out (3s limit)';
    } else if (err.code) {
      errorMessage = 'nvidia-smi returned an error';
    } else {
      errorMessage = 'Unknown error reading GPU';
    }

    return { ok: false, error: errorMessage };
  }
}

/**
 * Get color indicator emoji for utilization percentage
 * @param {number} pct - Utilization percentage (0-100)
 * @returns {string} - Color emoji
 */
export function utilizationIndicator(pct) {
  if (pct < 70) return '🟢';
  if (pct <= 90) return '🟡';
  return '🔴';
}

/**
 * Get color indicator emoji for temperature
 * @param {number} temp - Temperature in Celsius
 * @returns {string} - Color emoji
 */
export function temperatureIndicator(temp) {
  if (temp < 70) return '🟢';
  if (temp <= 85) return '🟡';
  return '🔴';
}

/**
 * Get color indicator emoji for VRAM percentage
 * @param {number} pct - VRAM usage percentage (0-100)
 * @returns {string} - Color emoji
 */
export function vramIndicator(pct) {
  if (pct < 80) return '🟢';
  if (pct <= 95) return '🟡';
  return '🔴';
}
