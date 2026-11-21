/**
 * Model API client for the OpenAI-compatible server (llama.cpp server, vLLM,
 * LM Studio, ...) — LLMUI's only model source.
 *
 * Requests go to /openai/v1 on the authenticated Express server, which
 * forwards them to OPENAI_BASE_URL (see server/openai.js). The tool loop runs
 * server-side at /api/chat-with-tools.
 *
 * chatStream() yields normalised chunks — { message: { content, thinking }, done, timings }.
 * `timings` is llama.cpp's server-side measurement (predicted_per_second,
 * prompt_per_second, ...), sent with the final chunk.
 */

import { authHeaders } from "./auth.js";

const BASE = "/openai/v1";

/**
 * Parse a text/event-stream body into the `data:` payloads of each event.
 * Buffers across network chunks so events split mid-line are handled.
 */
async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      // Events are separated by a blank line; tolerate \r\n line endings.
      let sep;
      while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, sep);
        buffer = buffer.slice(sep).replace(/^\r?\n\r?\n/, "");
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

class OpenAIAPI {
  async *chatStream(model, messages, options = {}) {
    const body = {
      model,
      messages: messages.map(toOpenAIMessage),
      stream: true,
    };
    if (options.temperature != null) body.temperature = options.temperature;
    if (options.maxTokens != null) body.max_tokens = options.maxTokens;
    // llama.cpp passes these through to the chat template (Qwen3, etc.).
    // Ignored by servers that don't support it.
    body.chat_template_kwargs = { enable_thinking: !!options.enableThinking };

    const response = await fetch(`${BASE}/chat/completions`, {
      method: "POST",
      headers: { ...(await authHeaders()), Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = JSON.parse(text).error?.message || text;
      } catch {
        // not JSON
      }
      throw new Error(message || `Chat request failed (${response.status})`);
    }

    for await (const data of readSSE(response.body)) {
      if (data === "[DONE]") {
        yield { message: { content: "" }, done: true };
        return;
      }
      let event;
      try {
        event = JSON.parse(data);
      } catch {
        continue; // skip malformed events
      }
      if (event.error) {
        throw new Error(event.error.message || String(event.error));
      }
      const choice = event.choices?.[0];
      const delta = choice?.delta || {};
      yield {
        message: {
          content: delta.content || "",
          thinking: delta.reasoning_content || "",
        },
        done: false,
        finishReason: choice?.finish_reason || null,
        timings: event.timings || null,
      };
    }
    // Stream ended without [DONE]
    yield { message: { content: "" }, done: true };
  }

  /**
   * Server-side tool loop. Yields NDJSON events:
   * { type: "content" | "tool_call" | "tool_result" | "done" | "error", ... }
   */
  async *chatStreamWithTools(model, messages, options = {}) {
    const response = await fetch("/api/chat-with-tools", {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify({
        model,
        messages,
        enabledTools: options.enabledTools || null,
        enableThinking: !!options.enableThinking,
        options: {
          modelOptions: {
            temperature: options.temperature,
            num_predict: options.maxTokens,
          },
        },
      }),
      signal: options.signal,
    });

    if (!response.ok) {
      const text = await response.text();
      let message = text;
      try {
        message = JSON.parse(text).error || text;
      } catch {
        // not JSON
      }
      throw new Error(message || "Failed to start chat with tools");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || ""; // keep a partial line for the next chunk
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            yield JSON.parse(line);
          } catch {
            // skip malformed lines
          }
        }
      }
      if (buffer.trim()) {
        try {
          yield JSON.parse(buffer);
        } catch {
          // skip malformed trailing line
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}

/** Yield each JSON object of an NDJSON response body (blank keepalive lines skipped). */
export async function* readNdjson(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          yield JSON.parse(line);
        } catch {
          // skip malformed lines
        }
      }
    }
    if (buffer.trim()) {
      try {
        yield JSON.parse(buffer);
      } catch {
        // skip malformed trailing line
      }
    }
  } finally {
    reader.releaseLock();
  }
}

async function errorFrom(response, fallback) {
  const body = await response.json().catch(() => ({}));
  const message = typeof body.error === "string" ? body.error : body.error?.message;
  return Object.assign(new Error(message || `${fallback} (${response.status})`), {
    status: response.status,
    code: body.code || body.error?.code || null,
    runId: body.runId || null,
  });
}

/**
 * Server-side runs (docs/api.md §4.1): the server stores the user message,
 * runs the model and stores the reply; these only watch and steer it.
 */
export const runsApi = {
  /** POST /api/conversations/:id/send. Resolves with the response whose body is the run's NDJSON events. */
  async send(conversationId, body, signal) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/send`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
      signal,
    });
    if (!response.ok) throw await errorFrom(response, "Send failed");
    return response;
  },

  /** Reattach: the run's events after `after` (0 = from the start), then live until it ends. */
  async attach(runId, after, signal) {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/events?after=${after || 0}`, {
      headers: await authHeaders(),
      signal,
    });
    if (!response.ok) throw await errorFrom(response, "Reattach failed");
    return response;
  },

  async cancel(runId) {
    const response = await fetch(`/api/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      headers: await authHeaders(),
    });
    if (!response.ok) throw await errorFrom(response, "Cancel failed");
    return response.json();
  },

  /**
   * POST /api/conversations/:id/compare: one user message, two models in
   * parallel. Resolves { compareGroup, userMessageId, runs: [snapshot, snapshot] }.
   */
  async compare(conversationId, body) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/compare`, {
      method: "POST",
      headers: await authHeaders(),
      body: JSON.stringify(body),
    });
    if (!response.ok) throw await errorFrom(response, "Compare failed");
    return response.json();
  },

  /** The runs of the chat's latest turn (two for a Compare), newest state. */
  async latestTurn(conversationId) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/runs`, {
      headers: await authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) return [];
    return (await response.json()).runs || [];
  },

  /** The chat's current or most recent run ({ status, ... }), or null. */
  async forConversation(conversationId) {
    const response = await fetch(`/api/conversations/${encodeURIComponent(conversationId)}/run`, {
      headers: await authHeaders(),
      cache: "no-store",
    });
    if (!response.ok) return null;
    return (await response.json()).run;
  },
};

/** Convert an app message ({ role, content, images?: [base64] }) to OpenAI format. */
function toOpenAIMessage(msg) {
  if (!msg.images || msg.images.length === 0) {
    return { role: msg.role, content: msg.content };
  }
  return {
    role: msg.role,
    content: [
      { type: "text", text: msg.content },
      ...msg.images.map((b64) => ({
        type: "image_url",
        image_url: { url: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}` },
      })),
    ],
  };
}

export const openaiApi = new OpenAIAPI();
export default OpenAIAPI;
