/**
 * Generation speed for a streamed reply.
 *
 * Prefers llama.cpp's own `timings` (sent with the final chunk):
 * predicted_per_second = writing, prompt_per_second = reading the prompt.
 * Without timings, falls back to client timing measured from the first
 * generated token. Model load and prompt processing are excluded, which
 * matters because a request to an unloaded model can wait many seconds before
 * the first token.
 */
export function streamSpeeds(timings, tokenCount, firstTokenTime, now = Date.now()) {
  if (timings?.predicted_per_second > 0) {
    return {
      tokensPerSec: timings.predicted_per_second,
      promptPerSec: timings.prompt_per_second > 0 ? timings.prompt_per_second : null,
      source: "server",
    };
  }
  return { tokensPerSec: liveTokensPerSec(tokenCount, firstTokenTime, now), promptPerSec: null, source: "client" };
}

/** Tokens after the first, over the time since the first arrived. */
export function liveTokensPerSec(tokenCount, firstTokenTime, now = Date.now()) {
  if (!firstTokenTime || tokenCount < 2) return null;
  const seconds = (now - firstTokenTime) / 1000;
  return seconds > 0 ? (tokenCount - 1) / seconds : null;
}
