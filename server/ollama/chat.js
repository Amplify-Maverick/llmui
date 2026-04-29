// Shared Ollama chat streaming module
// Used by both HTTP proxy endpoints and Telegram bot

/**
 * Stream a chat completion from Ollama
 *
 * @param {Object} options
 * @param {string} options.ollamaUrl - Base URL for Ollama API
 * @param {string} options.model - Model name to use
 * @param {Array} options.messages - Chat messages array
 * @param {Object} options.modelOptions - Model options (temperature, etc.)
 * @param {AbortSignal} options.signal - Optional AbortController signal for cancellation
 * @param {Function} options.onToken - Callback for each token: (token: string) => void
 * @param {Function} options.onComplete - Callback on completion: (fullContent: string, meta: Object) => void
 * @param {Function} options.onError - Callback on error: (error: Error) => void
 * @returns {Promise<void>}
 */
export async function streamChat({
  ollamaUrl,
  model,
  messages,
  modelOptions = {},
  signal,
  onToken,
  onComplete,
  onError
}) {
  let fullContent = '';
  let meta = {};

  try {
    const response = await fetch(`${ollamaUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages,
        stream: true,
        options: modelOptions
      }),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama error (${response.status}): ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);

          if (parsed.message?.content) {
            const token = parsed.message.content;
            fullContent += token;
            if (onToken) onToken(token);
          }

          if (parsed.done) {
            meta = {
              model: parsed.model,
              totalDuration: parsed.total_duration,
              loadDuration: parsed.load_duration,
              promptEvalCount: parsed.prompt_eval_count,
              promptEvalDuration: parsed.prompt_eval_duration,
              evalCount: parsed.eval_count,
              evalDuration: parsed.eval_duration
            };

            // Calculate tokens per second
            if (parsed.eval_count && parsed.eval_duration) {
              meta.tokensPerSec = (parsed.eval_count / parsed.eval_duration) * 1e9;
            }
          }
        } catch (parseErr) {
          // Skip malformed JSON lines
        }
      }
    }

    // Process any remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        if (parsed.message?.content) {
          fullContent += parsed.message.content;
          if (onToken) onToken(parsed.message.content);
        }
      } catch {
        // Skip malformed JSON
      }
    }

    if (onComplete) onComplete(fullContent, meta);
  } catch (err) {
    if (err.name === 'AbortError') {
      // Stream was cancelled - complete with what we have
      if (onComplete) onComplete(fullContent, { ...meta, aborted: true });
    } else {
      if (onError) onError(err);
    }
  }
}

/**
 * Stream a model pull from Ollama
 *
 * @param {Object} options
 * @param {string} options.ollamaUrl - Base URL for Ollama API
 * @param {string} options.name - Model name to pull
 * @param {AbortSignal} options.signal - Optional AbortController signal
 * @param {Function} options.onProgress - Callback for progress: (status: string, completed?: number, total?: number) => void
 * @param {Function} options.onComplete - Callback on completion: () => void
 * @param {Function} options.onError - Callback on error: (error: Error) => void
 * @returns {Promise<void>}
 */
export async function streamPull({
  ollamaUrl,
  name,
  signal,
  onProgress,
  onComplete,
  onError
}) {
  try {
    const response = await fetch(`${ollamaUrl}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
      signal
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Ollama pull error (${response.status}): ${errorText}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        if (!line.trim()) continue;

        try {
          const parsed = JSON.parse(line);
          if (onProgress) {
            onProgress(parsed.status, parsed.completed, parsed.total);
          }
        } catch {
          // Skip malformed JSON
        }
      }
    }

    if (onComplete) onComplete();
  } catch (err) {
    if (err.name === 'AbortError') {
      if (onComplete) onComplete();
    } else {
      if (onError) onError(err);
    }
  }
}

/**
 * Check if a model is installed locally
 *
 * @param {string} ollamaUrl - Base URL for Ollama API
 * @param {string} modelName - Model name to check
 * @returns {Promise<boolean>}
 */
export async function isModelInstalled(ollamaUrl, modelName) {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) return false;

    const data = await response.json();
    const models = data.models || [];

    // Check for exact match or name without tag
    const baseName = modelName.split(':')[0];
    return models.some(m =>
      m.name === modelName ||
      m.name === `${baseName}:latest` ||
      m.name.startsWith(`${baseName}:`)
    );
  } catch {
    return false;
  }
}

/**
 * Get list of installed models
 *
 * @param {string} ollamaUrl - Base URL for Ollama API
 * @returns {Promise<Array>}
 */
export async function getInstalledModels(ollamaUrl) {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`);
    if (!response.ok) return [];

    const data = await response.json();
    return data.models || [];
  } catch {
    return [];
  }
}

/**
 * Check if Ollama server is reachable
 *
 * @param {string} ollamaUrl - Base URL for Ollama API
 * @returns {Promise<boolean>}
 */
export async function isOllamaReachable(ollamaUrl) {
  try {
    const response = await fetch(`${ollamaUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch {
    return false;
  }
}
