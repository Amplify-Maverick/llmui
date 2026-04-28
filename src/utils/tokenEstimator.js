/**
 * Estimates the number of tokens in a text string.
 *
 * This uses a heuristic approach similar to how most LLM tokenizers work:
 * - ~4 characters per token for English text on average
 * - Words, punctuation, and whitespace all factor in
 *
 * For more accurate counts we'd need the model's actual tokenizer,
 * but this provides a reasonable live estimate.
 */
export function estimateTokens(text) {
  if (!text) return 0;

  // Heuristic: split on whitespace and punctuation boundaries,
  // then estimate sub-word tokens for longer words
  let tokens = 0;
  const words = text.split(/\s+/).filter(Boolean);

  for (const word of words) {
    if (word.length <= 4) {
      tokens += 1;
    } else if (word.length <= 8) {
      tokens += 2;
    } else {
      // Longer words tend to be split into multiple sub-word tokens
      tokens += Math.ceil(word.length / 4);
    }
  }

  // Account for whitespace / special tokens (roughly 10-15% overhead)
  return Math.max(1, Math.round(tokens * 1.1));
}

/**
 * Estimates total tokens for an array of chat messages,
 * including per-message overhead (role markers, special tokens).
 */
export function estimateConversationTokens(messages, systemPrompt = "") {
  let total = 0;

  // System prompt
  if (systemPrompt) {
    total += estimateTokens(systemPrompt) + 4; // role + formatting overhead
  }

  for (const msg of messages) {
    // Each message has ~4 tokens of overhead (role, delimiters)
    total += estimateTokens(msg.content) + 4;
  }

  // Base overhead for the conversation format
  total += 3;

  return total;
}

/**
 * Formats a token count for display (e.g. 1234 -> "1.2K")
 */
export function formatTokenCount(count) {
  if (count >= 1000000) {
    return `${(count / 1000000).toFixed(1)}M`;
  }
  if (count >= 10000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  if (count >= 1000) {
    return `${(count / 1000).toFixed(1)}K`;
  }
  return `${count}`;
}
