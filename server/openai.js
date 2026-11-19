/**
 * OpenAI-compatible backend (llama.cpp server, vLLM, LM Studio, ...).
 *
 * This is LLMUI's only model source.
 *
 * - `openaiRouter`: authenticated streaming passthrough mounted at /openai/v1.
 *   The browser never talks to the upstream directly.
 * - `streamOpenAITurn`: one model turn for the server-side tool loop, parsing
 *   SSE and accumulating streamed tool-call deltas.
 *
 * Upstream base URL comes from OPENAI_BASE_URL (must include the /v1 suffix).
 */

import express from "express";

export const OPENAI_BASE_URL = (
  process.env.OPENAI_BASE_URL || "http://100.118.190.15:8081/v1"
).replace(/\/+$/, "");

// ------------------------------------------------------------
// SSE parsing
// ------------------------------------------------------------

/** Yield the `data:` payload of each SSE event, buffering across chunks. */
export async function* readSSE(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let match;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        const rawEvent = buffer.slice(0, match.index);
        buffer = buffer.slice(match.index + match[0].length);
        const data = rawEvent
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).replace(/^ /, ""))
          .join("\n");
        if (data) yield data;
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // already released
    }
  }
}

async function upstreamError(response) {
  const text = await response.text();
  try {
    return JSON.parse(text).error?.message || text;
  } catch {
    return text || `Upstream error (${response.status})`;
  }
}

// ------------------------------------------------------------
// Message conversion (app message shape → OpenAI)
// ------------------------------------------------------------

/** Convert an app message ({ role, content, images?: [base64] }) to OpenAI format. */
export function toOpenAIMessage(msg) {
  if (!msg.images || msg.images.length === 0) {
    return { role: msg.role, content: msg.content };
  }
  return {
    role: msg.role,
    content: [
      { type: "text", text: msg.content },
      ...msg.images.map((b64) => ({
        type: "image_url",
        image_url: {
          url: b64.startsWith("data:") ? b64 : `data:image/png;base64,${b64}`,
        },
      })),
    ],
  };
}

// ------------------------------------------------------------
// Authenticated passthrough
// ------------------------------------------------------------

/**
 * Forward a request upstream and pipe the response back unchanged, chunk by
 * chunk. Aborts the upstream request if the client disconnects so the model
 * stops generating.
 */
async function forward(req, res, upstreamPath, init = {}) {
  const controller = new AbortController();
  res.on("close", () => {
    if (!res.writableFinished) controller.abort();
  });

  try {
    const response = await fetch(`${OPENAI_BASE_URL}${upstreamPath}`, {
      ...init,
      signal: controller.signal,
    });

    res.status(response.status);
    const contentType = response.headers.get("content-type");
    if (contentType) res.setHeader("Content-Type", contentType);
    if (contentType?.includes("text/event-stream")) {
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("X-Accel-Buffering", "no"); // nginx: don't buffer SSE
    }
    res.flushHeaders();

    for await (const chunk of response.body) {
      res.write(chunk);
    }
    res.end();
  } catch (err) {
    if (err.name === "AbortError") {
      if (!res.writableEnded) res.end();
      return;
    }
    console.error(`Error proxying ${upstreamPath} to OpenAI-compatible server:`, err.message);
    if (!res.headersSent) {
      res.status(502).json({
        error: { message: "Failed to connect to OpenAI-compatible server" },
      });
    } else if (!res.writableEnded) {
      res.end();
    }
  }
}

export const openaiRouter = express.Router();

openaiRouter.get("/models", (req, res) => forward(req, res, "/models"));

openaiRouter.post("/chat/completions", (req, res) =>
  forward(req, res, "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: req.body?.stream ? "text/event-stream" : "application/json",
    },
    body: JSON.stringify(req.body),
  })
);

// ------------------------------------------------------------
// Tool loop: a single streamed turn
// ------------------------------------------------------------

/**
 * Run one streamed chat turn against the OpenAI-compatible server.
 * Calls onContent(text) for each content delta as it arrives.
 * Returns { content, toolCalls } with tool calls in OpenAI format
 * ({ id, type, function: { name, arguments: string } }).
 * Throws an Error with the upstream message on a non-2xx response.
 */
export async function streamOpenAITurn({
  model,
  messages,
  tools,
  modelOptions = {},
  enableThinking = false,
  signal,
  onContent,
}) {
  const body = {
    model,
    messages,
    stream: true,
    chat_template_kwargs: { enable_thinking: !!enableThinking },
  };
  if (tools && tools.length > 0) body.tools = tools;
  if (modelOptions.temperature != null) body.temperature = modelOptions.temperature;
  if (modelOptions.num_predict != null) body.max_tokens = modelOptions.num_predict;

  const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
    body: JSON.stringify(body),
    signal,
  });
  if (!response.ok) {
    throw new Error(await upstreamError(response));
  }

  let content = "";
  const calls = []; // accumulated by delta index

  for await (const data of readSSE(response.body)) {
    if (data === "[DONE]") break;
    let event;
    try {
      event = JSON.parse(data);
    } catch {
      continue;
    }
    if (event.error) {
      throw new Error(event.error.message || String(event.error));
    }
    const delta = event.choices?.[0]?.delta || {};
    if (delta.content) {
      content += delta.content;
      onContent(delta.content);
    }
    for (const tc of delta.tool_calls || []) {
      const i = tc.index ?? calls.length;
      const call = (calls[i] ||= {
        id: "",
        type: "function",
        function: { name: "", arguments: "" },
      });
      if (tc.id) call.id = tc.id;
      if (tc.function?.name) call.function.name += tc.function.name;
      if (tc.function?.arguments) call.function.arguments += tc.function.arguments;
    }
  }

  return { content, toolCalls: calls.filter(Boolean) };
}
